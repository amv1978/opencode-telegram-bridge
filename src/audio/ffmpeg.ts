import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Locates ffmpeg: env override, next to the executable, or PATH. */
export function ffmpegPath(): string {
  const env = process.env.FFMPEG_PATH;
  if (env && existsSync(env)) return env;
  const beside = join(dirname(process.execPath), "ffmpeg.exe");
  if (existsSync(beside)) return beside;
  const local = join(process.cwd(), "dist", "ffmpeg.exe");
  if (existsSync(local)) return local;
  return "ffmpeg";
}

/**
 * Transcodes any audio Buffer to 16 kHz mono WAV (HEX only accepts WAV).
 * Uses temp files because a WAV written to a pipe has a streaming header
 * that HEX rejects.
 */
export async function toWav(input: Buffer): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-ffmpeg-"));
  const source = join(dir, "input.bin");
  const target = join(dir, "output.wav");
  writeFileSync(source, input);
  try {
    await run(["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-ar", "16000", "-ac", "1", target]);
    return readFileSync(target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => reject(new Error(`ffmpeg не запустился: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg: ${stderr.trim() || `код ${code}`}`));
    });
  });
}
