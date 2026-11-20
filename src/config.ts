import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type Role = "admin" | "user";

export interface UserConfig {
  id: number;
  role?: Role;
  name?: string;
}

export interface DiscordConfig {
  enabled: boolean;
  /** Bot token. Secret: never logged, only the last 4 chars leave the process. */
  token?: string;
  /** Guild (server) ids the bot serves; empty = none allowed. */
  allowedGuilds?: string[];
  /** User ids allowed to drive the bot; empty = nobody. */
  allowedUsers?: string[];
  /** v1 supports threads only. */
  mode?: "threads";
}

export type MediaRelayMode = "none" | "user" | "all";

export interface MediaConfig {
  /** none = off, user = only user-sent media, all = user + agent output. */
  relay?: MediaRelayMode;
  /** Images up to this size go as Telegram photos; bigger ones as documents. */
  maxPhotoMb?: number;
}

export interface UpdateConfig {
  checkOnStart?: boolean;
  intervalHours?: number;
  autoDownload?: boolean;
}

export interface BridgeConfig {
  telegram: {
    token: string;
    allowedUsers: UserConfig[];
    /** Optional HTTP/SOCKS proxy for Bot API, e.g. "socks5://127.0.0.1:1080". */
    proxy?: string;
    /** Force a specific Bot API IP (when the DNS-provided one is blocked). */
    apiIp?: string;
  };
  discord?: DiscordConfig;
  opencode: {
    /** Empty = auto discover the shared background service. */
    baseUrl?: string;
    /** Empty = read from ~/.config/opencode/service.json */
    password?: string;
  };
  /** "topics" = forum supergroup, one topic per session; "private" = one chat + /switch; "both". */
  mode: "topics" | "private" | "both";
  /** Show subagent activity lines and final reports in chat (default true). */
  showSubagents?: boolean;
  /** Media relay between bound chats (default all). */
  media?: MediaConfig;
  /** GitHub auto-update settings. */
  update?: UpdateConfig;
  /** Forum supergroup chat id used in "topics" mode. */
  topicsChatId?: number;
  /** Default directory for new sessions (empty = current working directory). */
  defaultDirectory?: string;
  /** Create a forum topic automatically when a task is sent in the group's general chat. */
  autoTopics?: boolean;
  ui?: {
    theme?: "opencode" | "matrix";
    scheme?: "system" | "light" | "dark";
    lang?: "system" | "ru" | "en";
  };
  web: {
    port: number;
  };
  stream: {
    /** Minimum delay between two edits of the same Telegram message. */
    editIntervalMs: number;
    showReasoning: boolean;
    /** "off" | "compact" | "full" */
    showTools: "off" | "compact" | "full";
    /** "rich" = native Telegram Markdown (tables, headings); "html" = classic HTML. */
    format?: "rich" | "html";
  };
}

const DEFAULT_CONFIG: BridgeConfig = {
  telegram: { token: "", allowedUsers: [] },
  discord: { enabled: false, token: "", allowedGuilds: [], allowedUsers: [], mode: "threads" },
  opencode: {},
  mode: "both",
  showSubagents: true,
  media: { relay: "all", maxPhotoMb: 10 },
  update: { checkOnStart: true, intervalHours: 6, autoDownload: false },
  web: { port: 7788 },
  stream: { editIntervalMs: 1800, showReasoning: false, showTools: "compact", format: "rich" },
};

export interface Paths {
  configFile: string;
  stateFile: string;
  logFile: string;
}

function appDataDir(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opencode-telegram-bridge");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode-telegram-bridge");
}

export function resolvePaths(): Paths {
  const envPath = process.env.OCBRIDGE_CONFIG;
  if (envPath) {
    return { configFile: envPath, stateFile: join(dirname(envPath), "state.json"), logFile: join(dirname(envPath), "bridge.log") };
  }

  const compiled = !/bun(\.exe)?$|node(\.exe)?$/i.test(process.execPath);
  if (compiled) {
    // Installed builds always keep data in %APPDATA%, so upgrades and reinstalls
    // never change the file location and never lose topic bindings.
    const dir = appDataDir();
    migrateLegacyData(dirname(process.execPath), dir);
    return { configFile: join(dir, "config.json"), stateFile: join(dir, "state.json"), logFile: join(dir, "bridge.log") };
  }

  const devConfig = join(process.cwd(), "config.json");
  if (existsSync(devConfig)) {
    return { configFile: devConfig, stateFile: join(dirname(devConfig), "state.json"), logFile: join(dirname(devConfig), "bridge.log") };
  }
  const dir = appDataDir();
  return { configFile: join(dir, "config.json"), stateFile: join(dir, "state.json"), logFile: join(dir, "bridge.log") };
}

