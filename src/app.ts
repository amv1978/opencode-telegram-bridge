import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { isDiscordConfigured, loadConfig, resolvePaths, saveConfig, type BridgeConfig, type DiscordConfig } from "./config.ts";
import pkg from "../package.json";
import { initLog, log } from "./log.ts";
import { discover, OcClient } from "./opencode/client.ts";
import { Store } from "./state/store.ts";
import { Bridge } from "./telegram/bot.ts";
import { setupTelegramNetwork, type TelegramNet } from "./telegram/net.ts";
import { DiscordBridge } from "./discord/adapter.ts";

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
    ui: { theme: "opencode" | "matrix"; scheme: "system" | "light" | "dark"; lang: "system" | "ru" | "en" };
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
}

export class App {
  readonly paths = resolvePaths();
  cfg: BridgeConfig;
  readonly store: Store;
  private client?: OcClient;
  private bridge?: Bridge;
  private discord?: DiscordBridge;
  private net?: TelegramNet;
  private state: BotState = "stopped";
  private error = "";
  private username = "";
  private startedAt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private ocVersion = "";
  private ocUrl = "";

  constructor() {
    initLog(this.paths.logFile);
    this.cfg = loadConfig(this.paths);
    this.store = new Store(this.paths.stateFile);
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
        ui: {
          theme: this.cfg.ui?.theme ?? "opencode",
          scheme: this.cfg.ui?.scheme ?? "system",
          lang: this.cfg.ui?.lang ?? "system",
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

      if (hasTelegram) {
        this.net = await this.connectTelegram();
        this.bridge = new Bridge(this.cfg, this.client, this.store, {
          fetch: this.net.fetch,
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
      await this.startDiscord();
      this.state = "running";
      this.startedAt = Date.now();
      log.info("bridge running");
    } catch (error) {
      this.state = "error";
      this.error = (error as Error).message;
      log.error("start failed:", this.error);
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
    if (!this.client || !isDiscordConfigured(this.cfg)) return;
    this.discord = new DiscordBridge(this.cfg, this.client, this.store, {
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
    }
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

  async stopBot(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
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
    await this.stopBot();
    await this.startBot();
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
    const ui = (patch.ui ?? {}) as Record<string, unknown>;
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

  setAutostart(enabled: boolean): void {
    if (process.platform !== "win32" || !isCompiled()) throw new Error("Автозапуск поддерживается в собранной версии для Windows");
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
