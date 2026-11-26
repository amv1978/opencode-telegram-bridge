import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyInstallerOverrides,
  isDiscordConfigured,
  loadConfig,
  resolvePaths,
  saveConfig,
  transportFingerprint,
  type BridgeConfig,
  type DiscordConfig,
} from "./config.ts";
import pkg from "../package.json";
import { initLog, log } from "./log.ts";
import { discover, OcClient } from "./opencode/client.ts";
import { Store } from "./state/store.ts";
import { Bridge } from "./telegram/bot.ts";
import { setupTelegramNetwork, type TelegramNet } from "./telegram/net.ts";
import { DiscordBridge } from "./discord/adapter.ts";
import { MediaRelay } from "./media/relay.ts";
import { Updater, createUpdateFetch, type UpdateCache } from "./updater.ts";
import { autoAction, type UpdateProblem } from "./update/policy.ts";
import { changelogBetween } from "./changelog.ts";
import { BudgetTracker, type BudgetSnapshot } from "./budget.ts";
import { isPermissionMode } from "./permissions.ts";
import { StopRegistry } from "./stops.ts";
import { formatUptime, type BridgeRuntimeInfo } from "./status.ts";
import { normalizeSubagentMode, isSubagentMode } from "./subagents.ts";

export type BotState = "stopped" | "starting" | "running" | "error";

export interface Snapshot {
  version: string;
  configured: boolean;
  telegramEnabled: boolean;
  state: BotState;
  error: string;
  username: string;
  telegramMode: string;
  ocVersion: string;
  ocUrl: string;
  startedAt: number;
  config: {
    mode: BridgeConfig["mode"];
    topicsChatId?: number;
    defaultDirectory?: string;
    editIntervalMs: number;
    showTools: BridgeConfig["stream"]["showTools"];
    format: "rich" | "html";
    autoTopics: boolean;
    showSubagents: "auto" | "inline" | "message" | "off";
    media: { relay: "none" | "user" | "all"; maxPhotoMb: number };
    update: { checkOnStart: boolean; intervalHours: number; autoDownload: boolean };
    notify: { enabled: boolean; targets: "admin" | "all" | string[] };
    ui: {
      theme: "opencode" | "matrix";
      scheme: "system" | "light" | "dark";
      lang: "system" | "ru" | "en";
      titleStatus: "icon" | "rename" | "off";
      diagnostics: boolean;
      seenChangelog: string[];
    };
    proxy?: string;
    apiIp?: string;
    allowedUsers: Array<{ id: number; role?: string; name?: string }>;
    hasToken: boolean;
    tokenTail: string;
  };
  discord: {
    enabled: boolean;
    configured: boolean;
    state: string;
    error: string;
    username: string;
    tokenTail: string;
    retryAt: number;
    attempt: number;
    allowedGuilds: string[];
    allowedUsers: string[];
    titleStatus: "off" | "rename";
  };
  webPort: number;
  autostart: boolean;
  autostartSupported: boolean;
  configPath: string;
  sessions: Array<{ id: string; title: string; directory?: string; active?: boolean; updatedAt?: number }>;
  /** Sessions hidden from the panel list (still exist in OpenCode). */
  hiddenSessions: string[];
  /** Doctor warnings (stalled prompts, etc.) shown in the panel. */
  warnings: string[];
  /** Delivery counters: 429 retries, lost sends/edits, suppressed mirror replays. */
  delivery: { retries: number; lost: number; duplicatesSuppressed: number };
  update: ReturnType<Updater["snapshot"]>;
}

export class App {
  readonly paths = resolvePaths();
  cfg: BridgeConfig;
  readonly store: Store;
  private client?: OcClient;
  private bridge?: Bridge;
  private discord?: DiscordBridge;
  private relay?: MediaRelay;
  readonly updater: Updater;
  private updateTimer?: ReturnType<typeof setInterval>;
  private net?: TelegramNet;
  private state: BotState = "stopped";
  private error = "";
  private username = "";
  private startedAt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private discordRetryTimer?: ReturnType<typeof setTimeout>;
  private discordState = "off";
  private discordError = "";
  private discordRetryAt = 0;
  private discordRetryAttempt = 0;
  private ocVersion = "";
  private ocUrl = "";
  private webPort?: number;
  private budget?: BudgetTracker;
  private readonly stops = new StopRegistry();
  private budgetUnsub?: () => void;
  private budgetTimer?: ReturnType<typeof setInterval>;
  private budgetChain: Promise<void> = Promise.resolve();
  private lastStartNotice = 0;
  private lastFailureNotice = 0;
  private suppressLifecycleNotice = false;
  /** Incremented by stopBot; a stale start must not resurrect adapters. */
  private lifecycle = 0;
  /** Sessions with `execution.started` and no end event yet (pauses downloads). */
  private readonly activeTurns = new Map<string, number>();
  private lastUpdateErrorNotice = 0;

