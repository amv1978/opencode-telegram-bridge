import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { BridgeConfig, UserConfig } from "../config.ts";
import { findUser, isAdmin } from "../config.ts";
import { log } from "../log.ts";
import type { OcClient, OcEvent, OcSession } from "../opencode/client.ts";
import { catalogFor, resolveModelLabel, sanitizeModelName, UNKNOWN_MODEL } from "../model.ts";
import type { Store } from "../state/store.ts";
import { entitiesToMarkdown } from "./entities.ts";
import { Streamer, type Target } from "./stream.ts";
import { enableHexFileTranscription, transcribeAudio } from "../audio/transcribe.ts";
import {
  collectAgentFiles,
  mediaFromPayload,
  promptFilesFromMedia,
  type MediaItem,
  type MediaRelay,
  type MediaSendLimits,
  type TelegramMediaTarget,
} from "../media/relay.ts";
import pkg from "../../package.json";

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
  "session.model.selected",
  "session.synthetic",
];

const PERMISSION_TTL_MS = 15 * 60 * 1000;
/** A prompt with no `execution.started` for this long is reported by the doctor. */
const ADMITTED_TIMEOUT_MS = 30_000;

interface PendingPermission {
  sessionID: string;
  requestID: string;
  createdAt: number;
}

export class Bridge {
  private readonly bot: Bot;
  private readonly streamer: Streamer;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly sessionCache = new Map<string, { parentID?: string | null; agent?: string; title?: string }>();
  /** Child session id → parent binding, so `execution.*` updates the parent block. */
  private readonly childSessions = new Map<string, { parentID: string; agent: string }>();
  /** Prompts the API accepted but OpenCode has not started yet (doctor). */
  private readonly admitted = new Map<string, { at: number; target?: Target; warned: boolean }>();
  private doctorTimer?: ReturnType<typeof setInterval>;
  private readonly recentMirrors = new Map<string, { text: string; at: number }[]>();
  private readonly appliedTitles = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;
  /** Last agent-files scan per session, so tool.success + turn end don't double-fetch. */
  private readonly agentFilesAt = new Map<string, number>();
  private eventChain: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly cfg: BridgeConfig,
    private readonly oc: OcClient,
    private readonly store: Store,
    private readonly options: {
      fetch?: typeof fetch;
      relay?: MediaRelay;
      onConfigChange?: () => void;
      onPollingError?: (message: string) => void;
    } = {},
  ) {
    this.bot = new Bot(cfg.telegram.token, options.fetch ? { client: { fetch: options.fetch } } : {});
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.streamer = new Streamer(this.bot.api, {
      editIntervalMs: cfg.stream.editIntervalMs,
      showTools: cfg.stream.showTools,
      format: cfg.stream.format ?? "rich",
      onThreadGone: (sessionID) => {
        this.store.clearThread(sessionID);
        log.warn(`topic for ${sessionID.slice(0, 16)} was deleted; binding cleared`);
      },
    });
    this.register();
  }

  async start(): Promise<string> {
    await this.bot.init();
    const username = this.bot.botInfo.username;
    log.info(`bot @${username} started (mode=${this.cfg.mode})`);
    this.unsubscribe = this.oc.subscribe(
      EVENT_TYPES,
      (event) => {
        // Strictly serial: a mirrored user message must reach Telegram before the answer.
        this.eventChain = this.eventChain
          .then(() =>
            Promise.race([
              this.onEvent(event),
              new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                  log.warn("event handler timeout");
                  resolve();
                }, 20_000);
                timer.unref?.();
              }),
            ]),
          )
          .catch((error) => log.error("event handler:", error));
      },
      (state) => log.info(`event stream ${state}`),
    );
    void this.bot
      .start({ allowed_updates: ["message", "callback_query"], drop_pending_updates: false })
      .catch((error) => {
        const message = (error as Error).message;
        log.error("bot polling stopped:", message);
        this.options.onPollingError?.(message);
      });
    // Doctor: a prompt admitted by OpenCode with no `execution.started` for 30 s
    // usually means a stuck/busy session. Log it once and show a UI hint.
    this.doctorTimer = setInterval(() => this.checkAdmitted(), 5_000);
    this.doctorTimer.unref?.();
    return username;
  }

  async stop(): Promise<void> {
    if (this.doctorTimer) clearInterval(this.doctorTimer);
    this.doctorTimer = undefined;
    this.unsubscribe?.();
    await this.streamer.shutdown();
    await this.bot.stop();
  }

  /** Current doctor warnings for the web panel. */
  warnings(): string[] {
    const now = Date.now();
    return [...this.admitted.entries()]
      .filter(([, entry]) => now - entry.at >= ADMITTED_TIMEOUT_MS)
      .map(([sessionID, entry]) => {
        const seconds = Math.round((now - entry.at) / 1000);
        return `${sessionID.slice(0, 16)}…: prompt accepted ${seconds}s ago, no execution.started — send /stop and retry`;
      });
  }

  private checkAdmitted(): void {
    const now = Date.now();
    for (const [sessionID, entry] of this.admitted) {
      if (now - entry.at < ADMITTED_TIMEOUT_MS || entry.warned) continue;
      entry.warned = true;
      const seconds = Math.round((now - entry.at) / 1000);
      log.warn(
        `doctor: prompt admitted ${seconds}s ago in ${sessionID.slice(0, 16)} but no session.execution.started — session is busy/stuck; /stop to interrupt`,
      );
      if (!entry.target) continue;
      const options = entry.target.threadId ? { message_thread_id: entry.target.threadId } : {};
      void this.bot.api
        .sendMessage(
          entry.target.chatId,
          `⚠️ OpenCode принял задачу, но выполнение не началось ${seconds} с.\n` +
            "Сессия, похоже, занята зависшей задачей. Отправьте /stop, чтобы прервать её, и повторите запрос.",
          options,
        )
        .catch(() => undefined);
    }
  }

  /** Media relay sender: uploads bytes to the bound Telegram chat/topic. */
  async sendMedia(target: TelegramMediaTarget, item: MediaItem, limits: MediaSendLimits): Promise<void> {
    if (!item.buffer?.length) return;
    const options = target.threadId ? { message_thread_id: target.threadId } : {};
    const photo =
      Boolean(item.mime?.startsWith("image/")) &&
      !/gif/i.test(item.mime ?? "") &&
      item.buffer.length <= Math.max(1, limits.maxPhotoMb) * 1024 * 1024;
    const file = new InputFile(item.buffer, item.name);
    if (photo) await this.bot.api.sendPhoto(target.chatId, file, options);
    else await this.bot.api.sendDocument(target.chatId, file, options);
  }

  async sendRelayText(target: TelegramMediaTarget, text: string): Promise<void> {
    const options = target.threadId ? { message_thread_id: target.threadId } : {};
    await this.bot.api.sendMessage(target.chatId, text, options);
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

  private register(): void {
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || ctx.from?.is_bot) return;

      // Groups are opt-in: only the configured forum group is served.
      // Exception: an admin may bind a new forum group with /chatid.
      const chat = ctx.chat;
      if (chat?.type === "group" || chat?.type === "supergroup") {
        const text = (ctx.message?.text ?? "").trim();
        const isBind = /^\/chatid(@\w+)?$/i.test(text);
        if (chat.id !== this.cfg.topicsChatId && !(isBind && isAdmin(this.cfg, userId))) {
          log.debug(`ignored message in group ${chat.id}`);
          return;
        }
      }

      if (!findUser(this.cfg, userId)) {
        // Zero-config onboarding: the first private user becomes admin.
        if (this.cfg.telegram.allowedUsers.length === 0 && ctx.chat?.type === "private") {
          this.cfg.telegram.allowedUsers.push({
            id: userId,
            role: "admin",
            name: ctx.from?.first_name,
          });
          this.options.onConfigChange?.();
          log.info(`paired admin: ${userId} (@${ctx.from?.username ?? "?"})`);
          await ctx.reply(
            "✅ Вы подключены как <b>администратор</b>.\n\n" +
              "Пишите задачу — она уйдёт в OpenCode. /help — команды.",
            { parse_mode: "HTML" },
          );
          return next();
        }
        if (ctx.chat?.type === "private") {
          await ctx.reply("⛔️ Нет доступа. Ваш ID можно добавить в настройках приложения.");
        }
        return;
      }
      if (ctx.message) {
        const thread = (ctx.message as { message_thread_id?: number }).message_thread_id;
        const text = ctx.message.text ?? "";
        log.info(
          `msg chat=${chat?.id ?? "?"} thread=${thread ?? "-"} from=${userId} @${ctx.from?.username ?? "?"}: ${text.slice(0, 60).replace(/\s+/g, " ")}`,
        );
      }
      await next();
    });

    this.bot.command("start", (ctx) => this.cmdStart(ctx));
    this.bot.command("help", (ctx) => this.cmdStart(ctx));
    this.bot.command("new", (ctx) => this.cmdNew(ctx));
    this.bot.command("sessions", (ctx) => this.cmdSessions(ctx));
    this.bot.command("session", (ctx) => this.cmdSessions(ctx));
    this.bot.command("attach", (ctx) => this.cmdAttach(ctx));
    this.bot.command("topic", (ctx) => this.cmdTopic(ctx));
    this.bot.command("stop", (ctx) => this.cmdStop(ctx));
    this.bot.command("status", (ctx) => this.cmdStatus(ctx));
    this.bot.command("model", (ctx) => this.cmdModel(ctx));
    this.bot.command("agent", (ctx) => this.cmdAgent(ctx));
    this.bot.command("chatid", (ctx) => this.cmdChatId(ctx));
    this.bot.command("fmt", (ctx) => this.cmdFmt(ctx));
    this.bot.command("detach", (ctx) => this.cmdDetach(ctx));

    this.bot.on("message:text", (ctx) => this.onText(ctx));
    this.bot.on(["message:photo", "message:document", "message:voice", "message:audio"], (ctx) => this.onMedia(ctx));
    this.bot.on("message:forum_topic_created", (ctx) => this.onTopicCreated(ctx));
    this.bot.on("message:forum_topic_edited", (ctx) => this.onTopicRenamed(ctx));
    this.bot.on("message", (ctx) => this.onNonText(ctx));
    this.bot.on("callback_query:data", (ctx) => this.onCallback(ctx));

    this.bot.catch((error) => log.error("bot error:", error.message));
  }

  private async cmdStart(ctx: Context): Promise<void> {
    const user = ctx.from ? findUser(this.cfg, ctx.from.id) : undefined;
    await ctx.reply(
      [
        "👋 <b>OpenCode bridge</b>",
        "",
        "Пишите задачу — уйдёт в текущую сессию OpenCode.",
        "",
        "<b>Команды</b>",
        "/new [папка] — новая сессия",
        "/sessions — список сессий",
        "/attach &lt;id&gt; — подключить существующую",
        "/topic &lt;название&gt; — новая тема-сессия (форум)",
        "/chatid — ID этого чата (и включить форум)",
        "/detach — отвязать чат/тему от сессии",
        "",
        "🎤 Голосовые распознаются локально через HEX.",
        "/fmt — проверить форматирование",
        "/stop — прервать выполнение",
        "/status — состояние сессии",
        "/model [provider/id] — модель",
        "/agent [id] — агент",
        "",
        `Ваша роль: <b>${user?.role ?? "user"}</b>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  }

  private async cmdNew(ctx: Context): Promise<void> {
    const directory = argText(ctx) || this.cfg.defaultDirectory;
    const session = await this.oc.createSession({ title: "Telegram session", directory });
    await this.bind(ctx, session);
    await ctx.reply(`🆕 Сессия <code>${session.id}</code>\n📁 <code>${escape(session.location?.directory ?? "?")}</code>`, {
      parse_mode: "HTML",
    });
  }

  private async cmdSessions(ctx: Context): Promise<void> {
    const search = argText(ctx);
    const sessions = await this.oc.listSessions({ limit: 10, search: search || undefined });
    const visible = sessions.filter((session) => !session.parentID);
    if (visible.length === 0) {
      await ctx.reply("Сессий нет. /new — создать.");
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const session of visible) {
      keyboard.text(label(session), `sess:${session.id}`).row();
    }
    await ctx.reply("Выберите сессию:" + (ctx.chat && (ctx.chat as { is_forum?: boolean }).is_forum ? "\n<i>В форуме открою отдельную тему.</i>" : ""), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }

  private async cmdAttach(ctx: Context): Promise<void> {
    const needle = argText(ctx);
    if (!needle) {
      await ctx.reply("Использование: /attach &lt;sessionID или префикс&gt;\nСписок: /sessions", { parse_mode: "HTML" });
      return;
    }
    const sessions = await this.oc.listSessions({ limit: 50 });
    const found = sessions.find((s) => s.id === needle) ?? sessions.find((s) => s.id.startsWith(needle));
    if (!found) {
      await ctx.reply("Не нашёл такую сессию.");
      return;
    }
    await this.bind(ctx, found);
    await ctx.reply(`🔗 Подключено: <b>${escape(found.title)}</b>\n<code>${found.id}</code>`, { parse_mode: "HTML" });
  }

  private async cmdTopic(ctx: Context): Promise<void> {
    if (!this.cfg.topicsChatId) {
      await ctx.reply("Топики не настроены: укажите topicsChatId в config.json.");
      return;
    }
    const title = argText(ctx) || "OpenCode";
    const topic = await this.bot.api.createForumTopic(this.cfg.topicsChatId, title);
    const session = await this.oc.createSession({ title, directory: this.cfg.defaultDirectory });
    this.store.bindThread(topic.message_thread_id, session.id);
    this.store.upsert({ id: session.id, title: session.title, chatId: this.cfg.topicsChatId, threadId: topic.message_thread_id });
    await this.bot.api.sendMessage(this.cfg.topicsChatId, `🆕 Сессия <code>${session.id}</code>`, {
      parse_mode: "HTML",
      message_thread_id: topic.message_thread_id,
    });
  }

  private async cmdChatId(ctx: Context): Promise<void> {
    const chat = ctx.chat;
    if (!chat) return;
    const isForum = (chat as { is_forum?: boolean }).is_forum === true;
    const lines = [`chat_id: <code>${chat.id}</code>`, `тип: <code>${chat.type}</code>`, `форум: ${isForum ? "да" : "нет"}`];
    if (!isForum && (chat.type === "group" || chat.type === "supergroup")) {
      lines.push("", "⚠️ В группе не включены темы. Включите: название группы → Изменить → Темы.");
    }
    if (isForum && ctx.from && isAdmin(this.cfg, ctx.from.id) && this.cfg.topicsChatId !== chat.id) {
      this.cfg.topicsChatId = chat.id;
      if (this.cfg.mode === "private") this.cfg.mode = "both";
      this.options.onConfigChange?.();
      lines.push("✅ Группа сохранена как форум для сессий. Можно писать в любой топик.");
      log.info(`topicsChatId set to ${chat.id}`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }

  private async cmdFmt(ctx: Context): Promise<void> {
    const markdown = [
      "# Проверка разметки",
      "",
      "Это **жирный**, *курсив*, ~~зачёркнутый~~, `inline code` и [ссылка](https://opencode.ai).",
      "",
      "| Параметр | Значение |",
      "|---|---|",
      "| Модель | deepseek-v4.1 |",
      "| Формат | Rich Message |",
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
    ].join("\n");

    try {
      await this.bot.api.sendRichMessage(ctx.chat!.id, { markdown }, {
        ...(ctx.message && "message_thread_id" in ctx.message && ctx.message.message_thread_id
          ? { message_thread_id: ctx.message.message_thread_id }
          : {}),
      });
    } catch (error) {
      log.warn("rich /fmt failed, falling back to HTML:", (error as Error).message);
      await ctx.reply(`⚠️ Rich Message недоступен: ${(error as Error).message.slice(0, 120)}`);
    }
  }

  private async cmdStop(ctx: Context): Promise<void> {
    const sessionID = await this.currentSession(ctx, false);
    if (!sessionID) {
      await ctx.reply("Нет активной сессии.");
      return;
    }
    const result = await this.oc.interrupt(sessionID);
    this.admitted.delete(sessionID);
    await ctx.reply(result.interrupted ? "⏹ Остановлено." : "Нечего останавливать.");
  }

  private async cmdStatus(ctx: Context): Promise<void> {
    const sessionID = await this.currentSession(ctx, false);
    if (!sessionID) {
      await ctx.reply("Нет активной сессии. /new или /attach.");
      return;
    }
    const session = await this.oc.getSession(sessionID);
    const busy = Number(session.time?.busy ?? 0) > Number(session.time?.idle ?? 0) ? "работает" : "свободна";
    await ctx.reply(
      [
        `<b>${escape(session.title)}</b>`,
        `id: <code>${session.id}</code>`,
        `📁 <code>${escape(session.location?.directory ?? "?")}</code>`,
        `🤖 ${escape(await this.modelLabel(sessionID))}`,
        `🧩 ${escape(session.agent ?? "?")}`,
        `⏱ ${busy}`,
        `💰 $${(session.cost ?? 0).toFixed(4)}`,
        `🏷 ${escape(pkg.version)}`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  }

  private async cmdModel(ctx: Context): Promise<void> {
    const sessionID = await this.currentSession(ctx, false);
    if (!sessionID) {
      await ctx.reply("Нет активной сессии.");
      return;
    }
    const arg = argText(ctx);
    if (!arg) {
      const session = await this.oc.getSession(sessionID);
      await ctx.reply(`Текущая модель: <code>${session.model?.providerID}/${session.model?.id}</code>`, { parse_mode: "HTML" });
      return;
    }
    const [providerID, id] = arg.split("/");
    if (!providerID || !id) {
      await ctx.reply("Формат: /model providerID/modelID");
      return;
    }
    await this.oc.setModel(sessionID, { providerID, id });
    await ctx.reply(`✅ Модель: <code>${escape(arg)}</code>`, { parse_mode: "HTML" });
  }

  private async cmdAgent(ctx: Context): Promise<void> {
    const sessionID = await this.currentSession(ctx, false);
    if (!sessionID) {
      await ctx.reply("Нет активной сессии.");
      return;
    }
    const arg = argText(ctx);
    if (!arg) {
      const agents = await this.oc.listAgents();
      await ctx.reply("Агенты: " + agents.map((a) => a.id).join(", "));
      return;
    }
    await this.oc.setAgent(sessionID, arg);
    await ctx.reply(`✅ Агент: <code>${escape(arg)}</code>`, { parse_mode: "HTML" });
  }

  private async cmdDetach(ctx: Context): Promise<void> {
    const threadId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
    const chatId = ctx.chat?.id;
    if (threadId) {
      const sessionID = this.store.byThread(threadId);
      this.store.unbindThread(threadId);
      if (sessionID) this.store.clearThread(sessionID);
      await ctx.reply(
        sessionID
          ? "🔌 Тема отвязана от сессии. Сессия осталась в OpenCode; следующее сообщение здесь создаст новую."
          : "Тема и так не была привязана.",
      );
      return;
    }
    if (chatId) {
      const sessionID = this.store.byChat(chatId);
      this.store.unbindChat(chatId);
      await ctx.reply(
        sessionID
          ? "🔌 Чат отвязан от сессии. Сессия осталась в OpenCode; следующее сообщение создаст новую."
          : "Чат и так не был привязан.",
      );
    }
  }

  private async onText(ctx: Context & { message: { text: string; message_thread_id?: number } }): Promise<void> {
    const text = entitiesToMarkdown(ctx.message.text, (ctx.message as { entities?: any[] }).entities ?? []).trim();
    if (!text || text.startsWith("/")) return;
    if (this.isEcho(ctx.chat?.id, text)) {
      log.warn("ignored echo of a bridge-posted message");
      return;
    }
    await this.submitTask(ctx, text);
  }

  private async submitTask(
    ctx: Context,
    text: string,
    files?: Array<{ uri: string; name?: string }>,
    media: MediaItem[] = [],
  ): Promise<void> {
    // Single conversion point: prompt attachments are always { uri, name }.
    if (media.length) files = promptFilesFromMedia(media);
    log.info(`task: ${text.slice(0, 80).replace(/\s+/g, " ")}${files ? ` [+${files.length} file]` : ""}`);    const threadId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
    const chatId = ctx.chat?.id;
    const messageID = ctx.message?.message_id ? String(ctx.message.message_id) : undefined;

    // In the bound forum, a task in the general chat starts its own topic.
    if (chatId && chatId === this.cfg.topicsChatId && !threadId && this.cfg.autoTopics !== false) {
      let topicID: number | undefined;
      let sessionID: string | undefined;
      try {
        const title = text.replace(/\s+/g, " ").slice(0, 48) || "Изображение";
        const topic = await this.bot.api.createForumTopic(chatId, title);
        topicID = topic.message_thread_id;
        const session = await this.oc.createSession({ title, directory: this.cfg.defaultDirectory });
        sessionID = session.id;
        this.store.bindThread(topicID, session.id);
        this.store.upsert({ id: session.id, title: session.title, chatId, threadId: topicID });
      } catch (error) {
        // Only topic/session creation may fall back to the chat session; a failed
        // prompt inside an already-created topic must not create a duplicate.
        log.warn("auto-topic failed, falling back to chat session:", (error as Error).message);
      }
      if (topicID && sessionID) {
        const target = { chatId, threadId: topicID };
        await this.options.relay?.relayBeforeTurn(sessionID, media, "telegram", messageID, {
          platform: "telegram",
          chatId,
          threadId: topicID,
        });
        await this.streamer.begin(sessionID, target, await this.modelLabel(sessionID));
        log.info(`prompt → ${sessionID.slice(0, 16)}: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
        try {
          await this.oc.prompt(sessionID, text, { source: "telegram" }, files);
          this.markAdmitted(sessionID, target);
        } catch (error) {
          await this.failPrompt(sessionID, target, error);
        }
        log.info(`auto-topic ${topicID} → ${sessionID.slice(0, 16)}`);
        return;
      }
    }

    const sessionID = await this.currentSession(ctx, true);
    if (!sessionID) {
      await ctx.reply("Не удалось создать сессию.");
      return;
    }
    if (await this.isSubagent(sessionID)) {
      await ctx.reply("Эта тема привязана к внутренней сессии субагента — писать в неё нельзя. Выберите другую: /sessions");
      return;
    }
    const target = this.targetFor(sessionID, ctx);
    if (!target) {
      await ctx.reply("Не понимаю, куда отвечать. Настройте topicsChatId или пишите боту в личку.");
      return;
    }
    await this.options.relay?.relayBeforeTurn(sessionID, media, "telegram", messageID, {
      platform: "telegram",
      chatId: target.chatId,
      threadId: target.threadId,
    });
    await this.streamer.begin(sessionID, target, await this.modelLabel(sessionID));
    log.info(`prompt → ${sessionID.slice(0, 16)}: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
    try {
      await this.oc.prompt(sessionID, text, { source: "telegram" }, files);
      this.markAdmitted(sessionID, target);
    } catch (error) {
      await this.failPrompt(sessionID, target, error);
    }
  }

  /** Remembers an accepted prompt so the doctor can detect a stalled start. */
  private markAdmitted(sessionID: string, target: Target): void {
    this.admitted.set(sessionID, { at: Date.now(), target, warned: false });
  }

  /**
   * A prompt the API refused (typically 409 busy / 400 bad request) used to
   * leave the "thinking…" placeholder forever. Log it and turn the placeholder
   * into an actionable error instead.
   */
  private async failPrompt(sessionID: string, target: Target, error: unknown): Promise<void> {
    const message = (error as Error)?.message ?? String(error);
    this.admitted.delete(sessionID);
    const busy = /\b(409|busy|conflict)\b/i.test(message);
    log.error(
      `prompt failed ${sessionID.slice(0, 16)} target=${target.threadId ?? "dm"}: ` +
        `${message.slice(0, 300)}${busy ? " (session busy — /stop interrupts it)" : ""}`,
    );
    const hint = busy
      ? "Сессия занята другой задачей. Отправьте /stop, чтобы прервать её, и повторите запрос."
      : "Сессия не приняла запрос. Проверьте /status и повторите; если не помогает — /stop.";
    await this.streamer.end(sessionID, `⚠️ ${hint}\n\n\`${message.slice(0, 200)}\``);
  }

  private async onTopicCreated(ctx: Context): Promise<void> {
    const message = ctx.message as
      | { message_thread_id?: number; forum_topic_created?: { name?: string } }
      | undefined;
    const threadId = message?.message_thread_id;
    if (!threadId) return;
    // The topic already owns a session (e.g. created by /topic): nothing to do.
    if (this.store.byThread(threadId)) return;
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const name = message?.forum_topic_created?.name?.trim() || "Тема";
    try {
      const session = await this.oc.createSession({ title: name, directory: this.cfg.defaultDirectory });
      this.store.bindThread(threadId, session.id);
      this.store.upsert({ id: session.id, title: session.title, chatId, threadId });
      const markdown = `> 🆕 Сессия создана\n>\n> ${name}`;
      try {
        await this.bot.api.sendRichMessage(chatId, { markdown }, { message_thread_id: threadId });
      } catch (error) {
        log.warn("rich topic greeting failed:", (error as Error).message);
        await this.bot.api
          .sendMessage(chatId, `🆕 Сессия создана\n\n${name}`, { message_thread_id: threadId })
          .catch(() => undefined);
      }
      log.info(`topic ${threadId} → new session ${session.id.slice(0, 16)}`);
    } catch (error) {
      log.warn("topic session creation failed:", (error as Error).message);
    }
  }

  private async onTopicRenamed(ctx: Context): Promise<void> {
    const message = ctx.message as
      | { message_thread_id?: number; forum_topic_edited?: { name?: string } }
      | undefined;
    const threadId = message?.message_thread_id;
    const name = message?.forum_topic_edited?.name?.trim();
    if (!threadId || !name) return;
    const sessionID = this.store.byThread(threadId);
    if (!sessionID) return;
    const session = await this.oc.getSession(sessionID).catch(() => undefined);
    if (!session || session.title === name) return;
    try {
      await this.oc.updateSession(sessionID, { title: name });
      this.store.setTitle(sessionID, name);
      this.appliedTitles.set(sessionID, name);
      log.info(`topic renamed → session: ${name}`);
    } catch (error) {
      log.warn("session rename failed:", (error as Error).message);
    }
  }

  private async onMedia(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message || message.text) return;
    const chat = ctx.chat;
    const allowed = chat?.type === "private" || chat?.id === this.cfg.topicsChatId;
    if (!allowed) return;

    const photo = message.photo?.[message.photo.length - 1];
    const document = message.document;
    const speech = /^audio\/(ogg|opus|mpeg|wav|x-wav|mp4|webm)/i;
    const audio = message.audio && speech.test(message.audio.mime_type ?? "") ? message.audio : undefined;
    const voice = message.voice ?? audio;
    if (voice) {
      try {
        const buffer = await this.download(ctx, voice.file_id, voice.file_size ?? 0);
        const result = await transcribeAudio(buffer, "ogg");
        if (result.ok) {
          log.info(`voice → ${result.text.slice(0, 60)} (${result.elapsedMs} ms)`);
          const seconds = (result.elapsedMs / 1000).toFixed(1);
          const quoted = result.text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
          const markdown = `> 💠 **Расшифровка · голос**\n>\n${quoted}\n>\n> ⏱ ${seconds} с`;
          const chatId = ctx.chat?.id;
          const threadId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
          const options = threadId ? { message_thread_id: threadId } : {};
          try {
            if (!chatId) throw new Error("no chat id");
            await this.bot.api.sendRichMessage(chatId, { markdown }, options);
          } catch (error) {
            log.warn("rich transcript failed, falling back to plain:", (error as Error).message);
            await ctx.reply(`💠 Расшифровка · голос\n\n${result.text}\n\n⏱ ${seconds} с`).catch(() => undefined);
          }
          await this.submitTask(ctx, result.text);
          return;
        }
        if (result.reason === "disabled") {
          await ctx.reply("🎤 Для голосовых нужно включить распознавание файлов в HEX. Включить?", {
            reply_markup: new InlineKeyboard().text("Включить", "voice:on"),
          });
          return;
        }
        if (result.reason === "no-hex") {
          await ctx.reply("🎤 HEX не найден. Установите HEX или укажите путь в HEX_CLI.");
          return;
        }
        if (/no-speech/i.test(result.message)) {
          await ctx.reply("🎤 Речь не распознана — попробуйте ещё раз ближе к микрофону.");
          return;
        }
        await ctx.reply(`🎤 Не удалось распознать: ${result.message.slice(0, 200)}`);
      } catch (error) {
        log.warn("voice failed:", (error as Error).message);
        await ctx.reply(`🎤 Ошибка обработки аудио: ${(error as Error).message.slice(0, 160)}`).catch(() => undefined);
      }
      return;
    }

    const fileId = photo?.file_id ?? document?.file_id;
    if (!fileId) {
      await ctx.reply("Принимаю текст, фото и документы (до 20 МБ).").catch(() => undefined);
      return;
    }
    const size = document?.file_size ?? photo?.file_size ?? 0;
    if (size > 20 * 1024 * 1024) {
      await ctx.reply("Файл больше 20 МБ — Telegram не отдаёт такие файлы ботам.").catch(() => undefined);
      return;
    }

    try {
      const buffer = await this.download(ctx, fileId, size);
      const items = telegramMediaItems(message, buffer);
      if (!items.length) {
        log.info(`photo branch: keys=${Object.keys(message).join(",")}`);
        await ctx.reply("⚠️ Не удалось получить вложение из сообщения.").catch(() => undefined);
        return;
      }
      const files = promptFilesFromMedia(items);
      log.info(`photo branch: items=${items.length} files=${files.length} name=${items[0]?.name}`);
      const caption = (message.caption ?? "").trim() || "Посмотри это изображение.";
      await this.submitTask(ctx, caption, files, items);
    } catch (error) {
      log.warn("media download failed:", (error as Error).message);
      await ctx.reply(`⚠️ Не смог скачать файл: ${(error as Error).message.slice(0, 120)}`).catch(() => undefined);
    }
  }

  private async download(ctx: Context, fileId: string, size: number): Promise<Buffer> {
    if (size > 20 * 1024 * 1024) throw new Error("файл больше 20 МБ");
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error("нет file_path");
    const url = `https://api.telegram.org/file/bot${this.cfg.telegram.token}/${file.file_path}`;
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`download HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async onNonText(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message || message.text || message.photo || message.document || message.voice || message.audio) return;
    const chat = ctx.chat;
    const allowed = chat?.type === "private" || chat?.id === this.cfg.topicsChatId;
    if (!allowed) return;
    await ctx.reply("Принимаю текст, фото, документы и голосовые. Видео и стикеры — позже.").catch(() => undefined);
  }

  private async onCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    await ctx.answerCallbackQuery().catch(() => undefined);

    if (data === "voice:on") {
      const ok = await enableHexFileTranscription();
      await ctx
        .editMessageText(
          ok
            ? "✅ Распознавание включено. Отправьте голосовое ещё раз."
            : "⚠️ Не удалось включить автоматически. HEX → Labs → Transcribe files.",
        )
        .catch(() => undefined);
      return;
    }

    if (data.startsWith("sess:")) {
      const sessionID = data.slice(5);
      const session = await this.oc.getSession(sessionID);
      const chat = ctx.chat;
      const isForum = Boolean(chat && (chat as { is_forum?: boolean }).is_forum) && chat?.type === "supergroup";

      if (isForum && chat) {
        // In a forum a session lives in its own topic; closing the topic keeps the session alive.
        const existing = this.store.session[sessionID];
        if (existing?.threadId && existing.chatId === chat.id) {
          try {
            await this.bot.api.sendMessage(chat.id, "🗂 Тема этой сессии:", { message_thread_id: existing.threadId });
            await ctx.editMessageText(`🗂 Сессия уже в теме «${escape(existing.title)}». Закрытие темы сессию не завершает.`, {
              parse_mode: "HTML",
            });
            return;
          } catch {
            // Topic was deleted — fall through and create a fresh one.
          }
        }
        const topic = await this.openTopicForSession(chat.id, session);
        await ctx.editMessageText(`🗂 Открыл тему «${escape(topic.title)}» — сессия продолжит жить, даже если тему закрыть.`, {
          parse_mode: "HTML",
        });
        return;
      }

      await this.bind(ctx, session);
      await ctx.editMessageText(`🔗 Подключено: <b>${escape(session.title)}</b>`, { parse_mode: "HTML" });
      return;
    }

    if (data.startsWith("perm:")) {
      const [, key, decision] = data.split(":");
      const pending = key ? this.pending.get(key) : undefined;
      if (!pending || !decision) {
        await ctx.editMessageText("⌛️ Запрос устарел.").catch(() => undefined);
        return;
      }
      if (Date.now() - pending.createdAt > PERMISSION_TTL_MS) {
        this.pending.delete(key!);
        await ctx.editMessageText("⌛️ Запрос истёк.").catch(() => undefined);
        return;
      }
      await this.oc.replyPermission(pending.sessionID, pending.requestID, decision as "once" | "always" | "reject");
      this.pending.delete(key!);
      const label = decision === "reject" ? "⛔️ Отклонено" : decision === "always" ? "♾ Разрешено всегда" : "✅ Разрешено";
      await ctx.editMessageText(label).catch(() => undefined);
    }
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
      case "session.execution.started":
      case "session.text.started":
        this.admitted.delete(sessionID);
        if (event.type === "session.execution.started") {
          const meta = await this.sessionMeta(sessionID);
          if (meta.parentID) {
            const agent = meta.agent || "subagent";
            this.childSessions.set(sessionID, { parentID: meta.parentID, agent });
            if (this.cfg.showSubagents !== false && this.streamer.has(meta.parentID)) {
              this.streamer.subagentStarted(meta.parentID, agent);
              log.info(`subagent ${agent} started under ${meta.parentID.slice(0, 16)}`);
            }
            break;
          }
          // A session created without a model gets one assigned by OpenCode by
          // the time execution starts; refresh the label before/when the block
          // appears so it never keeps "unknown model" or a stale /model value.
          catalogFor(this.oc).forget(sessionID);
          this.streamer.setModel(sessionID, await this.modelLabel(sessionID, true));
        }
        await this.ensureStream(sessionID);
        break;
      case "session.text.delta": {
        if (!this.streamer.has(sessionID)) await this.ensureStream(sessionID);
        this.streamer.append(sessionID, String(event.data.delta ?? ""));
        break;
      }
      case "session.text.ended": {
        const text = String(event.data.text ?? "");
        if (text) this.streamer.setText(sessionID, text);
        break;
      }
      case "session.tool.called": {
        const callID = String(event.data.id ?? event.data.callID ?? "");
        this.streamer.toolCalled(sessionID, callID, String(event.data.name ?? "tool"), event.data.input);
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const callID = String(event.data.id ?? event.data.callID ?? "");
        this.streamer.toolFinished(sessionID, callID, event.type === "session.tool.success");
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
            this.streamer.subagentFinished(child.parentID, child.agent, event.type === "session.execution.succeeded");
          }
          log.info(`subagent ${child.agent} finished ${sessionID.slice(0, 16)}`);
          break;
        }
        if (!this.streamer.has(sessionID)) break;
        this.admitted.delete(sessionID);
        const elapsed = this.streamer.elapsedMs(sessionID);
        const status =
          event.type === "session.execution.interrupted"
            ? "⏹ остановлено"
            : event.type === "session.execution.failed"
              ? "⚠️ ошибка"
              : "";
        const stats = status ? { duration: elapsed, tps: undefined } : await this.turnStats(sessionID, elapsed);
        const resolved = sanitizeModelName(await resolveModelLabel(this.oc, sessionID, true));
        const model = resolved === UNKNOWN_MODEL ? this.streamer.modelOf(sessionID) : resolved;
        const parts: string[] = [model];
        if (status) parts.push(status);
        if (stats.duration) parts.push(`⏱ ${formatDuration(stats.duration)}`);
        if (stats.tps) parts.push(`⚡ ${stats.tps.toFixed(1)} tok/s`);
        if (stats.contextTokens) parts.push(`🧠 ${formatTokens(stats.contextTokens)}`);
        await this.streamer.end(sessionID, parts.join(" · "));
        if (event.type === "session.execution.succeeded") void this.relayAgentFiles(sessionID);
        log.info(`turn ${event.type.replace("session.execution.", "")} ${sessionID.slice(0, 16)}`);
        break;
      }
      case "permission.asked":
        await this.askPermission(event);
        break;
      case "session.synthetic":
        await this.subagentReport(sessionID, event.data);
        break;
      case "session.model.selected": {
        // The session switched models mid-flight: refresh the label everywhere.
        catalogFor(this.oc).forget(sessionID);
        this.sessionCache.delete(sessionID);
        const label = sanitizeModelName(await resolveModelLabel(this.oc, sessionID, true));
        this.streamer.setModel(sessionID, label);
        log.info(`model selected ${sessionID.slice(0, 16)} → ${label}`);
        break;
      }
      case "session.renamed": {
        const title = String(event.data.title ?? "").trim();
        if (!title) break;
        if (this.appliedTitles.get(sessionID) === title) break;
        const target = this.targetFor(sessionID);
        if (!target?.threadId) break;
        try {
          await this.bot.api.editForumTopic(target.chatId, target.threadId, { name: title.slice(0, 128) });
          this.appliedTitles.set(sessionID, title);
          this.store.setTitle(sessionID, title);
          log.info(`session renamed → topic: ${title}`);
        } catch (error) {
          log.warn("topic rename failed:", (error as Error).message);
        }
        break;
      }
      default:
        break;
    }
  }

  private async ensureStream(sessionID: string): Promise<void> {
    if (this.streamer.has(sessionID)) return;
    // One fetch covers both checks: child sessions never get a block, and a
    // late event from a finished turn must not create an orphan placeholder
    // that stays at "thinking… 1s" forever.
    const session = await this.oc.getSession(sessionID).catch(() => undefined);
    if (!session || session.parentID) return;
    const busy = Number(session.time?.busy ?? 0) > Number(session.time?.idle ?? 0);
    if (!busy) return;
    const target = this.targetFor(sessionID);
    if (!target) return;
    await this.streamer.begin(sessionID, target, await this.modelLabel(sessionID));
    log.info(`attached to running session ${sessionID.slice(0, 16)}`);
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
   * `session.synthetic` on the parent: the child's `<subagent>` report.
   * Posts the first ~300 chars as a muted quote unless `showSubagents` is off.
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
    const options = target.threadId ? { message_thread_id: target.threadId } : {};
    try {
      await this.bot.api.sendRichMessage(target.chatId, { markdown: `> 🧩 ${agent}: ${text}` }, options);
      log.info(`subagent report ${agent} → ${parentID.slice(0, 16)}`);
    } catch {
      await this.bot.api.sendMessage(target.chatId, `🧩 ${agent}: ${text}`, options).catch(() => undefined);
    }
  }

  private async isSubagent(sessionID: string): Promise<boolean> {
    return Boolean((await this.sessionMeta(sessionID)).parentID);
  }

  /** Human model name shared with Discord; never the bare "OpenCode". */
  private async modelLabel(sessionID: string, refresh = false): Promise<string> {
    const label = await resolveModelLabel(this.oc, sessionID, refresh);
    catalogFor(this.oc).remember(sessionID, label);
    return label;
  }

  /** Guards against feeding a message the bridge itself posted back into the model. */
  private isEcho(chatId: number | undefined, text: string): boolean {
    if (!chatId) return false;
    const entries = this.recentMirrors.get(String(chatId)) ?? [];
    const now = Date.now();
    return entries.some((entry) => entry.text === text && now - entry.at < 10 * 60 * 1000);
  }

  private rememberMirror(chatId: number, text: string): void {
    const key = String(chatId);
    const entries = (this.recentMirrors.get(key) ?? []).filter((entry) => Date.now() - entry.at < 10 * 60 * 1000);
    entries.push({ text, at: Date.now() });
    this.recentMirrors.set(key, entries.slice(-20));
  }

  /** Mirrors prompts sent from the desktop/TUI into the bound Telegram chat. */
  private async mirrorUserMessage(sessionID: string, item: unknown): Promise<void> {
    const envelope = item as { type?: string; payload?: { text?: string; metadata?: Record<string, unknown> } };
    if (!envelope || envelope.type !== "user") return;
    if (envelope.payload?.metadata?.source === "telegram") return;
    if (await this.isSubagent(sessionID)) return;
    const text = (envelope.payload?.text ?? "").trim();
    if (!text) return;
    const target = this.targetFor(sessionID);
    if (!target) return;
    const options = target.threadId ? { message_thread_id: target.threadId } : {};
    const quoted = text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const markdown = `> 👤 **Вы** · OpenCode\n>\n${quoted}`;
    try {
      await this.bot.api.sendRichMessage(target.chatId, { markdown }, options);
    } catch (error) {
      if (target.threadId && /message thread not found/i.test((error as Error).message)) {
        this.store.unbindThread(target.threadId);
        log.warn(`topic ${target.threadId} was deleted, binding cleared`);
        return;
      }
      await this.bot.api.sendMessage(target.chatId, `👤 Вы (OpenCode):\n${text}`, options).catch(() => undefined);
    }
    this.rememberMirror(target.chatId, text);
    await this.options.relay?.relayBeforeTurn(sessionID, mediaFromPayload(envelope), "agent");
    log.info(`mirror user → ${sessionID.slice(0, 16)}`);
  }

  /**
   * Mirrors OpenCode's `SessionTurn.duration` / `SessionTurn.tokensPerSecond`:
   * duration is prompt creation → this message completed, and tok/s aggregates
   * every assistant step of the turn over its first-token → streamed window.
   */
  private async turnStats(sessionID: string, elapsedMs?: number): Promise<{ duration?: number; tps?: number; contextTokens?: number }> {
    try {
      const fetched = await this.oc.messages(sessionID, { limit: 60, order: "desc" });
      // The API returns newest-first; OpenCode's turn logic walks the timeline oldest-first.
      const messages = fetched.slice().reverse();
      let end = -1;
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.type === "assistant") {
          end = index;
          break;
        }
      }
      const last = messages[end];
      if (!last) return { duration: elapsedMs };
      const tokens = last.tokens as
        | { output?: number; reasoning?: number; input?: number; cache?: { read?: number } }
        | undefined;

      // Turn boundary: the prompt after the previous idle marker, or the nearest prompt in legacy sessions.
      const legacy = !messages.some((message) => message.type === "idle");
      let start = -1;
      for (let index = end - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message) break;
        if (message.type === "idle") break;
        if (message.type !== "user" && message.type !== "synthetic") continue;
        if (legacy) {
          start = index;
          break;
        }
        start = index;
      }
      const prompt = start >= 0 ? messages[start] : undefined;
      const steps = (prompt ? messages.slice(start + 1, end + 1) : [last]).filter((message) => message.type === "assistant");

      const contextTokens =
        Number(tokens?.input ?? 0) + Number(tokens?.cache?.read ?? 0) + Number(tokens?.output ?? 0) + Number(tokens?.reasoning ?? 0);

      const completed = last.time?.completed;
      const duration =
        completed && completed > 0 ? Math.max(0, completed - (prompt?.time?.created ?? last.time?.created ?? completed)) : elapsedMs;

      const active = steps.map((step) => {
        const time = step?.time;
        if (time?.streamed === undefined) return undefined;
        return Math.max(0, time.streamed - (time.firstToken ?? time.created ?? time.streamed));
      });
      const generated = active.every((value) => value !== undefined) ? active.reduce<number>((sum, value) => sum + (value ?? 0), 0) : 0;
      const output = steps.reduce((sum, step) => {
        const usage = step?.tokens as { output?: number; reasoning?: number } | undefined;
        return sum + Number(usage?.output ?? 0) + Number(usage?.reasoning ?? 0);
      }, 0);
      const tps = output > 0 && generated > 200 ? output / (generated / 1000) : undefined;

      return { duration, tps, contextTokens };
    } catch {
      return { duration: elapsedMs };
    }
  }

  private async askPermission(event: OcEvent): Promise<void> {
    const sessionID = String(event.data.sessionID);
    const requestID = String(event.data.id);
    const target = this.targetFor(sessionID);
    if (!target) {
      log.warn("permission for unknown session", sessionID);
      return;
    }
    const key = Math.random().toString(36).slice(2, 8);
    this.pending.set(key, { sessionID, requestID, createdAt: Date.now() });

    const action = String(event.data.action ?? "?");
    const resources = Array.isArray(event.data.resources) ? event.data.resources.join(", ") : "";
    const message = event.data.message ? `\n\n<i>${escape(String(event.data.message))}</i>` : "";
    const keyboard = new InlineKeyboard()
      .text("✅ Разрешить", `perm:${key}:once`)
      .text("♾ Всегда", `perm:${key}:always`)
      .row()
      .text("⛔️ Отклонить", `perm:${key}:reject`);

    await this.bot.api.sendMessage(
      target.chatId,
      `🔐 <b>Требуется разрешение</b>\n<b>${escape(action)}</b>: <code>${escape(resources)}</code>${message}`,
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
        ...(target.threadId ? { message_thread_id: target.threadId } : {}),
      },
    );
  }

  // ------------------------------------------------------------------ helpers

  private async openTopicForSession(chatId: number, session: OcSession): Promise<{ threadId: number; title: string }> {
    const title = (session.title || session.id.slice(0, 12)).replace(/\s+/g, " ").trim().slice(0, 60) || "OpenCode";
    const topic = await this.bot.api.createForumTopic(chatId, title);
    this.store.bindThread(topic.message_thread_id, session.id);
    this.store.upsert({ id: session.id, title: session.title, chatId, threadId: topic.message_thread_id });
    await this.bot.api.sendMessage(
      chatId,
      `🔗 <b>${escape(session.title)}</b>\n<code>${session.id}</code>\n📁 <code>${escape(session.location?.directory ?? "?")}</code>\n\n` +
        "Пишите сюда — задача уйдёт в эту сессию OpenCode.\n" +
        "<i>Закрытие или удаление темы не завершает сессию.</i>",
      { parse_mode: "HTML", message_thread_id: topic.message_thread_id },
    );
    return { threadId: topic.message_thread_id, title };
  }

  private async currentSession(ctx: Context, create: boolean): Promise<string | undefined> {
    const threadId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
    const chatId = ctx.chat?.id;
    if (!chatId) return undefined;

    if (threadId) {
      const bound = this.store.byThread(threadId);
      if (bound) return bound;
      if (!create) return undefined;
      const session = await this.oc.createSession({
        title: (ctx.message as { text?: string } | undefined)?.text?.slice(0, 60) || "Telegram session",
        directory: this.cfg.defaultDirectory,
      });
      this.store.bindThread(threadId, session.id);
      this.store.upsert({ id: session.id, title: session.title, chatId, threadId });
      return session.id;
    }

    // Forum groups use topics only; a chat-level session would hijack every topic.
    if (this.cfg.topicsChatId && chatId === this.cfg.topicsChatId) return undefined;

    const bound = this.store.byChat(chatId);
    if (bound) return bound;
    if (!create) return undefined;
    const session = await this.oc.createSession({
      title: (ctx.message as { text?: string } | undefined)?.text?.slice(0, 60) || "Telegram session",
      directory: this.cfg.defaultDirectory,
    });
    this.store.bindChat(chatId, session.id);
    this.store.upsert({ id: session.id, title: session.title, chatId });
    return session.id;
  }

  private async bind(ctx: Context, session: OcSession): Promise<void> {
    const threadId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    if (!threadId && chatId === this.cfg.topicsChatId) {
      await ctx
        .reply("В этой группе сессии живут в темах. Создайте тему или напишите задачу в общий чат — сделаю тему сам.")
        .catch(() => undefined);
      return;
    }
    if (threadId) this.store.bindThread(threadId, session.id);
    else this.store.bindChat(chatId, session.id);
    this.store.upsert({ id: session.id, title: session.title, chatId, threadId });
  }

  private targetFor(sessionID: string, ctx?: Context): Target | undefined {
    if (ctx?.chat?.id) {
      const threadId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
      return { chatId: ctx.chat.id, threadId };
    }
    const location = this.store.locate(sessionID);
    if (location.chatId) {
      const chatId = location.chatId;
      // Never leak into foreign groups.
      if (chatId < 0 && chatId !== this.cfg.topicsChatId) return undefined;
      // The forum's general chat is not a target: sessions live in topics only.
      if (chatId === this.cfg.topicsChatId && !location.threadId) return undefined;
      return { chatId, threadId: location.threadId };
    }
    if (location.threadId && this.cfg.topicsChatId) return { chatId: this.cfg.topicsChatId, threadId: location.threadId };
    return undefined;
  }
}

/** Inbound Telegram photo/document → one MediaItem (same bytes for prompt and relay). */
export function telegramMediaItems(
  message: { photo?: Array<{ file_size?: number }>; document?: { mime_type?: string; file_name?: string } },
  buffer: Buffer,
): MediaItem[] {
  if (!buffer?.length) return [];
  const mime = message.document?.mime_type ?? "image/jpeg";
  const name = message.document?.file_name ?? `photo-${Date.now()}.jpg`;
  return [{ buffer, mime, name }];
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function argText(ctx: Context): string {  return typeof ctx.match === "string" ? ctx.match.trim() : "";
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text of a `session.synthetic` event; the payload shape has varied across builds. */
function syntheticText(data: unknown): string {
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

function label(session: OcSession): string {
  const title = session.title.length > 45 ? `${session.title.slice(0, 44)}…` : session.title;
  return title || session.id.slice(0, 12);
}

export type { UserConfig };
