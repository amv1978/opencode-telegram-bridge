import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.ts";

/**
 * Atomic JSON writes: serialize to `<file>.tmp`, keep the previous good file as
 * `<file>.bak`, then rename over the target. A crash (or a full disk) leaves
 * either the old file or the new one, never a truncated config/state.
 */
export function atomicWrite(file: string, data: string, options: { backup?: boolean } = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, data, "utf8");
  if (options.backup !== false && existsSync(file)) {
    try {
      copyFileSync(file, `${file}.bak`);
    } catch (error) {
      log.warn(`backup ${file} failed:`, (error as Error).message);
    }
  }
  renameSync(tmp, file);
}

export function readTextFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return undefined;
  }
}

/**
 * Reads JSON, falling back to `<file>.bak` when the main file is missing or
 * corrupt. Returns `undefined` only when neither file can be parsed, so callers
 * can distinguish "no data yet" from "recovered".
 */
export function readJsonFile(file: string): unknown {
  const candidates = [file, `${file}.bak`];
  for (const candidate of candidates) {
    const text = readTextFile(candidate);
    if (text === undefined) continue;
    try {
      return JSON.parse(text);
    } catch (error) {
      log.warn(`json ${candidate} is corrupt: ${(error as Error).message}`);
    }
  }
  return undefined;
}

/** True when either the file or its backup exists (something to restore/migrate). */
export function hasPersistedFile(file: string): boolean {
  return existsSync(file) || existsSync(`${file}.bak`);
}