  constructor() {
    initLog(this.paths.logFile);
    const configExisted = existsSync(this.paths.configFile);
    this.cfg = loadConfig(this.paths);
    applyInstallerOverrides(this.paths, this.cfg, configExisted);
    this.store = new Store(this.paths.stateFile);
    this.updater = new Updater({
      packaged: isCompiled(),
      dataDir: dirname(this.paths.configFile),
      installDir: dirname(process.execPath),
      port: () => this.webPort ?? this.cfg.web.port,
      fetch: () => this.updateFetch(),
      busy: () => this.turnActive(),
      onCache: (cache) => this.store.setUpdateCache(cache as unknown as Record<string, unknown>),
      onBeforeInstall: (previous) => this.store.setPrevVersion(previous),
      notify: (text) => this.notify(text),
      onError: (problem) => void this.notifyUpdateProblem(problem),
    });
    this.updater.restore(this.store.updateCache() as UpdateCache | undefined, this.store.getPrevVersion());
  }

  snapshot(): Snapshot {
    const ds = this.discord?.status;
    const discordOn = Boolean(this.cfg.discord?.enabled) && isDiscordConfigured(this.cfg);
    return {
      version: pkg.version,
      configured: Boolean(this.cfg.telegram.token),
      telegramEnabled: this.cfg.telegram.enabled !== false,
      state: this.state,
      error: this.error,
      username: this.username,
      telegramMode: this.net?.mode ?? "",
      ocVersion: this.ocVersion,
      ocUrl: this.ocUrl,
      startedAt: this.startedAt,
      config: {
        mode: this.cfg.mode,
        topicsChatId: this.cfg.topicsChatId,
        defaultDirectory: this.cfg.defaultDirectory,
        editIntervalMs: this.cfg.stream.editIntervalMs,
        showTools: this.cfg.stream.showTools,
        format: this.cfg.stream.format ?? "rich",
        autoTopics: this.cfg.autoTopics !== false,
        showSubagents: normalizeSubagentMode(this.cfg.showSubagents),
        media: {
          relay: this.cfg.media?.relay ?? "all",
          maxPhotoMb: this.cfg.media?.maxPhotoMb ?? 10,
        },
        update: {
          checkOnStart: this.cfg.update?.checkOnStart !== false,
          intervalHours: this.cfg.update?.intervalHours ?? 6,
          autoDownload: this.cfg.update?.autoDownload !== false,
        },
        notify: {
          enabled: this.cfg.notify?.enabled !== false,
          targets: this.cfg.notify?.targets ?? "admin",
        },
        ui: {
          theme: this.cfg.ui?.theme ?? "opencode",
          scheme: this.cfg.ui?.scheme ?? "system",
          lang: this.cfg.ui?.lang ?? "system",
          titleStatus: this.cfg.ui?.titleStatus ?? "icon",
          diagnostics: this.cfg.ui?.diagnostics === true,
          seenChangelog: this.cfg.ui?.seenChangelog ?? [],
        },
        proxy: this.cfg.telegram.proxy,
        apiIp: this.cfg.telegram.apiIp,
        allowedUsers: this.cfg.telegram.allowedUsers,
        hasToken: Boolean(this.cfg.telegram.token),
        tokenTail: this.cfg.telegram.token ? `…${this.cfg.telegram.token.slice(-4)}` : "",
      },
      discord: {
        enabled: Boolean(this.cfg.discord?.enabled),
        configured: isDiscordConfigured(this.cfg),
        state: discordOn ? (ds?.state ?? this.discordState) : "off",
        error: discordOn ? (ds?.error || this.discordError) : "",
        username: ds?.username ?? "",
        tokenTail: this.cfg.discord?.token ? `…${this.cfg.discord.token.slice(-4)}` : "",
        retryAt: discordOn ? (ds ? (ds.state === "retrying" ? ds.retryAt : 0) : this.discordRetryAt) : 0,
        attempt: ds?.attempt ?? this.discordRetryAttempt,
        allowedGuilds: this.cfg.discord?.allowedGuilds ?? [],
        allowedUsers: this.cfg.discord?.allowedUsers ?? [],
        titleStatus: this.cfg.discord?.titleStatus === "rename" ? "rename" : "off",
      },
      webPort: this.webPort ?? this.cfg.web.port,
      autostart: isAutostartEnabled(),
      autostartSupported: process.platform === "win32" && isCompiled(),
      configPath: this.paths.configFile,
      sessions: [],
      hiddenSessions: this.store.hiddenSessions(),
      warnings: this.bridge?.warnings() ?? [],
      delivery: this.deliveryStats(),
      update: this.updater.snapshot(),
    };
  }

