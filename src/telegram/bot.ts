import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { BridgeConfig, UserConfig } from "../config.ts";
import { findUser, isAdmin } from "../config.ts";
import { log } from "../log.ts";
import type { OcClient, OcEvent, OcSession } from "../opencode/client.ts";
import { catalogFor, resolveModelLabel, sanitizeModelName, UNKNOWN_MODEL } from "../model.ts";
import type { Store } from "../state/store.ts";
import { entitiesToMarkdown } from "./entities.ts";
import { Streamer, type Target } from "./stream.ts";
import { runEvent } from "../events.ts";
import { mirrorKey, MirrorLedger } from "../order.ts";
import { BackgroundSubagents, normalizeSubagentMode, subagentPlacement, type SubagentPlacement } from "../subagents.ts";
import { statusReport, statusReportHtml, type BridgeRuntimeInfo } from "../status.ts";
import {
  activeFields,
  buildAnswer,
  defaultValues,
  fieldHint,
  fieldTitle,
  fieldWidget,
  FORM_TTL_MS,
  isChatRenderable,
  nextField,
  parseText,
  summarize,
  type FormAnswer,
  type FormField,
  type FormInfo,
  type FormValues,
} from "../forms.ts";
import { isPermissionMode, MODE_SUMMARY, modeOf, rulesForMode } from "../permissions.ts";
import { recentEntries, recentLine } from "../recent.ts";
import { formatUsd, type BudgetSnapshot } from "../budget.ts";
import { canRename, normalizeTitleStatus, pickTopicIcon, renameWait, sameTitleName, syncTitleName, titleWithMarker } from "../titles.ts";
import { assistantMessageIDOf, turnTag } from "../turns.ts";
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
import {
  ObservationCards,
  parseObserveKey,
  pickObserveTarget,
  telegramObserveKey,
  type ObserveBinding,
} from "../observe.ts";
import type { StopRegistry } from "../stops.ts";
import { composeTurnFooter, isBlockedToolFailure, turnReason } from "../turn.ts";
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
  "form.created",
  "form.replied",
  "form.cancelled",
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

/** One chat-side form: question index, draft answers and the message it edits. */
interface TelegramForm {
  token: string;
  form: FormInfo;
  createdAt: number;
  chatId: number;
  threadId?: number;
  messageId: number;
  values: FormValues;
  done: Set<string>;
  page: number;
  /** Field key waiting for a typed answer. */
  awaitText?: string;
}

/** Topic status marker state: icon (`⏳`/`✅`), legacy rename, or off. */
interface TelegramTitle {
  base: string;
  phase: "idle" | "start" | "done";
  lastRename: number;
  version: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Last applied topic icon: "start", "done" or null (default icon). */
  icon?: "start" | "done" | null;
  lastIconAt?: number;
  /** Name currently on the topic, so an unchanged title is never re-applied. */
  appliedName?: string;
}

