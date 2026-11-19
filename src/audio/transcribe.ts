import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../log.ts";
import { toWav } from "./ffmpeg.ts";

export type TranscribeResult =
  | { ok: true; text: string; elapsedMs: number }
  | { ok: false; reason: "disabled" | "no-hex" | "failed"; message: string };

export function hexCliPath(): string | undefined {
  if (process.env.HEX_CLI && existsSync(process.env.HEX_CLI)) return process.env.HEX_CLI;
  const root = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "hex");
  const candidates: string[] = [];
  try {
    const version = readFileSync(join(root, "current-version"), "utf8").trim();
    if (version) candidates.push(join(root, "versions", version, "hex.com"));
  } catch {
    /* ignore */
  }
  candidates.push(join(root, "bin", "hex.com"));
  for (const path of candidates) if (existsSync(path)) return path;
  return undefined;
}

/** Transcribes any audio file HEX accepts (wav, ogg/opus, mp3, …). */
export async function transcribeAudio(buffer: Buffer, extension: string): Promise<TranscribeResult> {
  const startedAt = Date.now();
  const cli = hexCliPath();
  if (!cli) return { ok: false, reason: "no-hex", message: "HEX не найден" };

  let wav = buffer;
  if (!/^wav$/i.test(extension.replace(/^\./, ""))) {
    try {
      wav = await toWav(buffer);
    } catch (error) {
      return { ok: false, reason: "failed", message: `конвертация в WAV: ${(error as Error).message}` };
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "ocbridge-audio-"));
  const file = join(dir, "voice.wav");
  writeFileSync(file, wav);
  try {
    const { stdout, stderr, code } = await run(cli, ["transcribe", "--json", file]);
    const json = parse(stdout);
    if (json?.status === "error") {
      const errorCode = String(json.code ?? "");
      if (errorCode === "disabled") return { ok: false, reason: "disabled", message: String(json.message ?? "") };
      return { ok: false, reason: "failed", message: String(json.message ?? errorCode ?? "ошибка HEX") };
    }
    const text = pickText(json) ?? (stdout.trim() && !stdout.trim().startsWith("{") ? stdout.trim() : undefined);
    if (code !== 0 || !text) return { ok: false, reason: "failed", message: stderr.trim() || "пустой ответ HEX" };
    return { ok: true, text, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, reason: "failed", message: (error as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function enableHexFileTranscription(): Promise<boolean> {
  const cli = hexCliPath();
  if (!cli) return false;
  const { code } = await run(cli, ["labs", "on", "transcribe-files"]);
  log.info(`hex labs on transcribe-files -> ${code}`);
  return code === 0;
}

function run(exe: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => resolve({ stdout, stderr: stderr + error.message, code: 1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function pickText(json: Record<string, unknown> | undefined): string | undefined {
  if (!json) return undefined;
  for (const key of ["text", "transcript", "transcription", "result"]) {
    const value = json[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).text;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return undefined;
}
