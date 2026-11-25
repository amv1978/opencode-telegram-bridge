import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "../atomic.ts";

/**
 * The web UI may bind `web.port + N` when the configured port is busy. The
 * Electron shell used to hardcode 7788 and silently talked to nothing, so the
 * bridge publishes the port it actually bound next to `config.json`:
 *
 *   %APPDATA%\opencode-telegram-bridge\port.json
 *
 * The shell reads it first, then `OCBRIDGE_PORT`, then 7788, and passes
 * `--port` when spawning the bridge.
 */
export interface PortInfo {
  port: number;
  pid: number;
  version: string;
  /** Epoch ms of the start that wrote the file. */
  startedAt: number;
}

export function portFilePath(configFile: string): string {
  return join(dirname(configFile), "port.json");
}

/** Tolerates hand-edited or partially written files; `undefined` = unusable. */
export function parsePortInfo(value: unknown): PortInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const pid = Number(raw.pid);
  const startedAt = Number(raw.startedAt);
  return {
    port,
    pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
    version: typeof raw.version === "string" ? raw.version : "",
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0,
  };
}

export function parsePortText(text: string | undefined): PortInfo | undefined {
  if (!text) return undefined;
  try {
    return parsePortInfo(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function readPortFile(file: string): PortInfo | undefined {
  try {
    return parsePortText(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function writePortFile(file: string, info: PortInfo): void {
  atomicWrite(file, `${JSON.stringify(info, null, 2)}\n`, { backup: false });
}

/** A stale file would send the shell to a port nobody listens on. */
export function removePortFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Ports the shell should probe, most specific first: the published port, then
 * `OCBRIDGE_PORT`, then the default and a small range after it (the bridge
 * increments on a busy port before it can rewrite `port.json`).
 */
export function candidatePorts(input: {
  info?: PortInfo;
  env?: string;
  fallback?: number;
  span?: number;
}): number[] {
  const fallback = Number(input.fallback ?? 7788);
  const span = Math.max(1, Math.min(50, Math.round(Number(input.span ?? 10))));
  const result: number[] = [];
  const push = (value: number) => {
    if (Number.isInteger(value) && value > 0 && value <= 65535 && !result.includes(value)) result.push(value);
  };
  if (input.info) push(input.info.port);
  const envPort = Number(String(input.env ?? "").trim());
  if (Number.isFinite(envPort)) push(Math.round(envPort));
  for (let offset = 0; offset < span; offset += 1) push(fallback + offset);
  return result;
}