export class Bridge {
  private readonly bot: Bot;
  private readonly streamer: Streamer;
  private readonly pending = new Map<string, PendingPermission>();
  /** Choice forms rendered in chat, keyed by a short callback token. */
  private readonly forms = new Map<string, TelegramForm>();
  /** formID → last render attempt, so the poller does not spam unmapped sessions. */
  private readonly seenForms = new Map<string, number>();
  /** Per-session topic status markers (icon by default, rename opt-in). */
  private readonly titles = new Map<string, TelegramTitle>();
  /** Standard forum icon ids resolved once from `getForumTopicIconStickers`. */
  private topicIcons?: { start?: string; done?: string };
  private topicIconsFailedAt = 0;
  private formTimer?: ReturnType<typeof setInterval>;
  private readonly sessionCache = new Map<string, { parentID?: string | null; agent?: string; title?: string }>();
  /** Child session id → parent binding, so `execution.*` updates the parent block. */
  private readonly childSessions = new Map<string, { parentID: string; agent: string; placement: SubagentPlacement }>();
  /** Prompts the API accepted but OpenCode has not started yet (doctor). */
  private readonly admitted = new Map<string, { at: number; target?: Target; warned: boolean }>();
  private doctorTimer?: ReturnType<typeof setInterval>;
  private readonly recentMirrors = new Map<string, { text: string; at: number }[]>();
  /** Item-id guard: a replayed SSE event never mirrors the same prompt twice. */
  private readonly mirrorLedger = new MirrorLedger();
  /** Last successful mirror per session, so the history fallback does not repeat it. */
  private readonly mirroredAt = new Map<string, number>();
  /** Text+time guard across event/history paths with different item ids. */
  private readonly lastMirror = new Map<string, { text: string; at: number }>();
  /** Prompts this bridge sent itself, so history never mirrors them back. */
  private readonly selfPrompts = new Map<string, { text: string; at: number }[]>();
  private readonly appliedTitles = new Map<string, string>();
  /** Deferred topic renames: Telegram allows roughly one rename per 60 s. */
  private readonly renameTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fetchImpl: typeof fetch;
  /** Last agent-files scan per session, so tool.success + turn end don't double-fetch. */
  private readonly agentFilesAt = new Map<string, number>();
  /** `/observe` cards for foreign (Desktop/TUI) sessions. */
  private readonly observer: ObservationCards;
  /** Dedicated cards for children whose parent answer already finished. */
  private readonly background: BackgroundSubagents<Target>;
  /** Cumulative session cost at observation start, for the final card. */
  private readonly observeCost = new Map<string, number>();
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
      budget?: () => BudgetSnapshot | undefined;
      stops?: StopRegistry;
      runtime?: () => BridgeRuntimeInfo;
    } = {},
  ) {
    this.bot = new Bot(cfg.telegram.token, options.fetch ? { client: { fetch: options.fetch } } : {});
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.observer = new ObservationCards({
      intervalMs: 1200,
      log: (message) => log.warn(message),
      transport: {
        send: async (target, text) => {
          if (!target.chatId) return undefined;
          const message = await this.bot.api.sendMessage(target.chatId, text, target.threadId ? { message_thread_id: target.threadId } : {});
          return String(message.message_id);
        },
        edit: async (target, messageId, text) => {
          if (!target.chatId) return;
          await this.bot.api.editMessageText(target.chatId, Number(messageId), text);
        },
      },
    });
    this.streamer = new Streamer(this.bot.api, {
      editIntervalMs: cfg.stream.editIntervalMs,
      showTools: cfg.stream.showTools,
      format: cfg.stream.format ?? "rich",
      diagnostics: () => this.cfg.ui?.diagnostics === true,
      onThreadGone: (sessionID) => {
        this.store.clearThread(sessionID);
        log.warn(`topic for ${sessionID.slice(0, 16)} was deleted; binding cleared`);
      },
    });
    this.background = new BackgroundSubagents<Target>({
      tickMs: 2000,
      send: async (target, text) => {
        const message = await this.bot.api.sendMessage(
          target.chatId,
          text,
          target.threadId ? { message_thread_id: target.threadId } : {},
        );
        return String(message.message_id);
      },
      edit: async (target, messageId, text) => {
        await this.bot.api.editMessageText(target.chatId, Number(messageId), text);
      },
      remove: async (target, messageId) => {
        await this.bot.api.deleteMessage(target.chatId, Number(messageId));
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
          .then(() => runEvent((signal) => this.onEvent(event, signal)))
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
    // `form.created` is ephemeral and can be missed (Desktop also falls back to
    // a form sync), so bound sessions are polled for pending forms.
    this.formTimer = setInterval(() => void this.tickForms(), 20_000);
    this.formTimer.unref?.();
    const firstPoll = setTimeout(() => void this.tickForms(), 4_000);
    firstPoll.unref?.();
    return username;
  }

  async stop(): Promise<void> {
    if (this.doctorTimer) clearInterval(this.doctorTimer);
    this.doctorTimer = undefined;
    if (this.formTimer) clearInterval(this.formTimer);
    this.formTimer = undefined;
    this.forms.clear();
    for (const state of this.titles.values()) if (state.timer) clearTimeout(state.timer);
    this.titles.clear();
    for (const timer of this.renameTimers.values()) clearTimeout(timer);
    this.renameTimers.clear();
    this.unsubscribe?.();
    this.background.stop();
    await this.observer.shutdown();
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
    const options = {
      ...(target.threadId ? { message_thread_id: target.threadId } : {}),
      caption: item.name.slice(0, 1000),
    };
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
    this.bot.command("mode", (ctx) => this.cmdMode(ctx));
    this.bot.command("recent", (ctx) => this.cmdRecent(ctx));
    this.bot.command("budget", (ctx) => this.cmdBudget(ctx));
    this.bot.command("observe", (ctx) => this.cmdObserve(ctx));
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
        "/mode [ask|auto|plan] — режим разрешений",
        "/budget — лимиты стоимости и расход за день",
        "/recent — недавние сессии (🔔 = не прочитано)",
        "/observe [on|off|status] — зеркало внешних запусков",
        "",
        `Ваша роль: <b>${user?.role ?? "user"}</b>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  }

  private async cmdNew(ctx: Context): Promise<void> {
    const directory = argText(ctx) || this.cfg.defaultDirectory;
    const session = await this.oc.createSession({
      title: "Telegram session",
      directory,
      permissions: rulesForMode(this.cfg.permissions?.mode ?? "ask"),
    });
    await this.bind(ctx, session);
    await ctx.reply(`🆕 Сессия <code>${session.id}</code>\n📁 <code>${escape(session.location?.directory ?? "?")}</code>`, {
      parse_mode: "HTML",
    });
  }

  private async cmdMode(ctx: Context): Promise<void> {
    const sessionID = await this.currentSession(ctx, false);
    if (!sessionID) {
      await ctx.reply("Нет активной сессии. /new или /attach.");
      return;
    }
    const arg = argText(ctx).toLowerCase();
    if (!arg) {
      const session = await this.oc.getSession(sessionID).catch(() => undefined);
      const mode = modeOf(session?.permissions);
      await ctx.reply(
        `🔐 Режим разрешений: <b>${mode}</b>\n<i>${escape(MODE_SUMMARY[mode])}</i>\n\n` +
          "Сменить: <code>/mode ask</code>, <code>/mode auto</code>, <code>/mode plan</code>.",
        { parse_mode: "HTML" },
      );
      return;
    }
    if (!isPermissionMode(arg)) {
      await ctx.reply("Формат: <code>/mode ask|auto|plan</code>", { parse_mode: "HTML" });
      return;
    }
    await this.oc.setPermissions(sessionID, rulesForMode(arg));
    await ctx.reply(`✅ Режим: <b>${arg}</b> — <i>${escape(MODE_SUMMARY[arg])}</i>`, { parse_mode: "HTML" });
  }

  private async cmdRecent(ctx: Context): Promise<void> {    const list = await this.oc.listSessions({ limit: 20, order: "desc", archived: "false", parentID: null });
    const entries = recentEntries(list, 10);
    if (!entries.length) {
      await ctx.reply("Сессий нет.");
      return;
    }
    const lines = ["🗂 <b>Недавние сессии</b>", ""];
    for (const [index, entry] of entries.entries()) lines.push(escape(recentLine(entry, index)));
    lines.push("", "<i>🔔 — есть непрочитанный ход. Нажмите кнопку, чтобы подключиться.</i>");
    const keyboard = new InlineKeyboard();
    for (const [index, entry] of entries.entries()) {
      const bell = entry.unread ? "🔔 " : "";
      keyboard.text(`${index + 1}. ${bell}${entry.title}`.slice(0, 60), `recent:${entry.id}`).row();
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: keyboard });
  }

  private async cmdBudget(ctx: Context): Promise<void> {
    const snapshot = this.options.budget?.();
    if (!snapshot) {
      await ctx.reply("💰 Бюджет: демон не запущен.");
      return;
    }
    const lines = ["💰 <b>Бюджет</b>"];
    const limits: string[] = [];
    if (snapshot.perTurnUsd) limits.push(`ход ${formatUsd(snapshot.perTurnUsd)}`);
    if (snapshot.dailyUsd) limits.push(`день ${formatUsd(snapshot.dailyUsd)}`);
    lines.push(limits.length ? `Лимиты: ${escape(limits.join(" · "))}` : "Лимиты не заданы.");
    lines.push(
      snapshot.dailyUsd
        ? `Сегодня (UTC): ${formatUsd(snapshot.spentUsd)} из ${formatUsd(snapshot.dailyUsd)}`
        : `Сегодня (UTC): ${formatUsd(snapshot.spentUsd)}`,
    );
    lines.push(`Действие: ${snapshot.action === "stop" ? "остановить ход" : "предупредить"}`);
    if (snapshot.active.length) {
      lines.push(`Активные ходы: ${snapshot.active.length}`);
      for (const turn of snapshot.active.slice(0, 5)) {
        const pct = snapshot.perTurnUsd ? Math.round((turn.spentUsd / snapshot.perTurnUsd) * 100) : 0;
        lines.push(`· <code>${escape(turn.sessionID.slice(0, 16))}…</code> ${formatUsd(turn.spentUsd)}${pct ? ` (${pct}%)` : ""}`);
      }
    }
    if (!limits.length) lines.push("", "Настройка: <code>ocbridge-cli budget set per-turn=1 daily=5</code>.");
    else if (snapshot.perTurnUsd) lines.push("", `<i>80% — предупреждение, 100% — ${snapshot.action === "stop" ? "прерывание" : "ещё одно предупреждение"}.</i>`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }

  private async cmdObserve(ctx: Context): Promise<void> {
    const binding = this.observeBinding(ctx);
    if (!binding) {
      await ctx.reply("Не понимаю, какой чат наблюдать.");
      return;
    }
    const arg = argText(ctx).toLowerCase();
    const enabled = this.store.observeEnabled(binding.key);
    if (arg === "on" || (!arg && !enabled)) {
      this.store.observeEnable(binding.key);
      await ctx.reply(
        "👀 <b>Наблюдение включено</b>\n" +
          "Запуски сессий из Desktop/TUI появятся здесь компактной карточкой. " +
          "Сессии, привязанные к теме/чату, не дублируются.\n" +
          "Выключить: <code>/observe off</code> · статус: <code>/observe status</code>",
        { parse_mode: "HTML" },
      );
      log.info(`observe enabled for ${binding.key}`);
      return;
    }
    if (arg === "off" || (!arg && enabled)) {
      await this.store.observeClear(binding.key);
      await this.observer.cancelKey(binding.key);
      await ctx.reply("⏹ Наблюдение выключено.");
      log.info(`observe disabled for ${binding.key}`);
      return;
    }
    if (arg && arg !== "status") {
      await ctx.reply("Формат: <code>/observe [on|off|status]</code>", { parse_mode: "HTML" });
      return;
    }
    if (!enabled) {
      await ctx.reply("👀 Наблюдение выключено. <code>/observe</code> — включить.", { parse_mode: "HTML" });
      return;
    }
    const sessions = this.store.observeFor(binding.key);
    const live = new Map(this.observer.entries(binding.key).map((entry) => [entry.sessionID, entry]));
    const lines = ["👀 <b>Наблюдение включено</b>"];
    if (!sessions.length) {
      lines.push("", "Активных внешних запусков нет — жду следующего.");
    } else {
      lines.push("");
      for (const sessionID of sessions) {
        const title = live.get(sessionID)?.title || this.store.session[sessionID]?.title || sessionID.slice(0, 12);
        lines.push(`· ${escape(title)} · <code>${escape(sessionID.slice(0, 16))}</code>`);
      }
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }

  private observeBinding(ctx: Context): ObserveBinding | undefined {
    const chatId = ctx.chat?.id;
    if (!chatId) return undefined;
    const threadId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
    return {
      key: telegramObserveKey(chatId, threadId),
      platform: "telegram",
      chatId,
      ...(threadId ? { threadId } : {}),
    };
  }

  /** Every Telegram chat/topic that opted into `/observe`. */
  private observeTargets(): ObserveBinding[] {
    return this.store
      .observeKeys()
      .map((key) => parseObserveKey(key))
      .filter((binding): binding is ObserveBinding => binding?.platform === "telegram");
  }

  /**
   * Starts an observation card for a run that has no topic/thread binding.
   * Bound sessions are never duplicated; the first observing target wins.
   */
  private async maybeObserve(sessionID: string): Promise<boolean> {
    if (this.observer.has(sessionID)) return true;
    if (this.streamer.hasBlock(sessionID)) return false;
    const targets = this.observeTargets();
    if (!targets.length) return false;
    const session = await this.oc.getSession(sessionID).catch(() => undefined);
    if (!session) return false;
    const telegram = this.store.locate(sessionID);
    const discord = this.store.locateDiscord(sessionID);
    const bound = Boolean(telegram.chatId || telegram.threadId || discord.chatId || discord.threadId);
    const target = pickObserveTarget({ bound, parent: Boolean(session.parentID), hasStream: false }, targets);
    if (!target) return false;
    const model = await this.modelLabel(sessionID);
    if (!(await this.observer.begin(sessionID, target, model, session.title))) return false;
    this.observeCost.set(sessionID, Number(session.cost ?? 0));
    this.store.observeAdd(target.key, sessionID);
    log.info(`observing ${sessionID.slice(0, 16)} → ${target.key}`);
    return true;
  }

  /** Final observation card: duration/tok/s/context from the same stats as a normal turn. */
  private async finishObservation(
    sessionID: string,
    event: OcEvent,
  ): Promise<boolean> {
    if (!this.observer.has(sessionID)) return false;
    const elapsed = this.observer.elapsedMs(sessionID);
    const stats = await this.turnStats(sessionID, elapsed);
    const total = Number((await this.oc.getSession(sessionID).catch(() => undefined))?.cost ?? 0);
    const base = this.observeCost.get(sessionID) ?? total;
    this.observeCost.delete(sessionID);
    await this.observer.end(sessionID, {
      ok: event.type === "session.execution.succeeded",
      durationMs: stats.duration,
      tps: stats.tps,
      contextTokens: stats.contextTokens,
      costUsd: Math.max(0, total - base),
    });
    this.store.observeRemove(sessionID);
    log.info(
      `observe ${event.type.replace("session.execution.", "")} ${sessionID.slice(0, 16)} ` +
        `(${Math.round((stats.duration ?? elapsed ?? 0) / 1000)}s)`,
    );
    return true;
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
    const session = await this.oc.createSession({
      title,
      directory: this.cfg.defaultDirectory,
      permissions: rulesForMode(this.cfg.permissions?.mode ?? "ask"),
    });
    this.store.bindThread(topic.message_thread_id, session.id);
    this.store.upsert({ id: session.id, title: session.title, chatId: this.cfg.topicsChatId, threadId: topic.message_thread_id });
    this.rememberTopicName(session.id, title);
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
    this.options.stops?.markUser(sessionID);
    const result = await this.oc.interrupt(sessionID);
    if (!result.interrupted) this.options.stops?.clear(sessionID);
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
    const runtime = this.runtimeInfo();
    const sessions = await this.oc
      .listSessions({ limit: 100, archived: "false", parentID: null })
      .then((list) => list.length)
      .catch(() => 0);
    const report = statusReport({
      version: pkg.version,
      uptimeMs: runtime.uptimeMs,
      adapters: { telegram: runtime.telegram, discord: runtime.discord },
      opencode: { version: runtime.ocVersion, url: runtime.ocUrl },
      session: {
        title: session.title,
        id: session.id,
        directory: session.location?.directory,
        model: await this.modelLabel(sessionID),
        agent: session.agent,
        busy: Number(session.time?.busy ?? 0) > Number(session.time?.idle ?? 0),
        tokens: session.tokens,
        cost: session.cost,
      },
      sessions,
    });
    await ctx.reply(statusReportHtml(report), { parse_mode: "HTML" });
  }

  /** Live daemon facts for `/status`; the App owns uptime and adapter state. */
  private runtimeInfo(): BridgeRuntimeInfo {
    return (
      this.options.runtime?.() ?? {
        ocVersion: "?",
        ocUrl: this.oc.baseUrl,
        uptimeMs: 0,
        telegram: { enabled: this.cfg.telegram.enabled !== false, state: "running" },
        discord: { enabled: Boolean(this.cfg.discord?.enabled), state: "off" },
      }
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

  /** Replying to a background subagent card keeps it (cancels the 10 min delete). */
  private keepRepliedCard(ctx: Context): void {
    const replied = (ctx.message as { reply_to_message?: { message_id?: number } } | undefined)?.reply_to_message?.message_id;
    if (replied) this.background.keep(String(replied));
  }

  private async onText(ctx: Context & { message: { text: string; message_thread_id?: number } }): Promise<void> {
    this.keepRepliedCard(ctx);
    const text = entitiesToMarkdown(ctx.message.text, (ctx.message as { entities?: any[] }).entities ?? []).trim();
    if (!text || text.startsWith("/")) return;
    if (this.isEcho(ctx.chat?.id, text)) {
      log.warn("ignored echo of a bridge-posted message");
      return;
    }
    if (await this.handleFormText(ctx, text)) return;
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
        const session = await this.oc.createSession({
          title,
          directory: this.cfg.defaultDirectory,
          permissions: rulesForMode(this.cfg.permissions?.mode ?? "ask"),
        });
        sessionID = session.id;
        this.store.bindThread(topicID, session.id);
        this.store.upsert({ id: session.id, title: session.title, chatId, threadId: topicID });
        this.rememberTopicName(session.id, title);
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
        await this.streamer.begin(sessionID, target, await this.modelLabel(sessionID), true);
        log.info(`prompt → ${sessionID.slice(0, 16)}: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
        try {
          this.rememberSelfPrompt(sessionID, text);
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
    await this.streamer.begin(sessionID, target, await this.modelLabel(sessionID), true);
    log.info(`prompt → ${sessionID.slice(0, 16)}: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
    try {
      this.rememberSelfPrompt(sessionID, text);
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
      const session = await this.oc.createSession({
        title: name,
        directory: this.cfg.defaultDirectory,
        permissions: rulesForMode(this.cfg.permissions?.mode ?? "ask"),
      });
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
      const state = this.titles.get(sessionID);
      if (state) {
        state.base = name;
        state.appliedName = name;
      }
      log.info(`topic renamed → session: ${name}`);
    } catch (error) {
      log.warn("session rename failed:", (error as Error).message);
    }
  }

  private async onMedia(ctx: Context): Promise<void> {
    this.keepRepliedCard(ctx);
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

    if (data.startsWith("recent:")) {
      await this.onRecentCallback(ctx, data.slice(7));
      return;
    }

    if (data.startsWith("form:")) {
      const [, token, action, arg] = data.split(":");
      if (token && action) await this.onFormCallback(ctx, token, action, arg);
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
      if (decision === "reject") this.streamer.blockedTool(pending.sessionID);
      this.pending.delete(key!);
      const label = decision === "reject" ? "⛔️ Отклонено" : decision === "always" ? "♾ Разрешено всегда" : "✅ Разрешено";
      await ctx.editMessageText(label).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ events

  private async onEvent(event: OcEvent, signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (signal.aborted) return;
    if (event.type === "form.created") {
      // Payload is `{form}` only: no sessionID at the top level.
      await this.askForm(event.data.form as FormInfo);
      return;
    }

    if (event.type === "session.created") {
      const data = event.data ?? {};
      const session = data.session as { id?: string } | undefined;
      const id = String(session?.id ?? data.id ?? data.sessionID ?? "");
      if (id) await this.sessionMeta(id);
      return;
    }

    const sessionID = String(event.data?.sessionID ?? "");
    if (!sessionID) return;
    // Turn id of this event: the assistant message id (turn keying + diagnostics).
    const turnHint = assistantMessageIDOf(event.data);

    switch (event.type) {
      case "session.inbox.enqueued":
        await this.mirrorUserMessage(sessionID, event.data.item);
        break;
      case "session.execution.started":
      case "session.text.started":
        this.admitted.delete(sessionID);
        if (event.type === "session.execution.started") {
          this.options.stops?.clear(sessionID);
          const meta = await this.sessionMeta(sessionID);
          if (meta.parentID) {
            const agent = meta.agent || "subagent";
            const placement = subagentPlacement(this.cfg.showSubagents, this.streamer.hasBlock(meta.parentID));
            this.childSessions.set(sessionID, { parentID: meta.parentID, agent, placement });
            if (placement === "inline") {
              this.streamer.subagentStarted(meta.parentID, agent);
              log.info(`subagent ${agent} started under ${meta.parentID.slice(0, 16)}`);
            } else if (placement === "message") {
              const target = this.targetFor(meta.parentID);
              if (target) {
                void this.background.start(
                  meta.parentID,
                  target,
                  sessionID,
                  agent,
                  meta.title?.trim() || agent,
                );
                log.info(`background subagent ${agent} started under ${meta.parentID.slice(0, 16)}`);
              }
            }
            break;
          }
          // A session created without a model gets one assigned by OpenCode by
          // the time execution starts; refresh the label before/when the block
          // appears so it never keeps "unknown model" or a stale /model value.
          catalogFor(this.oc).forget(sessionID);
          this.streamer.setModel(sessionID, await this.modelLabel(sessionID, true));
          await this.markTitle(sessionID, "start");
        }
        // Guarantee the mirrored prompt (text + media) is on screen before the
        // placeholder/answer, even if `session.inbox.enqueued` was missed or
        // arrived after `execution.started` (volatile SSE).
        await this.mirrorLatestExternal(sessionID);
        if (signal.aborted) return;
        if (!(await this.maybeObserve(sessionID))) {
          // `execution.started` is the turn boundary; `text.started` only binds
          // the turn to its assistant message (never opens a second message).
          await this.ensureStream(sessionID, event.type === "session.execution.started", turnHint);
        }
        break;
      case "session.text.delta": {
        if (!this.streamer.has(sessionID) && !this.observer.has(sessionID)) await this.ensureStream(sessionID, false, turnHint);
        this.streamer.append(sessionID, String(event.data.delta ?? ""), turnHint);
        break;
      }
      case "session.text.ended": {
        const text = String(event.data.text ?? "");
        if (text) this.streamer.setText(sessionID, text, turnHint);
        break;
      }
      case "session.tool.called": {
        const callID = String(event.data.id ?? event.data.callID ?? "");
        this.observer.toolCalled(sessionID);
        this.streamer.toolCalled(sessionID, callID, String(event.data.name ?? "tool"), event.data.input, turnHint);
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const callID = String(event.data.id ?? event.data.callID ?? "");
        this.streamer.toolFinished(sessionID, callID, event.type === "session.tool.success", turnHint);
        if (event.type === "session.tool.failed" && isBlockedToolFailure(event.data.error ?? event.data)) {
          this.streamer.blockedTool(sessionID, turnHint);
        }
        if (event.type === "session.tool.success") void this.relayAgentFiles(sessionID);
        break;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const child = this.childSessions.get(sessionID);
        if (child) {
          this.childSessions.delete(sessionID);
          const ok = event.type === "session.execution.succeeded";
          if (child.placement === "inline") {
            this.streamer.subagentFinished(child.parentID, child.agent, ok);
          } else if (child.placement === "message") {
            await this.background.finish(sessionID, ok);
          }
          log.info(`subagent ${child.agent} finished ${sessionID.slice(0, 16)}`);
          break;
        }
        this.admitted.delete(sessionID);
        if (await this.finishObservation(sessionID, event)) break;
        if (!this.streamer.has(sessionID)) break;
        const elapsed = this.streamer.elapsedMs(sessionID);
        const turnId = this.streamer.turnOf(sessionID);
        const type = event.type.replace("session.execution.", "");
        const reason = turnReason({
          type,
          data: event.data,
          stop: this.options.stops?.get(sessionID),
        });
        const stats = await this.turnStats(sessionID, elapsed);
        const resolved = sanitizeModelName(await resolveModelLabel(this.oc, sessionID, true));
        const model = resolved === UNKNOWN_MODEL ? this.streamer.modelOf(sessionID) : resolved;
        const blocked = this.streamer.blockedOf(sessionID);
        const footer = composeTurnFooter({
          reason,
          blockedTools: blocked,
          model,
          durationMs: stats.duration ?? elapsed,
          tps: stats.tps,
          contextTokens: stats.contextTokens,
          diagnostics: this.cfg.ui?.diagnostics === true,
          turnId,
        });
        if (signal.aborted) break;
        await this.streamer.end(sessionID, footer, turnId);
        await this.markTitle(sessionID, "done");
        if (event.type === "session.execution.succeeded") void this.relayAgentFiles(sessionID);
        log.info(`turn ${type} ${sessionID.slice(0, 16)}: ${reason ?? "ok"}${blocked ? ` · blocked=${blocked}` : ""}`);
        break;
      }
      case "permission.asked":
        await this.askPermission(event);
        break;
      case "form.replied":
        await this.settleForm(String(event.data.id), "✅ Ответ отправлен", event.data.answer as FormAnswer | undefined);
        break;
      case "form.cancelled":
        await this.settleForm(String(event.data.id), "⌛️ Форма отменена в OpenCode.");
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
        this.observer.setModel(sessionID, label);
        log.info(`model selected ${sessionID.slice(0, 16)} → ${label}`);
        break;
      }
      case "session.renamed": {
        const title = String(event.data.title ?? "").trim();
        // Every received rename is logged: it used to be invisible in the log.
        log.info(`session renamed evt: ${title || "(empty)"} ${sessionID.slice(0, 16)}`);
        if (!title) break;
        const state = this.titleState(sessionID, title);
        state.base = title;
        // state.json follows the session title even without a chat binding.
        this.store.upsert({ id: sessionID, title });
        await this.syncTopicTitle(sessionID, title);
        break;
      }
      default:
        break;
    }
  }

  private async ensureStream(sessionID: string, newTurn = false, hint?: string): Promise<void> {
    if (this.streamer.has(sessionID) || this.observer.has(sessionID)) return;
    // One fetch covers both checks: child sessions never get a block, and a
    // late event from a finished turn must not create an orphan placeholder
    // that stays at "thinking… 1s" forever.
    const session = await this.oc.getSession(sessionID).catch(() => undefined);
    if (!session || session.parentID) return;
    const busy = Number(session.time?.busy ?? 0) > Number(session.time?.idle ?? 0);
    if (!busy) return;
    const target = this.targetFor(sessionID);
    if (!target) return;
    const turnId = await this.streamer.begin(sessionID, target, await this.modelLabel(sessionID), newTurn, hint);
    if (turnId) log.info(`attached to running session ${sessionID.slice(0, 16)} turn=${turnId.slice(0, 12)}`);
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
    if (normalizeSubagentMode(this.cfg.showSubagents) === "off") return;
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

  /** Prompt submitted by this bot; the history fallback must not mirror it. */
  private rememberSelfPrompt(sessionID: string, text: string): void {
    const value = text.trim();
    if (!value) return;
    const entries = (this.selfPrompts.get(sessionID) ?? []).filter((entry) => Date.now() - entry.at < 2 * 60 * 1000);
    entries.push({ text: value, at: Date.now() });
    this.selfPrompts.set(sessionID, entries.slice(-10));
  }

  private isSelfPrompt(sessionID: string, text: string): boolean {
    const value = text.trim();
    if (!value) return false;
    const entries = this.selfPrompts.get(sessionID) ?? [];
    return entries.some((entry) => entry.text === value && Date.now() - entry.at < 2 * 60 * 1000);
  }

  /** Mirrors prompts sent from the desktop/TUI into the bound Telegram chat. */
  private async mirrorUserMessage(sessionID: string, item: unknown): Promise<void> {
    const envelope = item as {
      type?: string;
      id?: string;
      payload?: { text?: string; metadata?: Record<string, unknown>; files?: unknown[] };
    };
    if (!envelope || envelope.type !== "user") return;
    if (envelope.payload?.metadata?.source === "telegram") return;
    if (await this.isSubagent(sessionID)) return;
    const text = (envelope.payload?.text ?? "").trim();
    const media = mediaFromPayload(envelope);
    if (!text && !media.length) return;
    if (text && this.isSelfPrompt(sessionID, text)) {
      log.info(`mirror of own prompt skipped → ${sessionID.slice(0, 16)}`);
      return;
    }
    const target = this.targetFor(sessionID);
    if (!target) return;
    // History fallback and the SSE event may carry different item ids; a
    // repeated text within 20 s is the same prompt, not a new one.
    const previous = this.lastMirror.get(sessionID);
    if (text && previous && previous.text === text && Date.now() - previous.at < 20_000) {
      log.info(`mirror duplicate skipped → ${sessionID.slice(0, 16)}`);
      return;
    }
    if (!this.mirrorLedger.claim(sessionID, item)) {
      log.info(`mirror replay skipped (id=${mirrorKey(item) ?? "?"}) → ${sessionID.slice(0, 16)}`);
      return;
    }
    const options = target.threadId ? { message_thread_id: target.threadId } : {};
    if (text) {
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
      this.lastMirror.set(sessionID, { text, at: Date.now() });
    }
    this.mirroredAt.set(sessionID, Date.now());
    // Media must finish (first attempt + retries) before the answer starts, so
    // the mirrored attachments are always above the answer.
    await this.options.relay?.relayBeforeTurn(sessionID, media, "agent", undefined, undefined, 15_000);
    log.info(`mirror user → ${sessionID.slice(0, 16)}`);
  }

  /**
   * Safety net for a missed/reordered `session.inbox.enqueued`: mirrors the
   * newest user message from history before the answer stream begins. Telegram
   * prompts carry `metadata.source = "telegram"` and are never mirrored back.
   */
  private async mirrorLatestExternal(sessionID: string): Promise<void> {
    const mirrored = this.mirroredAt.get(sessionID) ?? 0;
    if (Date.now() - mirrored < 20_000) return;
    try {
      const messages = await this.oc.messages(sessionID, { limit: 6, order: "desc" });
      const last = messages.find((message) => message.type === "user");
      if (!last) return;
      const raw = last as unknown as Record<string, any>;
      if (raw.metadata?.source === "telegram") return;
      const created = Number(last.time?.created ?? 0);
      if (created && Date.now() - created > 120_000) return;
      const parts = Array.isArray(raw.content) ? (raw.content as Array<Record<string, any>>) : [];
      const fromParts = parts
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text))
        .join("\n");
      const text = String(last.text || fromParts || "").trim();
      const files = parts
        .filter((part) => part?.type === "file")
        .map((part) => ({ uri: part.uri ?? part.url ?? part.path, name: part.name ?? part.filename, mime: part.mime }));
      if (!text && !files.length) return;
      await this.mirrorUserMessage(sessionID, {
        type: "user",
        id: last.id,
        payload: { text, metadata: (raw.metadata as Record<string, unknown>) ?? {}, files },
      });
    } catch (error) {
      log.warn("mirror history fallback failed:", (error as Error).message);
    }
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

  /** `/recent` button: attach a private chat or open a forum topic for the session. */
  private async onRecentCallback(ctx: Context, sessionID: string): Promise<void> {
    const session = await this.oc.getSession(sessionID).catch(() => undefined);
    if (!session) {
      await ctx.editMessageText("⌛️ Сессия не найдена.").catch(() => undefined);
      return;
    }
    const chat = ctx.chat;
    const isForum = Boolean(chat && (chat as { is_forum?: boolean }).is_forum) && chat?.type === "supergroup";
    if (isForum && chat) {
      const existing = this.store.session[sessionID];
      if (existing?.threadId && existing.chatId === chat.id) {
        try {
          await this.bot.api.sendMessage(chat.id, "🗂 Тема этой сессии:", { message_thread_id: existing.threadId });
          await ctx.editMessageText(`🗂 Сессия уже в теме «${escape(existing.title ?? session.title)}».`, {
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
    if (chat) {
      this.store.bindChat(chat.id, sessionID);
      this.store.upsert({ id: sessionID, title: session.title, chatId: chat.id });
    }
    await ctx.editMessageText(
      `🔗 Подключено: <b>${escape(session.title)}</b>\n<code>${session.id}</code>\n📁 <code>${escape(session.location?.directory ?? "?")}</code>`,
      { parse_mode: "HTML" },
    );
  }

  /** Budget/warning text from the central tracker. */
  async sendSessionText(sessionID: string, text: string): Promise<boolean> {
    const target = this.targetFor(sessionID);
    if (!target) return false;
    try {
      await this.bot.api.sendMessage(target.chatId, text, {
        ...(target.threadId ? { message_thread_id: target.threadId } : {}),
      });
      return true;
    } catch (error) {
      log.warn("send session text failed:", (error as Error).message);
      return false;
    }
  }

  // ------------------------------------------------------------------ titles

  /** Title state of a session; created lazily from the event/store title. */
  private titleState(sessionID: string, title?: string): TelegramTitle {
    let state = this.titles.get(sessionID);
    if (!state) {
      const base = (title || this.store.session[sessionID]?.title || sessionID.slice(0, 12)).trim();
      state = { base, phase: "idle", lastRename: 0, version: 0, icon: null };
      this.titles.set(sessionID, state);
    }
    return state;
  }

  /**
   * Keeps the bound topic name in sync with `session.renamed`.
   *
   * - the General chat and chats without a topic are never renamed;
   * - an unchanged name is skipped (no "renamed the topic" service messages);
   * - `titleStatus: rename` keeps the ⏳/✅ marker, icon mode keeps the icon
   *   untouched (`editForumTopic` with `name` only never resets it);
   * - Telegram allows ~1 rename per 60 s, so a change inside the window is
   *   deferred instead of dropped.
   */
  private async syncTopicTitle(sessionID: string, title: string): Promise<void> {
    if (this.appliedTitles.get(sessionID) === title) return; // our own echo
    const target = this.targetFor(sessionID);
    if (!target?.threadId || target.threadId <= 1) return; // General is never renamed
    const mode = normalizeTitleStatus(this.cfg.ui?.titleStatus);
    const state = this.titleState(sessionID, title);
    const name = syncTitleName(title, mode, state.phase);
    if (sameTitleName(state.appliedName, name)) return; // already on the topic
    const wait = renameWait(state.lastRename);
    if (wait > 0) {
      this.deferTopicRename(sessionID, title, wait);
      return;
    }
    await this.applyTopicRename(sessionID, title, name);
  }

  private deferTopicRename(sessionID: string, title: string, wait: number): void {
    if (this.renameTimers.has(sessionID)) return;
    log.info(`topic rename deferred ${Math.ceil(wait / 1000)}s for ${sessionID.slice(0, 16)}`);
    const timer = setTimeout(() => {
      this.renameTimers.delete(sessionID);
      void this.syncTopicTitle(sessionID, title).catch((error) =>
        log.warn("topic rename retry failed:", (error as Error).message),
      );
    }, wait + 500);
    timer.unref?.();
    this.renameTimers.set(sessionID, timer);
  }

  private async applyTopicRename(sessionID: string, title: string, name: string): Promise<void> {
    const target = this.targetFor(sessionID);
    if (!target?.threadId) return;
    try {
      await this.bot.api.editForumTopic(target.chatId, target.threadId, { name });
      const state = this.titleState(sessionID, title);
      state.lastRename = Date.now();
      state.appliedName = name;
      this.appliedTitles.set(sessionID, title);
      log.info(`session renamed → topic: ${title}`);
    } catch (error) {
      log.warn("topic rename failed:", (error as Error).message);
    }
  }

  /**
   * Turn status on a forum topic.
   *
   * `ui.titleStatus`:
   * - `icon` (default) - the topic icon becomes ⏳ while the turn runs and ✅
   *   when it ends, then the default icon is restored after ~10 s. Icons do
   *   not post "renamed the topic" service messages;
   * - `rename` (opt-in) - legacy behaviour: `⏳ title` on start, `✅ title` on
   *   success and the original after ~10 s (each rename posts a service
   *   message; Telegram rate-limits renames to one per 60 s);
   * - `off` - nothing.
   */
  private async markTitle(sessionID: string, phase: "start" | "done"): Promise<void> {
    const mode = normalizeTitleStatus(this.cfg.ui?.titleStatus);
    if (mode === "off") return;
    const target = this.targetFor(sessionID);
    if (!target?.threadId) return;
    let state = this.titles.get(sessionID);
    if (!state) {
      const meta = await this.sessionMeta(sessionID);
      const base = (meta.title || this.store.session[sessionID]?.title || sessionID.slice(0, 12)).trim();
      state = { base, phase: "idle", lastRename: 0, version: 0, icon: null };
      this.titles.set(sessionID, state);
    }
    if (mode === "icon") {
      await this.markIcon(sessionID, state, phase);
      return;
    }
    if (phase === "start") {
      state.phase = "start";
      state.version += 1;
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      if (!canRename(state.lastRename)) return;
      if (await this.setTopicTitle(sessionID, titleWithMarker(state.base, "start"))) state.lastRename = Date.now();
      return;
    }
    if (state.phase !== "start") return;
    state.phase = "done";
    const version = state.version;
    // A short turn restores the name directly: renaming to ✅ and back within a
    // few seconds produced the double service message users complained about.
    const shortTurn = Date.now() - state.lastRename < 10_000;
    if (!shortTurn && canRename(state.lastRename)) {
      if (await this.setTopicTitle(sessionID, titleWithMarker(state.base, "done"))) state.lastRename = Date.now();
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.restoreTitle(sessionID, version), 10_000);
    state.timer.unref?.();
  }

  private async markIcon(sessionID: string, state: TelegramTitle, phase: "start" | "done"): Promise<void> {
    if (phase === "start") {
      state.phase = "start";
      state.version += 1;
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      if (state.icon === "start") return;
      const id = await this.topicIcon("start");
      if (!id) return;
      if (await this.setTopicIcon(sessionID, id)) {
        state.icon = "start";
        state.lastIconAt = Date.now();
      }
      return;
    }
    if (state.phase !== "start") return;
    state.phase = "done";
    const version = state.version;
    // Turns shorter than a second or two are not worth a second icon request.
    if (Date.now() - (state.lastIconAt ?? 0) >= 1_500) {
      const id = await this.topicIcon("done");
      if (id && (await this.setTopicIcon(sessionID, id))) {
        state.icon = "done";
        state.lastIconAt = Date.now();
      }
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.restoreIcon(sessionID, version), 10_000);
    state.timer.unref?.();
  }

  private async restoreIcon(sessionID: string, version: number): Promise<void> {
    const state = this.titles.get(sessionID);
    if (!state || state.version !== version || state.phase !== "done") return;
    state.timer = undefined;
    state.phase = "idle";
    // Empty string = back to the default (pencil) topic icon.
    if (await this.setTopicIcon(sessionID, "")) state.icon = null;
  }

  /** Resolves the standard forum icon ids once; failures degrade to no icon. */
  private async topicIcon(phase: "start" | "done"): Promise<string | undefined> {
    if (this.topicIcons && (this.topicIcons.start || this.topicIcons.done)) return this.topicIcons[phase];
    // Retry a failed lookup after 10 minutes; a transient network error must not
    // disable the status marker for the whole process lifetime.
    if (this.topicIconsFailedAt && Date.now() - this.topicIconsFailedAt < 10 * 60_000) return undefined;
    try {
      const stickers = await this.bot.api.getForumTopicIconStickers();
      this.topicIcons = {
        start: pickTopicIcon(stickers, "start"),
        done: pickTopicIcon(stickers, "done"),
      };
      this.topicIconsFailedAt = 0;
      if (!this.topicIcons.start || !this.topicIcons.done) {
        log.warn("topic icons: standard pack has no hourglass/check emoji, icon status disabled");
      }
    } catch (error) {
      this.topicIconsFailedAt = Date.now();
      log.warn("topic icons unavailable:", (error as Error).message);
      return undefined;
    }
    return this.topicIcons?.[phase];
  }

  private async setTopicIcon(sessionID: string, iconCustomEmojiId: string): Promise<boolean> {
    const target = this.targetFor(sessionID);
    if (!target?.threadId) return false;
    try {
      await this.bot.api.editForumTopic(target.chatId, target.threadId, { icon_custom_emoji_id: iconCustomEmojiId });
      return true;
    } catch (error) {
      log.debug("topic icon:", (error as Error).message);
      return false;
    }
  }

  private async restoreTitle(sessionID: string, version: number): Promise<void> {
    const state = this.titles.get(sessionID);
    if (!state || state.version !== version || state.phase !== "done") return;
    state.timer = undefined;
    const wait = renameWait(state.lastRename);
    if (wait > 0) {
      state.timer = setTimeout(() => void this.restoreTitle(sessionID, version), wait + 500);
      state.timer.unref?.();
      return;
    }
    state.phase = "idle";
    if (await this.setTopicTitle(sessionID, titleWithMarker(state.base, "idle"))) state.lastRename = Date.now();
  }

  private async setTopicTitle(sessionID: string, name: string): Promise<boolean> {
    const target = this.targetFor(sessionID);
    if (!target?.threadId) return false;
    const clean = titleWithMarker(name, "idle");
    try {
      await this.bot.api.editForumTopic(target.chatId, target.threadId, { name: clean });
      const state = this.titles.get(sessionID);
      if (state) state.appliedName = clean;
      return true;
    } catch (error) {
      log.debug("topic title:", (error as Error).message);
      return false;
    }
  }

  // ------------------------------------------------------------------- forms
  /** Renders a pending form as one message: question text + inline options. */
  private async askForm(form: FormInfo | undefined): Promise<void> {
    if (!form?.id || !Array.isArray(form.fields) || !isChatRenderable(form)) return;
    if (this.findForm(form.id)) return;
    const sessionID = String(form.sessionID ?? "");
    const target = this.targetFor(sessionID);
    if (!target) {
      log.info(`form ${form.id.slice(0, 12)} for a session without a chat binding`);
      return;
    }
    const state: TelegramForm = {
      token: Math.random().toString(36).slice(2, 8),
      form,
      createdAt: Date.now(),
      chatId: target.chatId,
      threadId: target.threadId,
      messageId: 0,
      values: defaultValues(form),
      done: new Set(),
      page: 0,
    };
    this.forms.set(state.token, state);
    this.seenForms.set(form.id, Date.now());
    const view = this.formView(state);
    try {
      const message = await this.bot.api.sendMessage(target.chatId, view.text, {
        parse_mode: "HTML",
        reply_markup: view.keyboard,
        ...(target.threadId ? { message_thread_id: target.threadId } : {}),
      });
      state.messageId = message.message_id;
      log.info(`form ${form.id.slice(0, 12)} (${String(form.metadata?.kind ?? "?")}) → chat ${target.chatId}`);
      if (!nextField(activeFields(form, state.values), state.values, state.done)) await this.submitForm(state);
    } catch (error) {
      this.forms.delete(state.token);
      log.warn("form message failed:", (error as Error).message);
    }
  }

  private findForm(formID: string): TelegramForm | undefined {
    for (const state of this.forms.values()) if (state.form.id === formID) return state;
    return undefined;
  }

  private formView(state: TelegramForm): { text: string; keyboard: InlineKeyboard } {
    const fields = activeFields(state.form, state.values);
    const field = nextField(fields, state.values, state.done);
    const lines = [`❓ <b>${escape((state.form.title || "Вопрос").slice(0, 200))}</b>`];
    const message = String(state.form.metadata?.message ?? "").trim().slice(0, 300);
    if (message) lines.push(`<i>${escape(message)}</i>`);
    lines.push("");
    if (!field) {
      lines.push("Все вопросы отвечены — отправляю…");
      return { text: lines.join("\n"), keyboard: new InlineKeyboard() };
    }
    const index = fields.findIndex((item) => item.key === field.key) + 1;
    lines.push(`<b>${index}/${fields.length}</b> · <b>${escape(fieldTitle(field).slice(0, 120))}</b>`);
    if (field.description) lines.push(escape(field.description.slice(0, 300)));
    if (field.type === "external") lines.push(`🔗 ${escape(field.url.slice(0, 200))}`);
    const hint = fieldHint(field);
    if (hint) lines.push(`<i>${escape(hint)}</i>`);
    if (state.awaitText === field.key) lines.push("", "✍️ Отправьте ответ текстом следующим сообщением.");
    return { text: lines.join("\n"), keyboard: this.formKeyboard(state, field) };
  }

  /** Option buttons; multi-select toggles with «Готово», long lists paginate. */
  private formKeyboard(state: TelegramForm, field: FormField): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    const token = state.token;
    const widget = fieldWidget(field);
    if (widget === "choice" || widget === "multi") {
      const options = "options" in field && Array.isArray(field.options) ? field.options : [];
      const selected = Array.isArray(state.values[field.key]) ? (state.values[field.key] as string[]) : [];
      const pageSize = 8;
      const pages = Math.max(1, Math.ceil(options.length / pageSize));
      const page = Math.min(Math.max(0, state.page), pages - 1);
      const slice = options.slice(page * pageSize, (page + 1) * pageSize);
      slice.forEach((option, index) => {
        const absolute = page * pageSize + index;
        const mark = selected.includes(option.value) ? "🔹 " : "";
        const action = widget === "multi" ? "toggle" : "pick";
        keyboard.text(`${mark}${option.label}`.slice(0, 60), `form:${token}:${action}:${absolute}`);
        if (index % 2 === 1) keyboard.row();
      });
      if (slice.length % 2 === 1) keyboard.row();
      if (pages > 1) {
        keyboard
          .text("◀", `form:${token}:page:${(page - 1 + pages) % pages}`)
          .text(`${page + 1}/${pages}`, `form:${token}:noop`)
          .text("▶", `form:${token}:page:${(page + 1) % pages}`)
          .row();
      }
      if (widget === "multi") keyboard.text("✅ Готово", `form:${token}:done`).row();
      if ("custom" in field && field.custom) keyboard.text("✍️ Свой ответ", `form:${token}:custom`).row();
    }
    if (widget === "flag") {
      keyboard.text("✅ Да", `form:${token}:flag:1`).text("❌ Нет", `form:${token}:flag:0`).row();
    }
    if (widget === "text" || widget === "number") {
      keyboard.text("✍️ Ввести ответ", `form:${token}:custom`).row();
    }
    if (!field.required) keyboard.text("⏭ Пропустить", `form:${token}:skip`).row();
    keyboard.text("✖️ Отменить форму", `form:${token}:cancel`);
    return keyboard;
  }

  private async onFormCallback(ctx: Context, token: string, action: string, arg?: string): Promise<void> {
    const state = this.forms.get(token);
    if (!state) {
      if (action !== "noop") await ctx.editMessageText("⌛️ Форма устарела — ответьте в OpenCode.").catch(() => undefined);
      return;
    }
    if (Date.now() - state.createdAt > FORM_TTL_MS && action !== "noop") {
      await this.expireForm(state);
      return;
    }
    if (action === "noop") return;
    if (action === "cancel") {
      this.forms.delete(token);
      await this.finishForm(state, `✖️ <b>Форма отменена</b>\n<i>${escape(state.form.title)}</i>`);
      await this.oc
        .cancelForm(state.form.sessionID, state.form.id, "Отменено в Telegram")
        .catch((error) => log.warn("form cancel:", (error as Error).message));
      return;
    }

    const fields = activeFields(state.form, state.values);
    let field = nextField(fields, state.values, state.done);
    if (!field) {
      await this.submitForm(state);
      return;
    }
    const options = "options" in field && Array.isArray(field.options) ? field.options : [];
    switch (action) {
      case "pick": {
        const option = options[Number(arg)];
        if (!option) return;
        state.values[field.key] = option.value;
        state.done.add(field.key);
        state.page = 0;
        state.awaitText = undefined;
        break;
      }
      case "toggle": {
        const option = options[Number(arg)];
        if (!option) return;
        const current = Array.isArray(state.values[field.key]) ? [...(state.values[field.key] as string[])] : [];
        const at = current.indexOf(option.value);
        if (at >= 0) current.splice(at, 1);
        else current.push(option.value);
        state.values[field.key] = current;
        state.awaitText = undefined;
        break;
      }
      case "done": {
        const value = state.values[field.key];
        if (!Array.isArray(value) || value.length === 0) {
          await ctx.answerCallbackQuery({ text: "Выберите хотя бы один вариант." }).catch(() => undefined);
          return;
        }
        state.done.add(field.key);
        state.page = 0;
        break;
      }
      case "flag": {
        state.values[field.key] = arg === "1";
        state.done.add(field.key);
        break;
      }
      case "page": {
        state.page = Math.max(0, Number(arg) || 0);
        break;
      }
      case "custom": {
        state.awaitText = field.key;
        break;
      }
      case "skip": {
        delete state.values[field.key];
        state.done.add(field.key);
        state.page = 0;
        state.awaitText = undefined;
        break;
      }
      default:
        return;
    }
    await this.advanceForm(state);
  }

  /** Typed answers for text/number fields and «Свой ответ». */
  private async handleFormText(ctx: Context, text: string): Promise<boolean> {
    if (!text || text.startsWith("/")) return false;
    const chatId = ctx.chat?.id;
    if (!chatId) return false;
    const threadId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
    let state: TelegramForm | undefined;
    for (const candidate of this.forms.values()) {
      if (candidate.chatId !== chatId) continue;
      if ((candidate.threadId ?? 0) !== (threadId ?? 0)) continue;
      if (candidate.awaitText) {
        state = candidate;
        break;
      }
    }
    if (!state) return false;
    if (Date.now() - state.createdAt > FORM_TTL_MS) {
      await this.expireForm(state);
      return true;
    }
    const fields = activeFields(state.form, state.values);
    const field = fields.find((item) => item.key === state!.awaitText);
    if (!field) {
      state.awaitText = undefined;
      return false;
    }
    if (field.type === "multiselect") {
      const current = Array.isArray(state.values[field.key]) ? [...(state.values[field.key] as string[])] : [];
      const value = text.trim();
      if (value && !current.includes(value)) current.push(value);
      state.values[field.key] = current;
    } else {
      const parsed = parseText(field, text);
      if (parsed.error) {
        await ctx.reply(`⚠️ ${parsed.error}`).catch(() => undefined);
        return true;
      }
      if (parsed.value === undefined) delete state.values[field.key];
      else state.values[field.key] = parsed.value;
    }
    state.done.add(field.key);
    state.awaitText = undefined;
    await this.advanceForm(state);
    return true;
  }

  private async advanceForm(state: TelegramForm): Promise<void> {
    const fields = activeFields(state.form, state.values);
    if (!nextField(fields, state.values, state.done)) {
      await this.submitForm(state);
      return;
    }
    await this.renderForm(state);
  }

  private async submitForm(state: TelegramForm): Promise<void> {
    const fields = activeFields(state.form, state.values);
    const { answer, error } = buildAnswer(fields, state.values);
    if (!answer) {
      await this.renderForm(state, error);
      return;
    }
    try {
      await this.oc.replyForm(state.form.sessionID, state.form.id, answer);
    } catch (failure) {
      const message = (failure as Error).message;
      if (/\b(404|409)\b/.test(message)) {
        this.forms.delete(state.token);
        await this.finishForm(state, `⌛️ <b>Форма устарела</b> — ответьте в OpenCode.\n<i>${escape(state.form.title)}</i>`);
      } else {
        log.warn("form reply:", message);
        await this.renderForm(state, `⚠️ ${message.slice(0, 200)}`);
      }
      return;
    }
    this.forms.delete(state.token);
    const lines = [`✅ <b>Ответ отправлен</b>`, `<i>${escape(state.form.title)}</i>`, ""];
    for (const row of summarize(state.form, answer).slice(0, 20)) lines.push(`• ${escape(row.slice(0, 300))}`);
    await this.finishForm(state, lines.join("\n"));
    log.info(`form ${state.form.id.slice(0, 12)} answered`);
  }

  private async renderForm(state: TelegramForm, note?: string): Promise<void> {
    const view = this.formView(state);
    const text = note ? `${view.text}\n\n⚠️ ${escape(note)}` : view.text;
    try {
      await this.bot.api.editMessageText(state.chatId, state.messageId, text, {
        parse_mode: "HTML",
        reply_markup: view.keyboard,
      });
    } catch (error) {
      log.debug("form edit failed:", (error as Error).message);
    }
  }

  private async finishForm(state: TelegramForm, text: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(state.chatId, state.messageId, text, { parse_mode: "HTML" });
    } catch (error) {
      log.debug("form final edit failed:", (error as Error).message);
    }
  }

  private async expireForm(state: TelegramForm): Promise<void> {
    this.forms.delete(state.token);
    await this.finishForm(
      state,
      `⌛️ <b>Форма устарела</b> — ответьте в OpenCode.\n<i>${escape(state.form.title)}</i>`,
    );
  }

  /** `form.replied` / `form.cancelled` from Desktop or the TUI. */
  private async settleForm(formID: string, label: string, answer?: FormAnswer): Promise<void> {
    for (const state of [...this.forms.values()]) {
      if (state.form.id !== formID) continue;
      this.forms.delete(state.token);
      const lines = [label, `<i>${escape(state.form.title)}</i>`];
      if (answer) {
        const rows = summarize(state.form, answer);
        if (rows.length) lines.push("", ...rows.slice(0, 20).map((row) => `• ${escape(row.slice(0, 300))}`));
      }
      await this.finishForm(state, lines.join("\n"));
    }
  }

  /** Polls bound sessions for forms whose ephemeral event was missed. */
  private async tickForms(): Promise<void> {
    const now = Date.now();
    for (const state of [...this.forms.values()]) {
      if (now - state.createdAt > FORM_TTL_MS) await this.expireForm(state);
    }
    for (const [formID, at] of this.seenForms) {
      if (now - at > 60 * 60_000) this.seenForms.delete(formID);
    }
    let scanned = 0;
    for (const sessionID of Object.keys(this.store.session)) {
      if (scanned >= 20) break;
      if (!this.targetFor(sessionID)) continue;
      scanned += 1;
      const forms = await this.oc.listForms(sessionID).catch(() => []);
      for (const form of forms) {
        if (this.findForm(form.id)) continue;
        const attempted = this.seenForms.get(form.id) ?? 0;
        if (now - attempted < 5 * 60_000) continue;
        await this.askForm(form);
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  /** Remembers the name a freshly created topic already carries. */
  private rememberTopicName(sessionID: string, title: string): void {
    const clean = String(title ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.appliedTitles.set(sessionID, clean);
    this.titleState(sessionID, clean).appliedName = titleWithMarker(clean, "idle");
  }

  private async openTopicForSession(chatId: number, session: OcSession): Promise<{ threadId: number; title: string }> {
    const title = (session.title || session.id.slice(0, 12)).replace(/\s+/g, " ").trim().slice(0, 60) || "OpenCode";
    const topic = await this.bot.api.createForumTopic(chatId, title);
    this.store.bindThread(topic.message_thread_id, session.id);
    this.store.upsert({ id: session.id, title: session.title, chatId, threadId: topic.message_thread_id });
    this.rememberTopicName(session.id, title);
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
        permissions: rulesForMode(this.cfg.permissions?.mode ?? "ask"),
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
      permissions: rulesForMode(this.cfg.permissions?.mode ?? "ask"),
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