  async startBot(): Promise<void> {
    if (this.state === "running" || this.state === "starting") return;
    if (!this.telegramOn() && !isDiscordConfigured(this.cfg)) {
      throw new Error("Нет активных адаптеров: включите Telegram (нужен токен) или Discord");
    }
    const run = ++this.lifecycle;
    this.state = "starting";
    this.error = "";
    try {
      const endpoint = await discover(this.cfg.opencode);
      if (run !== this.lifecycle) {
        await this.cleanupStart();
        return;
      }
      this.client = new OcClient(endpoint.baseUrl, endpoint.password);
      this.ocUrl = endpoint.baseUrl;
      this.ocVersion = (await this.client.info()).version;
      if (run !== this.lifecycle) {
        await this.cleanupStart();
        return;
      }
      this.startBudget();
      this.relay = new MediaRelay({
        store: this.store,
        media: () => this.cfg.media ?? { relay: "all", maxPhotoMb: 10 },
        topicsChatId: () => this.cfg.topicsChatId,
        sessionDir: async (sessionID) => {
          try {
            return (await this.client?.getSession(sessionID))?.location?.directory;
          } catch {
            return undefined;
          }
        },
        senders: {
          telegram: {
            send: (target, item, limits) => this.bridge?.sendMedia(target, item, limits) ?? Promise.resolve(),
            sendText: (target, text) => this.bridge?.sendRelayText(target, text) ?? Promise.resolve(),
          },
          discord: {
            send: (target, item, limits) => this.discord?.sendMedia(target, item, limits) ?? Promise.resolve(),
            sendText: (target, text) => this.discord?.sendRelayText(target, text) ?? Promise.resolve(),
          },
        },
      });

      if (this.telegramOn()) await this.startTelegram();
      if (run !== this.lifecycle) {
        await this.cleanupStart();
        return;
      }
      // Discord may be slow or temporarily unreachable; Telegram must not wait
      // for its login retries (up to ~7 min) before the panel says "running".
      void this.startDiscord();
      if (run !== this.lifecycle) {
        await this.cleanupStart();
        return;
      }
      this.state = "running";
      this.startedAt = Date.now();
      this.startUpdateLoop();
      log.info("bridge running");
      // Discord logs in asynchronously; give it a moment so the start notice
      // can name both bots. 2-minute debounce keeps reconnect loops quiet.
      const noticeTimer = setTimeout(() => void this.sendStartNotice(), 2500);
      noticeTimer.unref?.();
    } catch (error) {
      if (run !== this.lifecycle) {
        await this.cleanupStart();
        return;
      }
      this.state = "error";
      this.error = (error as Error).message;
      log.error("start failed:", this.error);
      void this.sendFailureNotice(this.error);
      this.stopBudget();
      await this.bridge?.stop().catch(() => undefined);
      await this.discord?.stop().catch(() => undefined);
      this.net?.stop();
      this.bridge = undefined;
      this.discord = undefined;
      this.net = undefined;
      this.scheduleRetry();
      throw error;
    }
  }

  /** Telegram runs only when its toggle is on and a token exists. */
  private telegramOn(): boolean {
    return this.cfg.telegram.enabled !== false && Boolean(this.cfg.telegram.token);
  }

  /** A start cancelled by Stop must not leave half-started adapters behind. */
  private async cleanupStart(): Promise<void> {
    this.stopBudget();
    await this.bridge?.stop().catch(() => undefined);
    await this.discord?.stop().catch(() => undefined);
    this.net?.stop();
    this.bridge = undefined;
    this.discord = undefined;
    this.net = undefined;
    this.relay = undefined;
    this.client = undefined;
  }

  /** Starts the Telegram adapter alone (Discord is started separately). */
  private async startTelegram(): Promise<void> {
    if (!this.client || this.bridge || !this.telegramOn()) return;
    this.net = await this.connectTelegram();
    this.bridge = new Bridge(this.cfg, this.client, this.store, {
      fetch: this.net.fetch,
      relay: this.relay,
      budget: () => this.budgetSnapshot(),
      stops: this.stops,
      onConfigChange: () => saveConfig(this.paths, this.cfg),
      onPollingError: (message) => {
        if (/409/.test(message)) {
          this.error = "Другой экземпляр бота уже запущен (409 Conflict). Закройте его в диспетчере задач.";
          log.error(this.error);
        }
      },
      runtime: () => this.runtimeInfo(),
    });
    this.username = await this.bridge.start();
  }

  /** Budget caps are enforced centrally, independently of Telegram/Discord. */
  private startBudget(): void {
    if (!this.client || this.budget) return;
    const client = this.client;
    this.budget = new BudgetTracker({
      config: () => this.cfg.budget,
      costOf: async (sessionID) => (await client.getSession(sessionID)).cost,
      interrupt: async (sessionID) => {
        await client.interrupt(sessionID);
        log.warn(`budget: interrupted ${sessionID.slice(0, 16)}`);
      },
      onStop: (sessionID, detail) => this.stops.markBudget(sessionID, detail.spentUsd, detail.limitUsd),
      notify: (sessionID, text) => this.notifySession(sessionID, text),
      load: () => this.store.budgetState(),
      save: (state) => this.store.setBudgetState(state),
    });
    this.budgetUnsub = client.subscribe(
      [
        "session.execution.started",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
      ],
      (event) => {
        const sessionID = String(event.data?.sessionID ?? "");
        if (!sessionID || !this.budget) return;
        if (event.type === "session.execution.started") this.activeTurns.set(sessionID, Date.now());
        else this.activeTurns.delete(sessionID);
        this.budgetChain = this.budgetChain
          .then(() =>
            event.type === "session.execution.started"
              ? this.budget!.startTurn(sessionID)
              : this.budget!.finishTurn(sessionID),
          )
          .catch((error) => log.warn("budget:", (error as Error).message));
      },
      (state) => log.info(`budget event stream ${state}`),
    );
    this.budgetTimer = setInterval(() => void this.budget?.tick(), 5_000);
    this.budgetTimer.unref?.();
  }

