/** Topic/thread title markers while a turn runs. */

export type TitlePhase = "idle" | "start" | "done";

/**
 * How a chat surface reports "turn is running":
 * - `icon` - Telegram forum topic icon (no service messages, default);
 * - `rename` - topic/thread rename (opt-in: each rename posts a service message);
 * - `off` - nothing.
 */
export type TitleStatusMode = "icon" | "rename" | "off";

/** Unknown values fall back to the quiet default, never to renames. */
export function normalizeTitleStatus(value: unknown): TitleStatusMode {
  return value === "rename" || value === "off" ? value : "icon";
}

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

/**
 * Standard Telegram forum topic icons (`getForumTopicIconStickers`), matched by
 * their emoji: the set is server-side, so the id is looked up at runtime and
 * these lists only decide *which* icon means "working" / "done".
 */
const START_ICONS = ["⏳", "⌛", "⏰", "🕐"];
const DONE_ICONS = ["✅", "☑️", "✔️", "🏁"];

function iconKey(value: string): string {
  // Variation selectors differ between clients and the sticker set.
  return value.replace(/\uFE0F/g, "").replace(/\s+/g, "");
}

export interface TopicIconSticker {
  emoji?: string;
  custom_emoji_id?: string;
}

/**
 * Picks the custom emoji id for a phase from the standard topic icon pack.
 * Returns `undefined` when the pack has no suitable icon (the caller then
 * degrades to no status marker instead of sending an invalid id).
 */
export function pickTopicIcon(stickers: TopicIconSticker[], phase: "start" | "done"): string | undefined {
  const wanted = (phase === "start" ? START_ICONS : DONE_ICONS).map(iconKey);
  for (const sticker of stickers ?? []) {
    const id = sticker?.custom_emoji_id;
    if (!id) continue;
    if (wanted.includes(iconKey(String(sticker.emoji ?? "")))) return id;
  }
  return undefined;
}