/** Imports config/state left next to an older portable exe into the stable data dir. */
function migrateLegacyData(exeDir: string, dataDir: string): void {
  try {
    const legacyConfig = join(exeDir, "config.json");
    if (!existsSync(legacyConfig)) return;
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(dataDir, "config.json");
    if (!existsSync(configPath)) {
      writeFileSync(configPath, readFileSync(legacyConfig), "utf8");
    }
    const legacyState = join(exeDir, "state.json");
    const statePath = join(dataDir, "state.json");
    if (!existsSync(legacyState)) return;
    const legacy = JSON.parse(readFileSync(legacyState, "utf8").replace(/^\uFEFF/, "")) as Record<string, any>;
    const current = existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, any>)
      : {};
    const merged: Record<string, any> = {
      topics: { ...(legacy.topics ?? {}), ...(current.topics ?? {}) },
      chats: { ...(legacy.chats ?? {}), ...(current.chats ?? {}) },
      sessions: { ...(legacy.sessions ?? {}), ...(current.sessions ?? {}) },
    };
    writeFileSync(statePath, JSON.stringify(merged, null, 2), "utf8");
    // Mark legacy files so deleted bindings never come back on the next start.
    try {
      renameSync(legacyState, `${legacyState}.migrated`);
    } catch {
      /* ignore */
    }
    try {
      renameSync(legacyConfig, `${legacyConfig}.migrated`);
    } catch {
      /* ignore */
    }
  } catch {
    /* migration is best-effort */
  }
}

export function loadConfig(paths: Paths): BridgeConfig {
  if (!existsSync(paths.configFile)) {
    mkdirSync(dirname(paths.configFile), { recursive: true });
    writeFileSync(paths.configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    return { ...DEFAULT_CONFIG };
  }
  const raw = JSON.parse(readFileSync(paths.configFile, "utf8").replace(/^\uFEFF/, "")) as Partial<BridgeConfig>;
  return {
    telegram: {
      token: raw.telegram?.token ?? "",
      allowedUsers: raw.telegram?.allowedUsers ?? [],
      proxy: raw.telegram?.proxy,
      apiIp: raw.telegram?.apiIp,
    },
    discord: {
      enabled: Boolean(raw.discord?.enabled),
      token: raw.discord?.token ?? "",
      allowedGuilds: readIdList(raw.discord?.allowedGuilds),
      allowedUsers: readIdList(raw.discord?.allowedUsers),
      mode: "threads",
    },
    opencode: { baseUrl: raw.opencode?.baseUrl, password: raw.opencode?.password },
    mode: raw.mode ?? DEFAULT_CONFIG.mode,
    showSubagents: raw.showSubagents ?? true,
    media: {
      relay: raw.media?.relay === "none" || raw.media?.relay === "user" ? raw.media.relay : "all",
      maxPhotoMb: clampNumber(raw.media?.maxPhotoMb, 1, 10, 10),
    },
    update: {
      checkOnStart: raw.update?.checkOnStart !== false,
      intervalHours: clampNumber(raw.update?.intervalHours, 1, 168, 6),
      autoDownload: raw.update?.autoDownload === true,
    },
    topicsChatId: raw.topicsChatId,
    defaultDirectory: raw.defaultDirectory,
    autoTopics: raw.autoTopics ?? true,
    ui: { theme: raw.ui?.theme ?? "opencode", scheme: raw.ui?.scheme ?? "system", lang: raw.ui?.lang ?? "system" },
    web: { port: raw.web?.port ?? DEFAULT_CONFIG.web.port },
    stream: { ...DEFAULT_CONFIG.stream, ...(raw.stream ?? {}) },
  };
}

/** True once a bot token is present; the bot itself can start. */
export function isConfigured(cfg: BridgeConfig): boolean {
  return Boolean(cfg.telegram.token);
}

/** Discord is opt-in: enabled checkbox + token. */
export function isDiscordConfigured(cfg: BridgeConfig): boolean {
  return Boolean(cfg.discord?.enabled && cfg.discord.token);
}

/** Snowflake ids may arrive as strings or numbers (hand-edited config). */
function readIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function saveConfig(paths: Paths, cfg: BridgeConfig): void {
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function findUser(cfg: BridgeConfig, userId: number): UserConfig | undefined {
  return cfg.telegram.allowedUsers.find((u) => u.id === userId);
}

export function isAdmin(cfg: BridgeConfig, userId: number): boolean {
  return findUser(cfg, userId)?.role === "admin";
}