  private stopBudget(): void {
    this.budgetUnsub?.();
    this.budgetUnsub = undefined;
    if (this.budgetTimer) clearInterval(this.budgetTimer);
    this.budgetTimer = undefined;
    this.budget = undefined;
    this.budgetChain = Promise.resolve();
  }

  budgetSnapshot(): BudgetSnapshot | undefined {
    return this.budget?.snapshot();
  }

  /** Telegram + Discord delivery counters, shown in `/api/state.delivery`. */
  deliveryStats(): { retries: number; lost: number; duplicatesSuppressed: number } {
    const tg = this.bridge?.deliveryStats() ?? { retries: 0, lost: 0, duplicatesSuppressed: 0 };
    const dc = this.discord?.deliveryStats() ?? { retries: 0, lost: 0 };
    return {
      retries: tg.retries + dc.retries,
      lost: tg.lost + dc.lost,
      duplicatesSuppressed: tg.duplicatesSuppressed,
    };
  }

  /** The web server may fall back when the configured port is busy. */
  setWebPort(port: number): void {
    if (Number.isFinite(port) && port > 0) this.webPort = Math.round(port);
  }

  /** True while any session has a turn in flight; stale entries expire in 10 min. */
  turnActive(): boolean {
    const now = Date.now();
    for (const [sessionID, at] of this.activeTurns) {
      if (now - at > 10 * 60_000) this.activeTurns.delete(sessionID);
    }
    return this.activeTurns.size > 0;
  }

  /** GitHub goes through the pinned/proxy transport Telegram already uses. */
  private updateFetch(): typeof globalThis.fetch {
    if (this.net?.fetch) return this.net.fetch;
    return createUpdateFetch(this.cfg.telegram.proxy);
  }

  /** One chat notice per 10 minutes, same target as lifecycle messages. */
  private async notifyUpdateProblem(problem: UpdateProblem): Promise<void> {
    const now = Date.now();
    if (now - this.lastUpdateErrorNotice < 10 * 60_000) return;
    this.lastUpdateErrorNotice = now;
    const text = `⚠️ обновление: ${problem.message}${problem.hint ? `\n${problem.hint}` : ""}`;
    await this.notify(text);
  }

  /** Facts for `/status` in both adapters: uptime, adapter and OpenCode state. */
  private runtimeInfo(): BridgeRuntimeInfo {
    const discord = this.discord?.status;
    return {
      ocVersion: this.ocVersion,
      ocUrl: this.ocUrl,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      telegram: {
        enabled: this.telegramOn(),
        state: this.state,
        network: this.net?.mode,
        username: this.username,
      },
      discord: {
        enabled: Boolean(this.cfg.discord?.enabled),
        state: discord?.state ?? this.discordState,
        username: discord?.username,
      },
    };
  }

  /** Budget/warning text for a session: its chats first, admin notifications as a fallback. */
  async notifySession(sessionID: string, text: string): Promise<void> {
    let delivered = false;
    try {
      delivered = (await this.bridge?.sendSessionText(sessionID, text)) ?? false;
    } catch (error) {
      log.warn("budget notify (telegram):", (error as Error).message);
    }
    try {
      delivered = (await this.discord?.sendSessionText(sessionID, text)) || delivered;
    } catch (error) {
      log.warn("budget notify (discord):", (error as Error).message);
    }
    if (!delivered) await this.notify(text);
  }

  /** Discord is optional: any failure is logged and Telegram keeps running. */
  private async startDiscord(): Promise<void> {
    if (!this.client || !isDiscordConfigured(this.cfg) || this.discord) return;
    const run = this.lifecycle;
    this.discord = new DiscordBridge(this.cfg, this.client, this.store, {
      relay: this.relay,
      budget: () => this.budgetSnapshot(),
      stops: this.stops,
      runtime: () => this.runtimeInfo(),
      onStateChange: (state, error) => {
        this.discordState = state;
        this.discordError = error;
        if (state === "running") {
          this.discordRetryAt = 0;
          this.discordRetryAttempt = 0;
        }
        if (state === "error") log.error(`discord: ${error}`);
      },
    });
    try {
      await this.discord.start();
      if (run !== this.lifecycle) {
        await this.discord.stop().catch(() => undefined);
        this.discord = undefined;
        return;
      }
    } catch (error) {
      if (run !== this.lifecycle) {
        await this.discord?.stop().catch(() => undefined);
        this.discord = undefined;
        return;
      }
      const message = (error as Error).message;
      log.error("discord start failed (Telegram keeps running):", message);
      await this.discord?.stop().catch(() => undefined);
      this.discord = undefined;
      // The gateway may be temporarily unreachable: retry in the background
      // instead of leaving Discord dead until a manual restart.
      this.discordState = "retrying";
      this.discordError = message;
      this.scheduleDiscordRetry();
    }
  }

