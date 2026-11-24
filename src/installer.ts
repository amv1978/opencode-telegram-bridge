import { existsSync } from "node:fs";
import { atomicWrite, readTextFile } from "./atomic.ts";

/**
 * `installer.json` lives next to `config.json` in
 * `%APPDATA%\opencode-telegram-bridge\`. The Inno Setup wizard writes it on
 * every run and reads it back on the next one, so all choices (install kind,
 * autostart, directory, mode, language, topics chat id) survive a re-run.
 * Secrets are never written here: the wizard masks the token from config.json.
 */
export interface InstallerState {
  version?: string;
  installKind?: "simple" | "advanced";
  /** Install directory (`{app}`), remembered for the next wizard run. */
  directory?: string;
  autostart?: boolean;
  language?: "ru" | "en";
  mode?: "topics" | "private" | "both";
  /** Projects folder chosen on the Telegram page. */
  defaultDirectory?: string;
  topicsChatId?: number;
  writtenAt?: string;
  configAppliedAt?: string;
  /** One-shot config overrides produced by the advanced path. */
  config?: Record<string, unknown>;
  configOnlyIfNew?: boolean;
}

const LANGUAGES = new Set(["ru", "en"]);
const MODES = new Set(["topics", "private", "both"]);

/** Tolerates hand-edited/partial files: unknown keys are kept by the writer. */
export function parseInstallerState(value: unknown): InstallerState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const state: InstallerState = {};
  const text = (key: string): string | undefined => {
    const item = raw[key];
    return typeof item === "string" && item.trim() ? item.trim() : undefined;
  };
  const version = text("version");
  if (version) state.version = version;
  if (raw.installKind === "advanced" || raw.installKind === "simple") state.installKind = raw.installKind;
  const directory = text("directory");
  if (directory) state.directory = directory;
  if (typeof raw.autostart === "boolean") state.autostart = raw.autostart;
  const language = text("language");
  if (language && LANGUAGES.has(language)) state.language = language as "ru" | "en";
  const mode = text("mode");
  if (mode && MODES.has(mode)) state.mode = mode as InstallerState["mode"];
  const defaultDirectory = text("defaultDirectory");
  if (defaultDirectory) state.defaultDirectory = defaultDirectory;
  const topics = Number(raw.topicsChatId);
  if (Number.isFinite(topics) && topics !== 0) state.topicsChatId = topics;
  const writtenAt = text("writtenAt");
  if (writtenAt) state.writtenAt = writtenAt;
  const configAppliedAt = text("configAppliedAt");
  if (configAppliedAt) state.configAppliedAt = configAppliedAt;
  if (raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)) {
    state.config = raw.config as Record<string, unknown>;
  }
  if (typeof raw.configOnlyIfNew === "boolean") state.configOnlyIfNew = raw.configOnlyIfNew;
  return state;
}

export function readInstallerState(file: string): InstallerState | undefined {
  if (!existsSync(file)) return undefined;
  const text = readTextFile(file);
  if (text === undefined) return undefined;
  try {
    return parseInstallerState(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Merges with whatever the wizard left in the file and writes atomically. */
export function writeInstallerState(file: string, state: InstallerState): void {
  const current = (() => {
    const text = readTextFile(file);
    if (text === undefined) return {} as Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    // `undefined` explicitly drops a one-shot key (e.g. `config`).
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  atomicWrite(file, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Non-secret wizard answers usable as fallbacks for a brand-new config
 * (after the user deleted config.json but kept installer.json).
 */
export function installerDefaults(state: InstallerState | undefined): {
  mode?: "topics" | "private" | "both";
  defaultDirectory?: string;
  topicsChatId?: number;
  lang?: "ru" | "en";
} {
  if (!state) return {};
  const result: { mode?: "topics" | "private" | "both"; defaultDirectory?: string; topicsChatId?: number; lang?: "ru" | "en" } = {};
  if (state.mode) result.mode = state.mode;
  if (state.defaultDirectory) result.defaultDirectory = state.defaultDirectory;
  if (state.topicsChatId) result.topicsChatId = state.topicsChatId;
  if (state.language) result.lang = state.language;
  return result;
}

/** Convenience for tests and diagnostics: every remembered choice, no secrets. */
export function rememberedChoices(state: InstallerState | undefined): Record<string, unknown> {
  if (!state) return {};
  return {
    installKind: state.installKind ?? "simple",
    directory: state.directory,
    autostart: state.autostart ?? false,
    language: state.language,
    mode: state.mode,
    defaultDirectory: state.defaultDirectory,
    topicsChatId: state.topicsChatId,
  };
}
