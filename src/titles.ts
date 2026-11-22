/** Topic/thread title markers while a turn runs. */

export type TitlePhase = "idle" | "start" | "done";

/** Telegram topic names are capped at 128 chars, Discord threads at 100. */
export function titleWithMarker(base: string, phase: TitlePhase, limit = 128): string {
  const clean = String(base ?? "").replace(/\s+/g, " ").trim();
  const marker = phase === "start" ? "⏳ " : phase === "done" ? "✅ " : "";
  const text = `${marker}${clean}`.trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1))}…`;
}

/** True when the rate-limit window since the previous rename has passed. */
export function canRename(lastRename: number, now = Date.now(), minMs = 60_000): boolean {
  if (!Number.isFinite(lastRename) || lastRename <= 0) return true;
  return now - lastRename >= minMs;
}

/** Milliseconds until the window opens (0 when a rename is allowed now). */
export function renameWait(lastRename: number, now = Date.now(), minMs = 60_000): number {
  if (!Number.isFinite(lastRename) || lastRename <= 0) return 0;
  return Math.max(0, minMs - (now - lastRename));
}