  /**
   * Applies a Telegram/Discord enable toggle without restarting the other
   * adapter: each transport starts and stops on its own.
   */
  async syncAdapters(): Promise<void> {
    if (!this.client) {
      if (this.telegramOn() || isDiscordConfigured(this.cfg)) await this.startBot();
      return;
    }
    if (this.telegramOn()) {
      if (!this.bridge) {
        try {
          await this.startTelegram();
        } catch (error) {
          this.error = (error as Error).message;
          log.error("telegram start failed:", this.error);
        }
      }
    } else if (this.bridge) {
      await this.bridge.stop().catch((error) => log.warn("telegram stop:", (error as Error).message));
      this.bridge = undefined;
      this.net?.stop();
      this.net = undefined;
      this.username = "";
      log.info("telegram adapter stopped (disabled)");
    }

    if (isDiscordConfigured(this.cfg)) {
      if (!this.discord) await this.startDiscord();
    } else if (this.discord) {
      await this.discord.stop().catch((error) => log.warn("discord stop:", (error as Error).message));
      this.discord = undefined;
      this.discordState = "off";
      this.discordError = "";
      this.discordRetryAt = 0;
      this.discordRetryAttempt = 0;
      if (this.discordRetryTimer) {
        clearTimeout(this.discordRetryTimer);
        this.discordRetryTimer = undefined;
      }
      log.info("discord adapter stopped (disabled)");
    }

    if (!this.bridge && !this.discord) {
      await this.stopBot("restart");
      return;
    }
    this.state = "running";
  }

