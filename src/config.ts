import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { atomicWrite, hasPersistedFile, readJsonFile } from "./atomic.ts";
import type { PermissionMode } from "./permissions.ts";
import { isPermissionMode } from "./permissions.ts";
import { normalizeSubagentMode } from "./subagents.ts";
import { installerDefaults, readInstallerState, writeInstallerState, type InstallerState } from "./installer.ts";
import { normalizeTitleStatus } from "./titles.ts";

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
  /**
   * Discord threads have no icons, so status markers are off by default.
   * `rename` is the opt-in fallback: every rename posts a service message.
   */
  titleStatus?: "off" | "rename";
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

/** Lifecycle notifications in chat (start/stop/update). */
export interface NotifyConfig {
  enabled?: boolean;
  /** "admin" = first admin's private chat, "all" = every allowed user, or explicit chat ids. */
  targets?: "admin" | "all" | string[];
}

/**
 * Cost caps. `perTurnUsd` is compared with the cost growth of one turn,
 * `dailyUsd` with the sum of turn deltas for the current UTC day.
 * `action` decides what happens when a cap is exceeded: warn only, or interrupt.
 */
export interface BudgetConfig {
  perTurnUsd?: number;
  dailyUsd?: number;
  action?: "warn" | "stop";
}

/** Default permission mode for newly created sessions; `/mode` changes one session. */
export interface PermissionConfig {
  mode?: PermissionMode;
}export interface BridgeConfig {
  telegram: {
    token: string;
    /** `false` stops only the Telegram adapter; Discord keeps running. */
    enabled?: boolean;
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
  /** Subagent visibility: auto (inline or message), inline, message, or off. */
  showSubagents?: boolean | "auto" | "inline" | "message" | "off";
  /** Media relay between bound chats (default all). */
  media?: MediaConfig;
  /** GitHub auto-update settings. */
  update?: UpdateConfig;
  /** Lifecycle chat notifications (default: enabled, first admin). */
  notify?: NotifyConfig;
  /** Cost caps and what to do when they are exceeded. */
  budget?: BudgetConfig;
  /** Permission preset applied to new sessions. */
  permissions?: PermissionConfig;
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
    /** Telegram turn status: topic icon (default), topic rename, or nothing. */
    titleStatus?: "icon" | "rename" | "off";
    /** Versions whose changelog modal was already acknowledged (Electron). */
    seenChangelog?: string[];
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
  telegram: { token: "", enabled: true, allowedUsers: [] },
  discord: { enabled: false, token: "", allowedGuilds: [], allowedUsers: [], mode: "threads", titleStatus: "off" },
  opencode: {},
  mode: "both",
  showSubagents: "auto",
  media: { relay: "all", maxPhotoMb: 10 },
  update: { checkOnStart: true, intervalHours: 6, autoDownload: false },
  notify: { enabled: true, targets: "admin" },
  budget: { action: "warn" },
  permissions: { mode: "ask" },
  ui: { theme: "opencode", scheme: "system", lang: "system", titleStatus: "icon", seenChangelog: [] },
  web: { port: 7788 },
  stream: { editIntervalMs: 1800, showReasoning: false, showTools: "compact", format: "rich" },
};

/**
 * Config subset that requires an adapter restart. Cosmetic changes (theme,
 * scheme, language, title style) are applied live and must not reconnect bots.
 */
export function transportFingerprint(cfg: BridgeConfig): string {
  return JSON.stringify({
    telegram: {
      token: cfg.telegram.token,
      enabled: cfg.telegram.enabled !== false,
      proxy: cfg.telegram.proxy ?? "",
      apiIp: cfg.telegram.apiIp ?? "",
    },
    discord: {
      token: cfg.discord?.token ?? "",
      enabled: Boolean(cfg.discord?.enabled),
      allowedGuilds: cfg.discord?.allowedGuilds ?? [],
      allowedUsers: cfg.discord?.allowedUsers ?? [],
      mode: cfg.discord?.mode ?? "threads",
    },
    mode: cfg.mode,
    topicsChatId: cfg.topicsChatId ?? 0,
    autoTopics: cfg.autoTopics !== false,
    stream: {
      editIntervalMs: cfg.stream.editIntervalMs,
      showTools: cfg.stream.showTools,
      format: cfg.stream.format ?? "rich",
    },
  });
}

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
    if (!hasPersistedFile(configPath)) {
      const text = readJsonFile(legacyConfig);
      if (text !== undefined) atomicWrite(configPath, JSON.stringify(text, null, 2) + "\n");
    }
    const legacyState = join(exeDir, "state.json");
    const statePath = join(dataDir, "state.json");
    if (!existsSync(legacyState)) return;
    const legacy = (readJsonFile(legacyState) ?? {}) as Record<string, any>;
    const current = (readJsonFile(statePath) ?? {}) as Record<string, any>;
    const merged: Record<string, any> = {
      ...current,
      topics: { ...(legacy.topics ?? {}), ...(current.topics ?? {}) },
      chats: { ...(legacy.chats ?? {}), ...(current.chats ?? {}) },
      sessions: { ...(legacy.sessions ?? {}), ...(current.sessions ?? {}) },
    };
    atomicWrite(statePath, JSON.stringify(merged, null, 2));
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
  if (!hasPersistedFile(paths.configFile)) {
    atomicWrite(paths.configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", { backup: false });
    return structuredClone(DEFAULT_CONFIG);
  }
  const stored = readJsonFile(paths.configFile);
  const raw = (stored && typeof stored === "object" ? stored : {}) as Partial<BridgeConfig>;
  return {
    telegram: {
      token: raw.telegram?.token ?? "",
      enabled: raw.telegram?.enabled !== false,
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
      titleStatus: raw.discord?.titleStatus === "rename" ? "rename" : "off",
    },
    opencode: { baseUrl: raw.opencode?.baseUrl, password: raw.opencode?.password },
    mode: raw.mode ?? DEFAULT_CONFIG.mode,
    showSubagents: normalizeSubagentMode(raw.showSubagents ?? "auto"),
    media: {
      relay: raw.media?.relay === "none" || raw.media?.relay === "user" ? raw.media.relay : "all",
      maxPhotoMb: clampNumber(raw.media?.maxPhotoMb, 1, 10, 10),
    },
    update: {
      checkOnStart: raw.update?.checkOnStart !== false,
      intervalHours: clampNumber(raw.update?.intervalHours, 1, 168, 6),
      autoDownload: raw.update?.autoDownload === true,
    },
    notify: {
      enabled: raw.notify?.enabled !== false,
      targets:
        raw.notify?.targets === "all"
          ? "all"
          : Array.isArray(raw.notify?.targets)
            ? raw.notify.targets.map((id) => String(id).trim()).filter(Boolean)
            : "admin",
    },
    topicsChatId: raw.topicsChatId,
    defaultDirectory: raw.defaultDirectory,
    autoTopics: raw.autoTopics ?? true,
    budget: {
      perTurnUsd: readUsd(raw.budget?.perTurnUsd),
      dailyUsd: readUsd(raw.budget?.dailyUsd),
      action: raw.budget?.action === "stop" ? "stop" : "warn",
    },
    permissions: {
      mode: isPermissionMode(raw.permissions?.mode) ? raw.permissions.mode : "ask",
    },
    ui: {
      theme: raw.ui?.theme ?? "opencode",
      scheme: raw.ui?.scheme ?? "system",
      lang: raw.ui?.lang ?? "system",
      titleStatus: normalizeTitleStatus(raw.ui?.titleStatus),
      seenChangelog: Array.isArray(raw.ui?.seenChangelog) ? raw.ui.seenChangelog.map(String) : [],
    },
    web: { port: raw.web?.port ?? DEFAULT_CONFIG.web.port },
    stream: { ...DEFAULT_CONFIG.stream, ...(raw.stream ?? {}) },
  };
}

/** True once a bot token is present and the adapter is enabled; the bot itself can start. */
export function isConfigured(cfg: BridgeConfig): boolean {
  return Boolean(cfg.telegram.enabled !== false && cfg.telegram.token);
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

/** Positive USD amount with two decimals; empty/invalid means "no cap". */
function readUsd(value: unknown): number | undefined {
  if (value === "" || value === null || value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.round(number * 100) / 100;
}

/**
 * The installer never rewrites config.json (it would drop unrelated sections).
 * It leaves installer.json with optional overrides; they are merged once here.
 * On a fresh config (user deleted config.json) the remembered wizard answers
 * (mode, folder, topics chat, language) are used as defaults too.
 */
export function applyInstallerOverrides(paths: Paths, cfg: BridgeConfig, configExisted: boolean): boolean {
  const file = join(dirname(paths.configFile), "installer.json");
  if (!existsSync(file)) return false;
  const record = readInstallerState(file);
  if (!record) return false;
  const overrides = record.config;
  let changed = false;
  if (!configExisted) {
    const remembered = installerDefaults(record);
    if (remembered.mode && cfg.mode === DEFAULT_CONFIG.mode) {
      cfg.mode = remembered.mode;
      changed = true;
    }
    if (remembered.defaultDirectory && !cfg.defaultDirectory) {
      cfg.defaultDirectory = remembered.defaultDirectory;
      changed = true;
    }
    if (remembered.topicsChatId && !cfg.topicsChatId) {
      cfg.topicsChatId = remembered.topicsChatId;
      changed = true;
    }
    if (remembered.lang) {
      cfg.ui = { ...(cfg.ui ?? {}), lang: remembered.lang };
      changed = true;
    }
  }
  if (overrides && !(record.configOnlyIfNew === true && configExisted)) {
    const token = typeof overrides.telegramToken === "string" ? overrides.telegramToken.trim() : "";
    if (token && !/^[*•]+/.test(token)) {
      cfg.telegram.token = token;
      changed = true;
    }
    if (overrides.mode === "topics" || overrides.mode === "private" || overrides.mode === "both") {
      cfg.mode = overrides.mode;
      changed = true;
    }
    if (typeof overrides.defaultDirectory === "string" && overrides.defaultDirectory.trim()) {
      cfg.defaultDirectory = overrides.defaultDirectory.trim();
      changed = true;
    }
    const lang = overrides.lang;
    if (lang === "ru" || lang === "en" || lang === "system") {
      cfg.ui = { ...(cfg.ui ?? {}), lang };
      changed = true;
    }
    const topics = Number(overrides.topicsChatId);
    if (Number.isFinite(topics) && topics !== 0) {
      cfg.topicsChatId = topics;
      changed = true;
    }
    if (changed) saveConfig(paths, cfg);
  }
  // Keep install kind/directory/autostart/language for the next wizard run,
  // drop one-shot overrides, never store secrets.
  const kept: InstallerState = { ...record };
  kept.config = undefined;
  kept.configOnlyIfNew = undefined;
  kept.configAppliedAt = new Date().toISOString();
  // Mirror the effective non-secret choices so the wizard sees them even when
  // the user changed them in the panel between installs.
  if (!kept.mode) kept.mode = cfg.mode;
  if (!kept.defaultDirectory && cfg.defaultDirectory) kept.defaultDirectory = cfg.defaultDirectory;
  if (!kept.topicsChatId && cfg.topicsChatId) kept.topicsChatId = cfg.topicsChatId;
  if (!kept.language && (cfg.ui?.lang === "ru" || cfg.ui?.lang === "en")) kept.language = cfg.ui.lang;
  try {
    writeInstallerState(file, kept);
  } catch {
    /* best-effort */
  }
  return changed;
}

export function saveConfig(paths: Paths, cfg: BridgeConfig): void {
  atomicWrite(paths.configFile, JSON.stringify(cfg, null, 2) + "\n");
}

export function findUser(cfg: BridgeConfig, userId: number): UserConfig | undefined {
  return cfg.telegram.allowedUsers.find((u) => u.id === userId);
}

export function isAdmin(cfg: BridgeConfig, userId: number): boolean {
  return findUser(cfg, userId)?.role === "admin";
}
