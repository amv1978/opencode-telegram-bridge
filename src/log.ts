import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let logFile: string | undefined;

export function initLog(file: string): void {
  logFile = file;
  mkdirSync(dirname(file), { recursive: true });
}

function write(level: string, args: unknown[]): void {
  const line = `${new Date().toISOString()} ${level} ${args.map((a) => (typeof a === "string" ? a : safe(a))).join(" ")}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n", "utf8");
    } catch {
      /* logging must never break the bot */
    }
  }
}

function safe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (...a: unknown[]) => write("INFO ", a),
  warn: (...a: unknown[]) => write("WARN ", a),
  error: (...a: unknown[]) => write("ERROR", a),
  debug: (...a: unknown[]) => {
    if (process.env.OCBRIDGE_DEBUG) write("DEBUG", a);
  },
};