  private scheduleDiscordRetry(): void {    if (this.discordRetryTimer || this.state !== "running" || !isDiscordConfigured(this.cfg)) return;
    const delay = Math.min(300_000, 60_000 * 2 ** Math.min(this.discordRetryAttempt, 3));
    this.discordRetryAttempt += 1;
    this.discordRetryAt = Date.now() + delay;
    this.discordState = "retrying";
    log.warn(`discord retry ${this.discordRetryAttempt} in ${Math.round(delay / 1000)}s`);
    this.discordRetryTimer = setTimeout(() => {
      this.discordRetryTimer = undefined;
      if (this.state !== "running" || !isDiscordConfigured(this.cfg)) return;
      this.discordRetryAt = 0;
      log.info("retrying discord connection…");
      void this.startDiscord();
    }, delay);
    this.discordRetryTimer.unref?.();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.cfg.telegram.token) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.state === "running" || !this.cfg.telegram.token) return;
      log.info("retrying telegram connection…");
      this.startBot().catch(() => undefined);
    }, 30_000);
    this.retryTimer.unref?.();
  }

  private async connectTelegram(): Promise<TelegramNet> {
    const token = this.cfg.telegram.token;
    let authError = "";
    try {
      const net = await setupTelegramNetwork(this.cfg.telegram, async (fetchImpl) => {
        try {
          const response = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) return true;
          if (response.status === 401 || response.status === 404) authError = "Токен бота недействителен";
          return false;
        } catch {
          return false;
        }
      });
      if (net.pinnedIp && this.cfg.telegram.apiIp !== net.pinnedIp) {
        this.cfg.telegram.apiIp = net.pinnedIp;
        saveConfig(this.paths, this.cfg);
      }
      return net;
    } catch (error) {
      throw new Error(authError || (error as Error).message);
    }
  }

  async stopBot(reason: "quit" | "restart" | "error" | "update" = "quit"): Promise<void> {
    this.lifecycle += 1;
    this.stopBudget();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.discordRetryTimer) {
      clearTimeout(this.discordRetryTimer);
      this.discordRetryTimer = undefined;
    }
    if (!this.suppressLifecycleNotice && reason !== "restart" && reason !== "update" && this.state === "running") {
      const uptime = this.startedAt ? formatUptime(Date.now() - this.startedAt) : "—";
      const label = reason === "error" ? "ошибка" : "выход";
      await this.notify(`🔴 остановлен · uptime ${uptime} · причина: ${label}`);
    }
    await this.bridge?.stop().catch((error) => log.warn("stop:", (error as Error).message));
    await this.discord?.stop().catch((error) => log.warn("discord stop:", (error as Error).message));
    this.net?.stop();
    this.bridge = undefined;
    this.discord = undefined;
    this.discordState = isDiscordConfigured(this.cfg) ? "stopped" : "off";    this.discordError = "";
    this.discordRetryAt = 0;
    this.discordRetryAttempt = 0;
    this.net = undefined;
    this.state = "stopped";
    this.startedAt = 0;
    log.info("bridge stopped");
  }

  async restartBot(): Promise<void> {
    // Config saves and tray restarts are not user-visible lifecycle transitions.
    this.suppressLifecycleNotice = true;
    try {
      await this.stopBot("restart");
      await this.startBot();
    } finally {
      this.suppressLifecycleNotice = false;
    }
  }

  async updateConfig(patch: Record<string, unknown>): Promise<void> {
    const wasRunning = this.state === "running";
    const telegramWasEnabled = this.cfg.telegram.enabled !== false;
    const discordWasEnabled = Boolean(this.cfg.discord?.enabled);
    const transportBefore = transportFingerprint(this.cfg);
    const telegram = (patch.telegram ?? {}) as Record<string, unknown>;
    const token = typeof telegram.token === "string" ? telegram.token.trim() : "";
    if (token) this.cfg.telegram.token = token;
    if (typeof telegram.enabled === "boolean") this.cfg.telegram.enabled = telegram.enabled;
    if (typeof telegram.proxy === "string") this.cfg.telegram.proxy = telegram.proxy.trim() || undefined;
    if (typeof telegram.apiIp === "string") this.cfg.telegram.apiIp = telegram.apiIp.trim() || undefined;

    const discord = (patch.discord ?? {}) as Record<string, unknown>;
    if (typeof discord.enabled === "boolean") this.discordCfg().enabled = discord.enabled;
    const discordToken = typeof discord.token === "string" ? discord.token.trim() : "";
    // Blank token means "keep the stored one"; it never appears in the UI or logs.
    if (discordToken) this.discordCfg().token = discordToken;
    if (discord.allowedGuilds !== undefined) this.discordCfg().allowedGuilds = parseIdList(discord.allowedGuilds);
    if (discord.allowedUsers !== undefined) this.discordCfg().allowedUsers = parseIdList(discord.allowedUsers);
    if (discord.mode === "threads") this.discordCfg().mode = "threads";
    if (discord.titleStatus === "off" || discord.titleStatus === "rename") {
      this.discordCfg().titleStatus = discord.titleStatus;
    }

    if (patch.mode === "topics" || patch.mode === "private" || patch.mode === "both") this.cfg.mode = patch.mode;
    if (patch.topicsChatId !== undefined) {
      const value = Number(patch.topicsChatId);
      this.cfg.topicsChatId = Number.isFinite(value) && value !== 0 ? value : undefined;
    }
    if (typeof patch.defaultDirectory === "string") this.cfg.defaultDirectory = patch.defaultDirectory.trim() || undefined;
    if (typeof patch.autoTopics === "boolean") this.cfg.autoTopics = patch.autoTopics;
    if (typeof patch.showSubagents === "boolean" || isSubagentMode(patch.showSubagents)) {
      this.cfg.showSubagents = patch.showSubagents;
    }
    const media = (patch.media ?? {}) as Record<string, unknown>;    if (media.relay === "none" || media.relay === "user" || media.relay === "all") {
      this.cfg.media = { ...(this.cfg.media ?? {}), relay: media.relay };
    }
    if (typeof media.maxPhotoMb === "number" && Number.isFinite(media.maxPhotoMb)) {
      this.cfg.media = {
        ...(this.cfg.media ?? {}),
        maxPhotoMb: Math.min(10, Math.max(1, Math.round(media.maxPhotoMb))),
      };
    }

    const update = (patch.update ?? {}) as Record<string, unknown>;
    if (typeof update.checkOnStart === "boolean") this.cfg.update = { ...(this.cfg.update ?? {}), checkOnStart: update.checkOnStart };
    if (typeof update.autoDownload === "boolean") this.cfg.update = { ...(this.cfg.update ?? {}), autoDownload: update.autoDownload };
    if (typeof update.intervalHours === "number" && Number.isFinite(update.intervalHours)) {
      this.cfg.update = {
        ...(this.cfg.update ?? {}),
        intervalHours: Math.min(168, Math.max(1, Math.round(update.intervalHours))),
      };
    }
    const notify = (patch.notify ?? {}) as Record<string, unknown>;
    if (typeof notify.enabled === "boolean") {
      this.cfg.notify = { ...(this.cfg.notify ?? {}), enabled: notify.enabled };
    }
    if (notify.targets === "admin" || notify.targets === "all") {
      this.cfg.notify = { ...(this.cfg.notify ?? {}), targets: notify.targets };
    } else if (Array.isArray(notify.targets)) {
      this.cfg.notify = {
        ...(this.cfg.notify ?? {}),
        targets: notify.targets.map((id) => String(id).trim()).filter(Boolean),
      };
    }

    const budget = (patch.budget ?? {}) as Record<string, unknown>;
    const nextBudget = { ...(this.cfg.budget ?? { action: "warn" as const }) };
    if ("perTurnUsd" in budget) nextBudget.perTurnUsd = readBudgetValue(budget.perTurnUsd);
    if ("dailyUsd" in budget) nextBudget.dailyUsd = readBudgetValue(budget.dailyUsd);
    if (budget.action === "warn" || budget.action === "stop") nextBudget.action = budget.action;
    this.cfg.budget = nextBudget;

    const permissions = (patch.permissions ?? {}) as Record<string, unknown>;
    if (isPermissionMode(permissions.mode)) {
      this.cfg.permissions = { ...(this.cfg.permissions ?? {}), mode: permissions.mode };
    }

    const ui = (patch.ui ?? {}) as Record<string, unknown>;
    if (Array.isArray(ui.seenChangelog)) {
      this.cfg.ui = { ...(this.cfg.ui ?? {}), seenChangelog: ui.seenChangelog.map((v) => String(v).trim()).filter(Boolean) };
    }
    if (ui.theme === "opencode" || ui.theme === "matrix") {
      this.cfg.ui = { ...(this.cfg.ui ?? {}), theme: ui.theme };
    }
    if (ui.scheme === "system" || ui.scheme === "light" || ui.scheme === "dark") {
      this.cfg.ui = { ...(this.cfg.ui ?? {}), scheme: ui.scheme };
    }
    if (ui.lang === "system" || ui.lang === "ru" || ui.lang === "en") {
      this.cfg.ui = { ...(this.cfg.ui ?? {}), lang: ui.lang };
    }
    if (ui.titleStatus === "icon" || ui.titleStatus === "rename" || ui.titleStatus === "off") {
      this.cfg.ui = { ...(this.cfg.ui ?? {}), titleStatus: ui.titleStatus };
    }
    if (typeof ui.diagnostics === "boolean") {
      this.cfg.ui = { ...(this.cfg.ui ?? {}), diagnostics: ui.diagnostics };
    }

    const stream = (patch.stream ?? {}) as Record<string, unknown>;
    if (typeof stream.editIntervalMs === "number") {
      this.cfg.stream.editIntervalMs = Math.min(10_000, Math.max(500, Math.round(stream.editIntervalMs)));
    }
    if (stream.showTools === "off" || stream.showTools === "compact" || stream.showTools === "full") {
      this.cfg.stream.showTools = stream.showTools;
    }
    if (stream.format === "rich" || stream.format === "html") this.cfg.stream.format = stream.format;

    saveConfig(this.paths, this.cfg);
    const adapterToggled =
      telegramWasEnabled !== (this.cfg.telegram.enabled !== false) ||
      discordWasEnabled !== Boolean(this.cfg.discord?.enabled);
    const transportChanged = transportBefore !== transportFingerprint(this.cfg);
    if (wasRunning) {
      // Toggles stop/start just that adapter; only transport-relevant keys need
      // a reconnect. Theme/scheme/lang/title changes apply live.
      if (adapterToggled) await this.syncAdapters();
      else if (transportChanged) await this.restartBot();
    } else if (this.state === "error" && (this.telegramOn() || isDiscordConfigured(this.cfg))) {
      await this.startBot().catch(() => undefined);
    } else if (this.state === "stopped" && adapterToggled && (this.telegramOn() || isDiscordConfigured(this.cfg))) {
      await this.startBot().catch(() => undefined);
    }
  }

  private discordCfg(): DiscordConfig {
    this.cfg.discord ??= { enabled: false, token: "", allowedGuilds: [], allowedUsers: [], mode: "threads" };
    return this.cfg.discord;
  }

  /** Active and recent root sessions, hidden ones excluded unless asked. */
  async sessions(includeHidden = false): Promise<Array<{ id: string; title: string; directory?: string; active?: boolean; updatedAt?: number }>> {
    if (!this.client) return [];
    try {
      const list = await this.client.listSessions({ limit: 25 });
      const hidden = new Set(this.store.hiddenSessions());
      return list
        .filter((session) => !session.parentID)
        .filter((session) => includeHidden || !hidden.has(session.id))
        .map((session) => ({
          id: session.id,
          title: (session.title ?? "").trim() || session.id.slice(0, 12),
          directory: session.location?.directory,
          active: Number(session.time?.busy ?? 0) > Number(session.time?.idle ?? 0),
          updatedAt: Number(session.time?.updated ?? session.time?.created ?? 0),
        }))
        .sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
        .slice(0, 10);
    } catch {
      return [];
    }
  }

  /** Hides a session in the panel only; OpenCode keeps the session. */
  hideSession(sessionID: string): void {
    this.store.hideSession(sessionID);
  }

  showSession(sessionID: string): void {
    this.store.showSession(sessionID);
  }

  // ------------------------------------------------------------ notifications

  /** Chat ids for lifecycle messages: first admin, everyone, or explicit ids. */
  notifyTargets(): number[] {
    const targets = this.cfg.notify?.targets ?? "admin";
    const users = this.cfg.telegram.allowedUsers;
    if (targets === "all") return users.map((user) => user.id);
    if (Array.isArray(targets)) {
      return targets.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id !== 0);
    }
    const admin = users.find((user) => user.role === "admin") ?? users[0];
    return admin ? [admin.id] : [];
  }

  /** Sends through the active Telegram transport; failures never break the bridge. */
  async notify(text: string): Promise<void> {
    if (this.cfg.notify?.enabled === false) return;
    const token = this.cfg.telegram.token;
    if (!token) return;
    // A pinned transport can hiccup right after a restart; retry once through it
    // and once through the direct fetch, without ever blocking the caller for long.
    const transports = [this.net?.fetch, globalThis.fetch].filter(Boolean) as Array<typeof globalThis.fetch>;
    for (const chatId of this.notifyTargets()) {
      let delivered = false;
      for (let attempt = 0; attempt < 3 && !delivered; attempt += 1) {
        const fetchImpl = transports[attempt % transports.length]!;
        try {
          const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) delivered = true;
          else log.warn(`notify: Telegram HTTP ${response.status}`);
        } catch (error) {
          log.warn("notify:", (error as Error).message);
        }
        if (!delivered) await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
  }

  private async sendStartNotice(): Promise<void> {
    if (this.suppressLifecycleNotice || this.state !== "running") return;
    const now = Date.now();
    if (now - this.lastStartNotice < 2 * 60_000) return;
    this.lastStartNotice = now;
    let sessions = 0;
    try {
      sessions = (await this.sessions()).length;
    } catch {
      /* optional */
    }
    const discord = this.discord?.status.username;
    const text =
      `🟢 OpenCode Bridge ${pkg.version} · OpenCode ${this.ocVersion || "—"} · ` +
      `Telegram @${this.username || "—"} · Discord ${discord ? `@${discord}` : "—"} · сессий ${sessions}`;
    await this.notify(text);
  }

  private async sendFailureNotice(message: string): Promise<void> {
    if (this.suppressLifecycleNotice) return;
    const now = Date.now();
    if (now - this.lastFailureNotice < 2 * 60_000) return;
    this.lastFailureNotice = now;
    await this.notify(`⚠️ не удалось запустить: ${message}`);
  }

  private startUpdateLoop(): void {
    if (this.updateTimer) return;
    const settings = this.cfg.update ?? {};
    if (settings.checkOnStart !== false) void this.checkUpdate(true);
    const hours = Math.min(168, Math.max(1, settings.intervalHours ?? 6));
    this.updateTimer = setInterval(() => void this.checkUpdate(true), hours * 60 * 60 * 1000);
    this.updateTimer.unref?.();
  }

  async checkUpdate(auto = false): Promise<ReturnType<Updater["snapshot"]>> {
    const snapshot = await this.updater.check();
    const autoDownload = this.cfg.update?.autoDownload !== false;
    if (snapshot.available && !snapshot.verified && !snapshot.error && autoDownload) {
      const action = autoAction(
        {
          available: snapshot.available,
          autoDownload,
          downloading: snapshot.downloading,
          verified: snapshot.verified,
          errorCode: snapshot.errorCode,
        },
        this.turnActive(),
      );
      if (action === "download" || action === "wait-busy") {
        log.info(`update ${snapshot.latest}: background download${action === "wait-busy" ? " (paused until the turn ends)" : ""}`);
        void this.updater.download();
      }
    }
    return snapshot;
  }

  /** Starts the background download and returns at once; the panel polls progress. */
  async downloadUpdate(): Promise<ReturnType<Updater["snapshot"]>> {
    if (!this.updater.snapshot().downloading) void this.updater.download();
    return this.updater.snapshot();
  }

  async cancelUpdate(): Promise<ReturnType<Updater["snapshot"]>> {
    return this.updater.cancel();
  }

  async installUpdate(): Promise<ReturnType<Updater["snapshot"]>> {
    return this.updater.install();
  }

  async rollbackUpdate(): Promise<ReturnType<Updater["snapshot"]>> {
    const result = await this.updater.rollback();
    if (!result.error) this.store.setPrevVersion(undefined);
    return result;
  }

  /** CHANGELOG sections in `(from, to]` for the Electron modal. */
  changelog(from: string | undefined, to: string): Array<{ version: string; heading: string; body: string }> {
    return changelogBetween(from, to);
  }

  /** Marks a version's changelog as acknowledged; does not restart the bridge. */
  markChangelogSeen(version: string): void {
    const value = version.trim();
    if (!value) return;
    const seen = this.cfg.ui?.seenChangelog ?? [];
    if (seen.includes(value)) return;
    this.cfg.ui = { ...(this.cfg.ui ?? {}), seenChangelog: [...seen, value] };
    saveConfig(this.paths, this.cfg);
  }

  setAutostart(enabled: boolean): void {    if (process.platform !== "win32" || !isCompiled()) throw new Error("Автозапуск поддерживается в собранной версии для Windows");
    const desktop = join(exeDir(), "desktop", "OpenCode Bridge.exe");
    const exe = existsSync(desktop) ? desktop : process.execPath;
    const args = enabled
      ? ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "OpenCodeTelegramBridge", "/t", "REG_SZ", "/d", `"${exe}" --hidden`, "/f"]
      : ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "OpenCodeTelegramBridge", "/f"];
    const result = spawnSync("reg", args, { windowsHide: true });
    if (result.status !== 0 && enabled) throw new Error("Не удалось включить автозапуск");
  }
}

export function isCompiled(): boolean {
  const exe = process.execPath.toLowerCase();
  return !exe.endsWith("bun.exe") && !exe.endsWith("bun") && !exe.endsWith("node.exe") && !exe.endsWith("node");
}

export function exeDir(): string {
  return isCompiled() ? dirname(process.execPath) : process.cwd();
}

/** Positive USD amount or `undefined` (cap disabled). */
function readBudgetValue(value: unknown): number | undefined {
  if (value === "" || value === null || value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.round(number * 100) / 100;
}

function isAutostartEnabled(): boolean {
  if (process.platform !== "win32") return false;
  const result = spawnSync(
    "reg",
    ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "OpenCodeTelegramBridge"],
    { windowsHide: true },
  );
  return result.status === 0;
}

export function openBrowser(url: string): void {
  if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", url], { windowsHide: true });
  else if (process.platform === "darwin") spawnSync("open", [url]);
  else spawnSync("xdg-open", [url]);
}

/** Accepts an array (API) or a comma/space separated string (manual config edits). */
function parseIdList(value: unknown): string[] {  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}
