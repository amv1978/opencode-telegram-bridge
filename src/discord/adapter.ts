import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Attachment,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type ThreadChannel,
} from "discord.js";
import type { BridgeConfig } from "../config.ts";
import { log } from "../log.ts";
import type { OcClient, OcEvent, OcSession } from "../opencode/client.ts";
import type { Store } from "../state/store.ts";
import { transcribeAudio } from "../audio/transcribe.ts";
import { registerCommands } from "./commands.ts";
import {
  collectAgentFiles,
  mediaFromPayload,
  promptFilesFromMedia,
  type DiscordMediaTarget,
  type MediaItem,
  type MediaRelay,
  type MediaSendLimits,
} from "../media/relay.ts";
import { DISCORD_CHUNK, chunkText, quoteBlock, italicLine, threadName, titleFromText, formatDuration, formatTokens, toDiscordMarkdown } from "./render.ts";
import { modelLabel, turnStats } from "./stats.ts";
import { DiscordStreamer, resolveSendable } from "./stream.ts";

const EVENT_TYPES = [
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "permission.asked",
  "session.renamed",
  "session.created",
  "session.synthetic",
];

const PERMISSION_TTL_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const AUDIO_EXT = /\.(ogg|opus|mp3|m4a|wav|webm|flac)$/i;

interface PendingPermission {
  sessionID: string;
  requestID: string;
  createdAt: number;
}

interface ThreadParent {
  id: string;
  threads: {
    create(options: { name: string; type: ChannelType.PublicThread; reason?: string }): Promise<ThreadChannel>;
  };
}

export type DiscordState = "stopped" | "starting" | "running" | "error";

export interface DiscordOptions {
  onStateChange?: (state: DiscordState, error: string) => void;
  relay?: MediaRelay;
}

/**
 * Discord transport: one public thread per OpenCode session, slash commands,
 * streamed answers, permission buttons, attachments and voice transcripts.
 */
export class DiscordBridge {
  private client?: Client;
  private streamer?: DiscordStreamer;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly sessionCache = new Map<string, { parentID?: string | null; agent?: string; title?: string }>();
  /** Child session id → parent agent, so `execution.*` updates the parent block. */
  private readonly childSessions = new Map<string, { parentID: string; agent: string }>();
  /** Last agent-files scan per session, so tool.success + turn end don't double-fetch. */
  private readonly agentFilesAt = new Map<string, number>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private eventChain: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;
  private state: DiscordState = "stopped";
  private error = "";
  private username = "";

  constructor(
    private readonly cfg: BridgeConfig,
    private readonly oc: OcClient,
    private readonly store: Store,
    private readonly options: DiscordOptions = {},
  ) {}

  get status(): { state: DiscordState; error: string; username: string } {
    return { state: this.state, error: this.error, username: this.username };
  }

  async start(): Promise<string> {
    const token = this.cfg.discord?.token?.trim();
    if (!token) throw new Error("Не указан токен Discord");
    this.setState("starting", "");

    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    this.client = client;
    this.register(client);
    this.streamer = new DiscordStreamer(client, {
      // Discord rate limits edits per channel; never faster than 2.5 s.
      editIntervalMs: Math.max(2500, this.cfg.stream.editIntervalMs || 2500),
      showTools: this.cfg.stream.showTools,
      onGone: (sessionID) => {
        this.store.clearDiscord(sessionID);
        log.warn(`discord thread for ${sessionID.slice(0, 16)} was deleted; binding cleared`);
      },
    });

    const delays = [5000, 15000, 30000, 60000, 300000];
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      try {
        await withTimeout(client.login(token), 30_000, "login timeout");
        if (!client.isReady()) {
          await withTimeout(
            new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve())),
            30_000,
            "ready timeout",
          );
        }
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error as Error;
        const wait = delays[attempt] ?? 300000;
        log.warn(`discord login attempt ${attempt + 1}/${delays.length} failed: ${lastError.message}; retry in ${Math.round(wait / 1000)}s`);
        await client.destroy().catch(() => undefined);
        if (attempt < delays.length - 1) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    if (lastError) {
      this.setState("error", lastError.message);
      await client.destroy().catch(() => undefined);
      this.client = undefined;
      throw lastError;
    }

    this.username = client.user?.username ?? "";
    const guilds = this.cfg.discord?.allowedGuilds ?? [];
    if (guilds.length === 0) log.warn("discord: allowedGuilds is empty — all events will be ignored");
    if ((this.cfg.discord?.allowedUsers ?? []).length === 0) log.warn("discord: allowedUsers is empty — nobody can drive the bot");
    await registerCommands(client, guilds);

