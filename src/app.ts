import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  applyInstallerOverrides,
  isDiscordConfigured,
  loadConfig,
  resolvePaths,
  saveConfig,
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
import { Updater, type UpdateCache } from "./updater.ts";
import { changelogBetween } from "./changelog.ts";

export type BotState = "stopped" | "starting" | "running" | "error";

export interface Snapshot {
  version: string;
  configured: boolean;
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
    showSubagents: boolean;
    media: { relay: "none" | "user" | "all"; maxPhotoMb: number };
    update: { checkOnStart: boolean; intervalHours: number; autoDownload: boolean };
    notify: { enabled: boolean; targets: "admin" | "all" | string[] };
    ui: {
      theme: "opencode" | "matrix";
      scheme: "system" | "light" | "dark";
      lang: "system" | "ru" | "en";
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
    username: string;
    tokenTail: string;
    allowedGuilds: string[];
    allowedUsers: string[];
  };
  webPort: number;
  autostart: boolean;
  autostartSupported: boolean;
  configPath: string;
  sessions: Array<{ id: string; title: string; directory?: string }>;
  /** Doctor warnings (stalled prompts, etc.) shown in the panel. */
  warnings: string[];
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
  private ocVersion = "";
  private ocUrl = "";
  private lastStartNotice = 0;
  private lastFailureNotice = 0;
  private suppressLifecycleNotice = false;

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
      onCache: (cache) => this.store.setUpdateCache(cache as unknown as Record<string, unknown>),
      onBeforeInstall: (previous) => this.store.setPrevVersion(previous),
      notify: (text) => this.notify(text),
    });
    this.updater.restore(this.store.updateCache() as UpdateCache | undefined, this.store.getPrevVersion());
  }

  snapshot(): Snapshot {
    return {
      version: pkg.version,
      configured: Boolean(this.cfg.telegram.token),
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
        showSubagents: this.cfg.showSubagents !== false,
        media: {
          relay: this.cfg.media?.relay ?? "all",
          maxPhotoMb: this.cfg.media?.maxPhotoMb ?? 10,
        },
        update: {
          checkOnStart: this.cfg.update?.checkOnStart !== false,
          intervalHours: this.cfg.update?.intervalHours ?? 6,
          autoDownload: this.cfg.update?.autoDownload === true,
        },
        notify: {
          enabled: this.cfg.notify?.enabled !== false,
          targets: this.cfg.notify?.targets ?? "admin",
        },
        ui: {
          theme: this.cfg.ui?.theme ?? "opencode",
          scheme: this.cfg.ui?.scheme ?? "system",
          lang: this.cfg.ui?.lang ?? "system",
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
        state: this.discord?.status.state ?? (isDiscordConfigured(this.cfg) ? "stopped" : "off"),
        username: this.discord?.status.username ?? "",
        tokenTail: this.cfg.discord?.token ? `…${this.cfg.discord.token.slice(-4)}` : "",
        allowedGuilds: this.cfg.discord?.allowedGuilds ?? [],
        allowedUsers: this.cfg.discord?.allowedUsers ?? [],
      },
      webPort: this.cfg.web.port,
      autostart: isAutostartEnabled(),
      autostartSupported: process.platform === "win32" && isCompiled(),
      configPath: this.paths.configFile,
      sessions: [],
      warnings: this.bridge?.warnings() ?? [],
      update: this.updater.snapshot(),
    };
  }

  async startBot(): Promise<void> {
    if (this.state === "running" || this.state === "starting") return;
    const hasTelegram = Boolean(this.cfg.telegram.token);
    if (!hasTelegram && !isDiscordConfigured(this.cfg)) throw new Error("Не указан токен бота");
    this.state = "starting";
    this.error = "";
    try {
      const endpoint = await discover(this.cfg.opencode);
      this.client = new OcClient(endpoint.baseUrl, endpoint.password);
      this.ocUrl = endpoint.baseUrl;
      this.ocVersion = (await this.client.info()).version;
      this.relay = new MediaRelay({
        store: this.store,
        media: () => this.cfg.media ?? { relay: "all", maxPhotoMb: 10 },
        topicsChatId: () => this.cfg.topicsChatId,
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

      if (hasTelegram) {
        this.net = await this.connectTelegram();
        this.bridge = new Bridge(this.cfg, this.client, this.store, {
          fetch: this.net.fetch,
          relay: this.relay,
          onConfigChange: () => saveConfig(this.paths, this.cfg),
          onPollingError: (message) => {
            if (/409/.test(message)) {
              this.error = "Другой экземпляр бота уже запущен (409 Conflict). Закройте его в диспетчере задач.";
              log.error(this.error);
            }
          },
        });
        this.username = await this.bridge.start();
      }
      // Discord may be slow or temporarily unreachable; Telegram must not wait
      // for its login retries (up to ~7 min) before the panel says "running".
      void this.startDiscord();
      this.state = "running";
      this.startedAt = Date.now();
      this.startUpdateLoop();
      log.info("bridge running");
      // Discord logs in asynchronously; give it a moment so the start notice
      // can name both bots. 2-minute debounce keeps reconnect loops quiet.
      const noticeTimer = setTimeout(() => void this.sendStartNotice(), 2500);
      noticeTimer.unref?.();
    } catch (error) {
      this.state = "error";
      this.error = (error as Error).message;
      log.error("start failed:", this.error);
      void this.sendFailureNotice(this.error);
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

  /** Discord is optional: any failure is logged and Telegram keeps running. */
  private async startDiscord(): Promise<void> {
    if (!this.client || !isDiscordConfigured(this.cfg) || this.discord) return;
    this.discord = new DiscordBridge(this.cfg, this.client, this.store, {
      relay: this.relay,
      onStateChange: (state, error) => {
        if (state === "error") log.error(`discord: ${error}`);
      },
    });
    try {
      await this.discord.start();
    } catch (error) {
      log.error("discord start failed (Telegram keeps running):", (error as Error).message);
      await this.discord.stop().catch(() => undefined);
      this.discord = undefined;
      // The gateway may be temporarily unreachable: retry in the background
      // instead of leaving Discord dead until a manual restart.
      this.scheduleDiscordRetry();
    }
  }

  private scheduleDiscordRetry(): void {
    if (this.discordRetryTimer || this.state !== "running" || !isDiscordConfigured(this.cfg)) return;
    this.discordRetryTimer = setTimeout(() => {
      this.discordRetryTimer = undefined;
      if (this.state !== "running" || !isDiscordConfigured(this.cfg)) return;
      log.info("retrying discord connection…");
      void this.startDiscord();
    }, 5 * 60_000);
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
    const telegram = (patch.telegram ?? {}) as Record<string, unknown>;
    const token = typeof telegram.token === "string" ? telegram.token.trim() : "";
    if (token) this.cfg.telegram.token = token;
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

    if (patch.mode === "topics" || patch.mode === "private" || patch.mode === "both") this.cfg.mode = patch.mode;
    if (patch.topicsChatId !== undefined) {
      const value = Number(patch.topicsChatId);
      this.cfg.topicsChatId = Number.isFinite(value) && value !== 0 ? value : undefined;
    }
    if (typeof patch.defaultDirectory === "string") this.cfg.defaultDirectory = patch.defaultDirectory.trim() || undefined;
    if (typeof patch.autoTopics === "boolean") this.cfg.autoTopics = patch.autoTopics;
    if (typeof patch.showSubagents === "boolean") this.cfg.showSubagents = patch.showSubagents;
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

    const stream = (patch.stream ?? {}) as Record<string, unknown>;
    if (typeof stream.editIntervalMs === "number") {
      this.cfg.stream.editIntervalMs = Math.min(10_000, Math.max(500, Math.round(stream.editIntervalMs)));
    }
    if (stream.showTools === "off" || stream.showTools === "compact" || stream.showTools === "full") {
      this.cfg.stream.showTools = stream.showTools;
    }
    if (stream.format === "rich" || stream.format === "html") this.cfg.stream.format = stream.format;

    saveConfig(this.paths, this.cfg);
    if (wasRunning) await this.restartBot();
    else if (this.state === "error" && (this.cfg.telegram.token || isDiscordConfigured(this.cfg))) {
      await this.startBot().catch(() => undefined);
    }
  }

  private discordCfg(): DiscordConfig {
    this.cfg.discord ??= { enabled: false, token: "", allowedGuilds: [], allowedUsers: [], mode: "threads" };
    return this.cfg.discord;
  }

  async sessions(): Promise<Array<{ id: string; title: string; directory?: string }>> {
    if (!this.client) return [];
    try {
      const list = await this.client.listSessions({ limit: 8 });
      return list
        .filter((session) => !session.parentID)
        .map((session) => ({ id: session.id, title: session.title, directory: session.location?.directory }));
    } catch {
      return [];
    }
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
    if (auto && snapshot.available && this.cfg.update?.autoDownload === true && !snapshot.downloading) {
      log.info(`update ${snapshot.latest}: auto-download enabled`);
      void this.updater.download();
    }
    return snapshot;
  }

  async downloadUpdate(): Promise<ReturnType<Updater["snapshot"]>> {
    return this.updater.download();
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
    const exe = process.execPath;
    const args = enabled
      ? ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "OpenCodeTelegramBridge", "/t", "REG_SZ", "/d", `"${exe}" --no-browser`, "/f"]
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

function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}м`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}ч ${rest}м` : `${hours}ч`;
}

/** Accepts an array (API) or a comma/space separated string (manual config edits). */
function parseIdList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}