    this.unsubscribe = this.oc.subscribe(
      EVENT_TYPES,
      (event) => {
        // Strictly serial: a mirrored user message must reach Discord before the answer.
        this.eventChain = this.eventChain
          .then(() =>
            Promise.race([
              this.onEvent(event),
              new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                  log.warn("discord event handler timeout");
                  resolve();
                }, 20_000);
                timer.unref?.();
              }),
            ]),
          )
          .catch((error) => log.error("discord event handler:", error));
      },
      (state) => log.info(`discord event stream ${state}`),
    );

    this.setState("running", "");
    log.info(`discord bot @${this.username} started (guilds=${guilds.length})`);
    return this.username;
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.streamer?.shutdown().catch(() => undefined);
    this.streamer = undefined;
    await this.client?.destroy().catch((error) => log.warn("discord stop:", (error as Error).message));
    this.client = undefined;
    this.setState("stopped", "");
    log.info("discord bot stopped");
  }

  /** Media relay sender: uploads bytes into the bound Discord thread/channel. */
  async sendMedia(target: DiscordMediaTarget, item: MediaItem, _limits?: MediaSendLimits): Promise<void> {
    if (!item.buffer?.length || !this.client) return;
    const channel = await resolveSendable(this.client, target.channelId);
    if (!channel) return;
    await channel.send({
      files: [{ attachment: item.buffer, name: item.name }],
      allowedMentions: { parse: [] },
    });
  }

  async sendRelayText(target: DiscordMediaTarget, text: string): Promise<void> {
    await this.send(target.channelId, text);
  }

  /** Relays files the model produced (last assistant message + tool results). */
  private async relayAgentFiles(sessionID: string): Promise<void> {
    if (!this.options.relay) return;
    const now = Date.now();
    const last = this.agentFilesAt.get(sessionID) ?? 0;
    if (now - last < 2500) return;
    this.agentFilesAt.set(sessionID, now);
    const items = await collectAgentFiles(this.oc, sessionID);
    if (items.length) this.options.relay.relay(sessionID, items, "agent");
  }

  // ---------------------------------------------------------------- handlers

  private register(client: Client): void {
    client.on(Events.MessageCreate, (message) => {
      void this.onMessage(message).catch((error) => log.error("discord message:", (error as Error).message));
    });
    client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteraction(interaction).catch((error) => log.error("discord interaction:", (error as Error).message));
    });
    client.on(Events.Error, (error) => log.error("discord client error:", error.message));
    client.on(Events.Warn, (message) => log.warn("discord warning:", message));
    client.on(Events.ShardDisconnect, (event, id) => {
      log.warn(`discord shard ${id} disconnected (${event.code}); scheduling reconnect`);
      this.scheduleReconnect();
    });
    client.on(Events.ShardReconnecting, (id) => log.info(`discord shard ${id} reconnecting…`));
    client.on(Events.ShardResume, (id, replayed) => log.info(`discord shard ${id} resumed (${replayed} replayed)`));
  }

  /** Exponential backoff (5 s → 5 min) without restarting the whole bridge. */
  private scheduleReconnect(): void {
    const token = this.cfg.discord?.token?.trim();
    if (!token || !this.client || this.reconnectTimer || this.client.isReady()) return;
    const delay = Math.min(300000, 5000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    log.warn(`discord gateway down; reconnect attempt ${this.reconnectAttempt} in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect(token);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(token: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (client.isReady()) {
      this.reconnectAttempt = 0;
      return;
    }
    try {
      await client.login(token);
      this.reconnectAttempt = 0;
      log.info("discord reconnected");
    } catch (error) {
      log.warn(`discord reconnect failed: ${(error as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private async onMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot || message.system) return;
    if (!this.allowedGuild(message.guildId)) return;
    if (!this.allowedUser(message.author.id)) return;

    const text = message.content.trim();
    const attachments = [...message.attachments.values()];
    if (!text && attachments.length === 0) return;

    const channel = message.channel;
    const isThread = channel.isThread();
    const channelId = message.channelId;
    let sessionID = isThread ? this.store.byDiscordThread(channelId) : this.store.byDiscordChannel(channelId);
    let destination = channelId;

    if (!sessionID) {
      const title = titleFromText(text || attachments[0]?.name || "");
      const session = await this.createSession(title);
      sessionID = session.id;
      if (isThread) {
        this.store.bindDiscordThread(channelId, sessionID, channel.parentId ?? undefined);
      } else {
        const thread = await this.startThreadForMessage(message, title);
        if (thread) {
          this.store.bindDiscordThread(thread.id, sessionID, channelId);
          destination = thread.id;
          await this.send(thread.id, `🆕 **Сессия создана**\nid: \`${session.id}\`\n📁 \`${session.location?.directory ?? this.cfg.defaultDirectory ?? "?"}\``);
        } else {
          this.store.bindDiscordChannel(channelId, sessionID);
        }
      }
      log.info(`discord: message in ${channelId} → session ${sessionID.slice(0, 16)}`);
    }

    if (await this.isSubagent(sessionID)) {
      await this.send(destination, "⛔️ Этот тред привязан к внутренней сессии субагента — выберите другую: /sessions");
      return;
    }

    const isVoice = attachments.some((attachment) => this.isAudio(attachment));
    const media: MediaItem[] = [];
    let promptText = text;

    for (const attachment of attachments) {
      if (this.isAudio(attachment)) continue;
      if (attachment.size > MAX_FILE_BYTES) {
        await this.send(destination, `⚠️ Файл «${attachment.name}» больше 20 МБ — пропущен.`);
        continue;
      }
      try {
        const buffer = await this.download(attachment);
        const mime = attachment.contentType ?? "application/octet-stream";
        media.push({ buffer, mime, name: attachment.name });
      } catch (error) {
        await this.send(destination, `⚠️ Не смог скачать «${attachment.name}»: ${(error as Error).message.slice(0, 160)}`);
      }
    }
    const files = promptFilesFromMedia(media);

    if (isVoice) {
      const audio = attachments.find((attachment) => this.isAudio(attachment));
      if (audio) {
        if (audio.size > MAX_FILE_BYTES) {
          await this.send(destination, "⚠️ Аудиофайл больше 20 МБ — пропущен.");
          return;
        }
        try {
          const buffer = await this.download(audio);
          const extension = this.audioExtension(audio);
          const result = await transcribeAudio(buffer, extension);
          if (!result.ok) {
            const hint =
              result.reason === "no-hex"
                ? "HEX не найден. Установите HEX или укажите путь в HEX_CLI."
                : result.reason === "disabled"
                  ? "Для голосовых включите распознавание файлов: HEX → Labs → Transcribe files."
                  : result.message.slice(0, 200);
            await this.send(destination, `🎤 Не удалось распознать: ${hint}`);
            return;
          }
          log.info(`discord voice → ${result.text.slice(0, 60)} (${result.elapsedMs} ms)`);
          const seconds = (result.elapsedMs / 1000).toFixed(1);
          const transcript = toDiscordMarkdown(result.text);
          if (transcript !== result.text) {
            // Tables/headings need real fenced blocks, which do not render inside `>` quotes.
            await this.send(destination, `💠 **Расшифровка · голос**\n\n${transcript}\n\n⏱ ${seconds} с`);
          } else {
            await this.send(
              destination,
              quoteBlock("💠 **Расшифровка · голос**", transcript, `⏱ ${seconds} с`),
            );
          }
          promptText = result.text + (promptText ? `\n\n${promptText}` : "");
        } catch (error) {
          await this.send(destination, `🎤 Ошибка обработки аудио: ${(error as Error).message.slice(0, 160)}`);
          return;
        }
      }
    }

    if (!promptText && files.length) promptText = "Посмотри это изображение.";
    if (!promptText) return;
    if (promptText.length > DISCORD_CHUNK * 8) promptText = promptText.slice(0, DISCORD_CHUNK * 8);

    await this.options.relay?.relayBeforeTurn(sessionID, media, "discord");
    await this.streamer?.begin(sessionID, destination, await modelLabel(this.oc, sessionID));
    log.info(`discord prompt → ${sessionID.slice(0, 16)}: ${promptText.slice(0, 80).replace(/\s+/g, " ")}`);
    try {
      await this.oc.prompt(sessionID, promptText, { source: "discord" }, files.length ? files : undefined);
    } catch (error) {
      await this.streamer?.end(sessionID, `⚠️ ${(error as Error).message.slice(0, 200)}`);
    }
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      await this.onButton(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inGuild() || !interaction.guildId) return;
    if (!this.allowedGuild(interaction.guildId)) {
      await interaction.reply({ content: "⛔️ Этот сервер не в списке разрешённых.", ephemeral: true }).catch(() => undefined);
      return;
    }
    if (!this.allowedUser(interaction.user.id)) {
      await interaction
        .reply({ content: "⛔️ Нет доступа. Ваш ID можно добавить в настройках приложения.", ephemeral: true })
        .catch(() => undefined);
      return;
    }

    try {
      await interaction.deferReply();
    } catch (error) {
      if (isExpiredInteraction(error)) log.info(`discord /${interaction.commandName}: interaction expired before defer`);
      else log.warn(`discord /${interaction.commandName}: defer failed: ${(error as Error).message}`);
      return;
    }

    try {
      await this.runCommand(interaction);
    } catch (error) {
      if (isExpiredInteraction(error)) {
        log.info(`discord /${interaction.commandName}: interaction expired, reply skipped`);
        return;
      }
      log.warn(`discord /${interaction.commandName}: ${(error as Error).message}`);
      await interaction.editReply({ content: `⚠️ ${(error as Error).message.slice(0, 300)}` }).catch(() => undefined);
    }
  }

  private async runCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case "help":
        return this.cmdHelp(interaction);
      case "new":
        return this.cmdNew(interaction);
      case "sessions":
        return this.cmdSessions(interaction);
      case "attach":
        return this.cmdAttach(interaction);
      case "detach":
        return this.cmdDetach(interaction);
      case "stop":
        return this.cmdStop(interaction);
      case "status":
        return this.cmdStatus(interaction);
      case "model":
        return this.cmdModel(interaction);
      case "agent":
        return this.cmdAgent(interaction);
      case "fmt":
        return this.cmdFmt(interaction);
      default:
        await interaction.editReply({ content: "Неизвестная команда. /help" });
    }
  }

  private async cmdHelp(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.editReply({
      content: [
        "👋 **OpenCode bridge**",
        "",
        "Пишите в тред — задача уйдёт в сессию OpenCode.",
        "",
        "**Команды**",
        "`/new [title]` — новая сессия и публичный тред",
        "`/sessions` — последние сессии",
        "`/attach <id|prefix>` — подключить существующую",
        "`/detach` — отвязать тред/канал",
        "`/stop` — прервать выполнение",
        "`/status` — состояние сессии",
        "`/model [provider/id]` — модель",
        "`/agent [id]` — агент",
        "`/fmt` — проверка форматирования",
        "",
        "🎤 Голосовые распознаются локально через HEX.",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
  }

  private async cmdNew(interaction: ChatInputCommandInteraction): Promise<void> {
    const title = (interaction.options.getString("title") ?? "").trim() || "Discord session";
    const session = await this.createSession(title);
    const thread = await this.createThread(interaction.channel, title, session.id);
    if (thread) {
      this.store.bindDiscordThread(thread.id, session.id, thread.parentId ?? undefined);
      await this.send(
        thread.id,
        `🆕 **Сессия создана**\nid: \`${session.id}\`\n📁 \`${session.location?.directory ?? this.cfg.defaultDirectory ?? "?"}\`\n\nПишите сюда — задача уйдёт в эту сессию OpenCode.`,
      );
      await interaction.editReply({ content: `🆕 Сессия \`${session.id}\` → тред <#${thread.id}>`, allowedMentions: { parse: [] } });
      return;
    }
    this.store.bindDiscordChannel(interaction.channelId, session.id);
    await interaction.editReply({
      content: `🆕 Сессия \`${session.id}\` привязана к этому каналу (тред создать не удалось).`,
      allowedMentions: { parse: [] },
    });
  }

  private async cmdSessions(interaction: ChatInputCommandInteraction): Promise<void> {
    const sessions = await this.oc.listSessions({ limit: 10 });
    const visible = sessions.filter((session) => !session.parentID);
    if (visible.length === 0) {
      await interaction.editReply({ content: "Сессий нет. /new — создать." });
      return;
    }
    const lines = visible.map((session) => `\`${session.id}\` — ${session.title || "без названия"}`);
    await interaction.editReply({
      content: chunkText(["**Последние сессии**", "", ...lines, "", "Подключить: `/attach <id>`"].join("\n"), DISCORD_CHUNK)[0] ?? "",
      allowedMentions: { parse: [] },
    });
  }

  private async cmdAttach(interaction: ChatInputCommandInteraction): Promise<void> {
    const needle = (interaction.options.getString("session") ?? "").trim();
    const sessions = await this.oc.listSessions({ limit: 50 });
    const found = sessions.find((session) => session.id === needle) ?? sessions.find((session) => session.id.startsWith(needle));
    if (!found) {
      await interaction.editReply({ content: "Не нашёл такую сессию. Список: /sessions" });
      return;
    }

    const channel = interaction.channel;
    if (channel?.isThread()) {
      this.store.bindDiscordThread(channel.id, found.id, channel.parentId ?? undefined);
      this.store.setDiscordTitle(found.id, found.title);
      await channel.setName(threadName(found.title)).catch(() => undefined);
      await interaction.editReply({ content: `🔗 Подключено: **${found.title}**\n\`${found.id}\``, allowedMentions: { parse: [] } });
      return;
    }

    const thread = await this.createThread(channel, found.title, found.id);
    if (thread) {
      this.store.bindDiscordThread(thread.id, found.id, thread.parentId ?? undefined);
      this.store.setDiscordTitle(found.id, found.title);
      await this.send(thread.id, `🔗 **${found.title}**\nid: \`${found.id}\`\n📁 \`${found.location?.directory ?? "?"}\``);
      await interaction.editReply({ content: `🔗 Подключено в треде <#${thread.id}>`, allowedMentions: { parse: [] } });
      return;
    }
    this.store.bindDiscordChannel(interaction.channelId, found.id);
    await interaction.editReply({ content: `🔗 Подключено к каналу: **${found.title}**\n\`${found.id}\``, allowedMentions: { parse: [] } });
  }

  private async cmdDetach(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = interaction.channel;
    if (channel?.isThread()) {
      const sessionID = this.store.byDiscordThread(channel.id);
      this.store.unbindDiscordThread(channel.id);
      if (sessionID) this.store.clearDiscord(sessionID);
      await interaction.editReply({
        content: sessionID
          ? "🔌 Тред отвязан. Сессия осталась в OpenCode; следующее сообщение создаст новую."
          : "Тред и так не был привязан.",
      });
      return;
    }
    const sessionID = this.store.byDiscordChannel(interaction.channelId);
    this.store.unbindDiscordChannel(interaction.channelId);
    if (sessionID) this.store.clearDiscord(sessionID);
    await interaction.editReply({
      content: sessionID
        ? "🔌 Канал отвязан. Сессия осталась в OpenCode; следующее сообщение создаст новую."
        : "Канал и так не был привязан.",
    });
  }

  private async cmdStop(interaction: ChatInputCommandInteraction): Promise<void> {
    const sessionID = this.currentSession(interaction);
    if (!sessionID) {
      await interaction.editReply({ content: "Нет активной сессии." });
      return;
    }
    const result = await this.oc.interrupt(sessionID);
    await interaction.editReply({ content: result.interrupted ? "⏹ Остановлено." : "Нечего останавливать." });
  }

  private async cmdStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    const sessionID = this.currentSession(interaction);
    if (!sessionID) {
      await interaction.editReply({ content: "Нет активной сессии. /new или /attach." });
      return;
    }
    const session = await this.oc.getSession(sessionID);
    const busy = session.time?.busy && !session.time?.idle ? "работает" : "свободна";
    await interaction.editReply({
      content: [
        `**${session.title}**`,
        `id: \`${session.id}\``,
        `📁 \`${session.location?.directory ?? "?"}\``,
        `🤖 ${session.model?.providerID ?? "?"}/${session.model?.id ?? "?"}`,
        `🧩 ${session.agent ?? "?"}`,
        `⏱ ${busy}`,
        `💰 $${(session.cost ?? 0).toFixed(4)}`,
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
  }

  private async cmdModel(interaction: ChatInputCommandInteraction): Promise<void> {
    const sessionID = this.currentSession(interaction);
    if (!sessionID) {
      await interaction.editReply({ content: "Нет активной сессии." });
      return;
    }
    const arg = (interaction.options.getString("model") ?? "").trim();
    if (!arg) {
      const session = await this.oc.getSession(sessionID);
      await interaction.editReply({
        content: `Текущая модель: \`${session.model?.providerID ?? "?"}/${session.model?.id ?? "?"}\``,
        allowedMentions: { parse: [] },
      });
      return;
    }
    const [providerID, id] = arg.split("/");
    if (!providerID || !id) {
      await interaction.editReply({ content: "Формат: `/model providerID/modelID`" });
      return;
    }
    await this.oc.setModel(sessionID, { providerID, id });
    await interaction.editReply({ content: `✅ Модель: \`${arg}\``, allowedMentions: { parse: [] } });
  }

  private async cmdAgent(interaction: ChatInputCommandInteraction): Promise<void> {
    const sessionID = this.currentSession(interaction);
    if (!sessionID) {
      await interaction.editReply({ content: "Нет активной сессии." });
      return;
    }
    const arg = (interaction.options.getString("agent") ?? "").trim();
    if (!arg) {
      const agents = await this.oc.listAgents();
      await interaction.editReply({ content: `Агенты: ${agents.map((agent) => agent.id).join(", ")}` });
      return;
    }
    await this.oc.setAgent(sessionID, arg);
    await interaction.editReply({ content: `✅ Агент: \`${arg}\``, allowedMentions: { parse: [] } });
  }

  private async cmdFmt(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.editReply({
      content: [
        "# Проверка разметки",
        "",
        "Это **жирный**, *курсив*, ~~зачёркнутый~~, `inline code` и [ссылка](https://opencode.ai).",
        "",
        "- пункт списка",
        "- второй пункт",
        "",
        "```ts",
        "const x: number = 42;",
        "console.log(`x=${x}`);",
        "```",
        "",
        "> цитата",
        "",
        "_Discord не поддерживает таблицы — они приходят как обычный текст._",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
  }

  // ------------------------------------------------------------------ events

  private async onEvent(event: OcEvent): Promise<void> {
    if (event.type === "session.created") {
      const data = event.data ?? {};
      const session = data.session as { id?: string } | undefined;
      const id = String(session?.id ?? data.id ?? data.sessionID ?? "");
      if (id) await this.sessionMeta(id);
      return;
    }

    const sessionID = String(event.data?.sessionID ?? "");
    if (!sessionID) return;

    switch (event.type) {
      case "session.inbox.enqueued":
        await this.mirrorUserMessage(sessionID, event.data.item);
        break;
      case "session.execution.started": {
        const meta = await this.sessionMeta(sessionID);
        if (meta.parentID) {
          const agent = meta.agent || "subagent";
          this.childSessions.set(sessionID, { parentID: meta.parentID, agent });
          if (this.cfg.showSubagents !== false && this.streamer?.has(meta.parentID)) {
            this.streamer.subagentStarted(meta.parentID, agent);
            log.info(`discord subagent ${agent} started under ${meta.parentID.slice(0, 16)}`);
          }
          break;
        }
        await this.ensureStream(sessionID);
        this.streamer?.setModel(sessionID, await modelLabel(this.oc, sessionID));
        break;
      }
      case "session.text.started":
        await this.ensureStream(sessionID);
        break;
      case "session.text.delta": {
        if (!this.streamer?.has(sessionID)) await this.ensureStream(sessionID);
        this.streamer?.append(sessionID, String(event.data.delta ?? ""));
        break;
      }
      case "session.text.ended": {
        const text = String(event.data.text ?? "");
        if (text) this.streamer?.setText(sessionID, text);
        break;
      }
      case "session.tool.called": {
        const callID = String(event.data.id ?? event.data.callID ?? "");
        this.streamer?.toolCalled(sessionID, callID, String(event.data.name ?? "tool"), event.data.input);
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const callID = String(event.data.id ?? event.data.callID ?? "");
        this.streamer?.toolFinished(sessionID, callID, event.type === "session.tool.success");
        if (event.type === "session.tool.success") void this.relayAgentFiles(sessionID);
        break;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const child = this.childSessions.get(sessionID);
        if (child) {
          this.childSessions.delete(sessionID);
          if (this.cfg.showSubagents !== false) {
            this.streamer?.subagentFinished(child.parentID, child.agent, event.type === "session.execution.succeeded");
          }
          log.info(`discord subagent ${child.agent} finished ${sessionID.slice(0, 16)}`);
          break;
        }
        if (!this.streamer?.has(sessionID)) break;
        const elapsed = this.streamer.elapsedMs(sessionID);
        const status =
          event.type === "session.execution.interrupted"
            ? "⏹ остановлено"
            : event.type === "session.execution.failed"
              ? "⚠️ ошибка"
              : "";
        const stats = status
          ? { duration: elapsed, tps: undefined, contextTokens: undefined, model: await modelLabel(this.oc, sessionID) }
          : await turnStats(this.oc, sessionID, elapsed);
        // One italic line: model · duration · tok/s · context.
        const parts: string[] = [stats.model || this.streamer.modelOf(sessionID)];
        if (status) parts.push(status);
        if (stats.duration) parts.push(`⏱ ${formatDuration(stats.duration)}`);
        if (stats.tps) parts.push(`⚡ ${stats.tps.toFixed(1)} tok/s`);
        if (stats.contextTokens) parts.push(`🧠 ${formatTokens(stats.contextTokens)}`);
        await this.streamer.end(sessionID, italicLine(parts.join(" · ")) || undefined);
        if (event.type === "session.execution.succeeded") void this.relayAgentFiles(sessionID);
        log.info(`discord turn ${event.type.replace("session.execution.", "")} ${sessionID.slice(0, 16)}`);
        break;
      }
      case "permission.asked":
        await this.askPermission(event);
        break;
      case "session.synthetic":
        await this.subagentReport(sessionID, event.data);
        break;
      case "session.renamed": {
        const title = String(event.data.title ?? "").trim();
        if (!title) break;
        const threadId = this.store.locateDiscord(sessionID).threadId;
        if (!threadId || !this.client) break;
        try {
          const channel = await this.client.channels.fetch(threadId);
          if (channel?.isThread()) await channel.setName(threadName(title));
          this.store.setDiscordTitle(sessionID, title);
          log.info(`discord session renamed → thread: ${title}`);
        } catch (error) {
          log.warn("discord thread rename failed:", (error as Error).message);
        }
        break;
      }
      default:
        break;
    }
  }

  private async ensureStream(sessionID: string): Promise<void> {
    if (this.streamer?.has(sessionID)) return;
    if (await this.isSubagent(sessionID)) return;
    const target = this.targetFor(sessionID);
    if (!target) return;
    await this.streamer?.begin(sessionID, target, await modelLabel(this.oc, sessionID));
    log.info(`discord attached to running session ${sessionID.slice(0, 16)}`);
  }

  private async mirrorUserMessage(sessionID: string, item: unknown): Promise<void> {
    const envelope = item as { type?: string; payload?: { text?: string; metadata?: Record<string, unknown> } };
    if (!envelope || envelope.type !== "user") return;
    if (envelope.payload?.metadata?.source === "discord") return;
    if (await this.isSubagent(sessionID)) return;
    const text = (envelope.payload?.text ?? "").trim();
    if (!text) return;
    const target = this.targetFor(sessionID);
    if (!target) return;
    await this.send(target, quoteBlock("👤 **Вы** · OpenCode", text));
    await this.options.relay?.relayBeforeTurn(sessionID, mediaFromPayload(envelope), "agent");
    log.info(`discord mirror user → ${sessionID.slice(0, 16)}`);
  }

  private async askPermission(event: OcEvent): Promise<void> {
    const sessionID = String(event.data.sessionID);
    const requestID = String(event.data.id);
    const target = this.targetFor(sessionID);
    if (!target) {
      log.warn("discord permission for unknown session", sessionID);
      return;
    }
    const key = Math.random().toString(36).slice(2, 8);
    this.pending.set(key, { sessionID, requestID, createdAt: Date.now() });

    const action = String(event.data.action ?? "?");
    const resources = Array.isArray(event.data.resources) ? event.data.resources.join(", ") : "";
    const message = event.data.message ? `\n\n_${String(event.data.message)}_` : "";
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:${key}:once`).setLabel("✅ Разрешить").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:${key}:always`).setLabel("♾ Всегда").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`perm:${key}:reject`).setLabel("⛔️ Отклонить").setStyle(ButtonStyle.Danger),
    );
    await this.sendWithComponents(
      target,
      `🔐 **Требуется разрешение**\n**${action}**: \`${resources}\`${message}\n\n_Запрос действует 15 минут._`,
      [row],
    );
  }

  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const data = interaction.customId;
    if (!data.startsWith("perm:")) return;
    if (interaction.guildId && !this.allowedGuild(interaction.guildId)) return;
    if (!this.allowedUser(interaction.user.id)) {
      await interaction.reply({ content: "⛔️ Нет доступа.", ephemeral: true }).catch(() => undefined);
      return;
    }

    const [, key, decision] = data.split(":");
    const pending = key ? this.pending.get(key) : undefined;
    if (!pending || !decision) {
      await interaction.update({ content: "⌛️ Запрос устарел.", components: [] }).catch(() => undefined);
      return;
    }
    if (Date.now() - pending.createdAt > PERMISSION_TTL_MS) {
      this.pending.delete(key!);
      await interaction.update({ content: "⌛️ Запрос истёк.", components: [] }).catch(() => undefined);
      return;
    }

    try {
      await this.oc.replyPermission(pending.sessionID, pending.requestID, decision as "once" | "always" | "reject");
      this.pending.delete(key!);
      const label = decision === "reject" ? "⛔️ Отклонено" : decision === "always" ? "♾ Разрешено всегда" : "✅ Разрешено";
      await interaction.update({ content: label, components: [] });
    } catch (error) {
      await interaction
        .update({ content: `⚠️ ${(error as Error).message.slice(0, 200)}`, components: [] })
        .catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ helpers

  private async createSession(title: string): Promise<OcSession> {
    return this.oc.createSession({ title, directory: this.cfg.defaultDirectory });
  }

  private async createThread(channel: unknown, title: string, sessionID: string): Promise<ThreadChannel | undefined> {
    const parent = threadParent(channel);
    if (!parent) return undefined;
    try {
      return await parent.threads.create({
        name: threadName(title),
        type: ChannelType.PublicThread,
        reason: `OpenCode session ${sessionID}`,
      });
    } catch (error) {
      log.warn("discord thread creation failed:", (error as Error).message);
      return undefined;
    }
  }

  private async startThreadForMessage(message: Message, title: string): Promise<ThreadChannel | undefined> {
    try {
      const candidate = message as unknown as { startThread?: (options: { name: string }) => Promise<ThreadChannel> };
      if (typeof candidate.startThread !== "function") return undefined;
      return await candidate.startThread({ name: threadName(title) });
    } catch (error) {
      log.warn("discord message thread failed:", (error as Error).message);
      return undefined;
    }
  }

  private currentSession(interaction: ChatInputCommandInteraction): string | undefined {
    const channel = interaction.channel;
    if (channel?.isThread()) return this.store.byDiscordThread(channel.id);
    return this.store.byDiscordChannel(interaction.channelId);
  }

  private targetFor(sessionID: string): string | undefined {
    const location = this.store.locateDiscord(sessionID);
    return location.threadId ?? location.chatId;
  }

  private allowedGuild(guildId: string | null | undefined): boolean {
    if (!guildId) return false;
    return (this.cfg.discord?.allowedGuilds ?? []).includes(guildId);
  }

  private allowedUser(userId: string): boolean {
    return (this.cfg.discord?.allowedUsers ?? []).includes(userId);
  }

  private async sessionMeta(sessionID: string): Promise<{ parentID?: string | null; agent?: string; title?: string }> {
    const cached = this.sessionCache.get(sessionID);
    if (cached) return cached;
    try {
      const session = await this.oc.getSession(sessionID);
      const meta = { parentID: session.parentID, agent: session.agent, title: session.title };
      this.sessionCache.set(sessionID, meta);
      return meta;
    } catch {
      return {};
    }
  }

  /**
   * `session.synthetic` on the parent: child's `<subagent>` report as a muted
   * quote `> 🧩 <agent>: …` (first ~300 chars) unless `showSubagents` is off.
   */
  private async subagentReport(sessionID: string, data: Record<string, unknown>): Promise<void> {
    if (this.cfg.showSubagents === false) return;
    const raw = syntheticText(data);
    if (!raw) return;
    const cleaned = raw
      .replace(/<\/?subagent[^>]*>/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return;
    const own = await this.sessionMeta(sessionID);
    const parentID = own.parentID ?? sessionID;
    const childID = /<subagent[^>]*sessionID="([^"]+)"/i.exec(raw)?.[1];
    let agent = typeof data.agent === "string" ? data.agent.trim() : "";
    if (!agent && own.parentID) agent = own.agent ?? "";
    if (!agent && childID) agent = (await this.sessionMeta(childID)).agent ?? "";
    if (!agent) agent = "subagent";
    const target = this.targetFor(parentID);
    if (!target) return;
    const text = cleaned.length > 300 ? `${cleaned.slice(0, 299)}…` : cleaned;
    await this.send(target, `> 🧩 ${agent}: ${text}`);
    log.info(`discord subagent report ${agent} → ${parentID.slice(0, 16)}`);
  }

  private async isSubagent(sessionID: string): Promise<boolean> {
    return Boolean((await this.sessionMeta(sessionID)).parentID);
  }

  private isAudio(attachment: Attachment): boolean {
    if ((attachment.contentType ?? "").toLowerCase().startsWith("audio/")) return true;
    return AUDIO_EXT.test(attachment.name ?? "");
  }

  private audioExtension(attachment: Attachment): string {
    const fromName = /\.([a-z0-9]+)$/i.exec(attachment.name ?? "")?.[1];
    if (fromName) return fromName.toLowerCase();
    const fromMime = (attachment.contentType ?? "").split("/")[1]?.split(";")[0];
    return (fromMime || "ogg").toLowerCase();
  }

  private async download(attachment: Attachment): Promise<Buffer> {
    if (attachment.size > MAX_FILE_BYTES) throw new Error("файл больше 20 МБ");
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`download HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async send(channelId: string, content: string): Promise<void> {
    try {
      const channel = this.client ? await resolveSendable(this.client, channelId) : undefined;
      if (!channel) return;
      for (const chunk of chunkText(content, DISCORD_CHUNK)) {
        if (chunk.trim()) await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      }
    } catch (error) {
      log.warn(`discord send to ${channelId} failed: ${(error as Error).message}`);
    }
  }

  private async sendWithComponents(
    channelId: string,
    content: string,
    components: ActionRowBuilder<ButtonBuilder>[],
  ): Promise<void> {
    const channel = this.client ? await resolveSendable(this.client, channelId) : undefined;
    if (!channel) return;
    await channel.send({ content, components, allowedMentions: { parse: [] } });
  }

  private setState(state: DiscordState, error: string): void {
    this.state = state;
    this.error = error;
    this.options.onStateChange?.(state, error);
  }
}

/** The channel a public thread should be created in (the thread's parent if needed). */
function threadParent(channel: unknown): ThreadParent | undefined {
  if (!channel) return undefined;
  const value = channel as { isThread?: () => boolean; parent?: unknown; id?: string; type?: ChannelType; threads?: unknown };
  const candidate = typeof value.isThread === "function" && value.isThread() ? value.parent : channel;
  if (!candidate) return undefined;
  const parent = candidate as { id?: string; type?: ChannelType; threads?: unknown };
  if (!parent.id || !parent.threads) return undefined;
  if (parent.type !== ChannelType.GuildText && parent.type !== ChannelType.GuildAnnouncement) return undefined;
  return candidate as unknown as ThreadParent;
}

/** Rejects when a gateway promise hangs; prevents an endless "starting" state. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Discord interaction is unknown/expired (3 s ack window missed) or already acked. */function isExpiredInteraction(error: unknown): boolean {
  const value = error as { code?: number; message?: string };
  if (value?.code === 10062 || value?.code === 40060) return true;
  return /unknown interaction|already acknowledged|interaction (has )?expired/i.test(value?.message ?? "");
}

/** Text of a `session.synthetic` event; the payload shape has varied across builds. */function syntheticText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const source = data as Record<string, any>;
  const item = source.item as Record<string, any> | undefined;
  const candidates = [
    source.text,
    item?.text,
    item?.payload?.text,
    item?.preview,
    source.preview,
    source.message,
    source.report?.text,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}
