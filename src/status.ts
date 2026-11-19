/**
 * Pure status-block rendering shared by Telegram and Discord.
 *
 * Layout is always three (or more) physical lines, each self-contained:
 *
 *   🟢 **DeepSeek V4.1 Flash** · thinking… 12s
 *   🛠 Fix subagent live lines · 1s ✓
 *   🧩 general · 5s
 *
 * Callers must keep the newlines intact. Model name is the only bold part;
 * labels are stripped of Markdown emphasis characters so `**` / `_` can never
 * end up unbalanced (and never leak as literal asterisks into HTML mode).
 */

export interface StatusItem {
  icon: string;
  label: string;
  count?: number;
  duration: string;
  mark?: string;
}

export interface StatusSnapshot {
  model: string;
  phase: string;
  elapsed: string;
  tools: StatusItem[];
  subagents: StatusItem[];
}

/** One-line, emphasis-free, ≤60-char label; never the bare word `tool`. */
export function statusLabel(value: string): string {
  let text = String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/^tool\s+/i, "").replace(/^tool$/i, "");
  text = text.replace(/[*_~`\\]/g, "");
  text = text.trim();
  if (!text) text = "call";
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function itemLine(item: StatusItem, escape: (value: string) => string, bullet: boolean): string {
  const count = item.count && item.count > 1 ? ` ×${item.count}` : "";
  const mark = item.mark ? ` ${item.mark}` : "";
  const prefix = bullet ? "- " : "";
  return `${prefix}${item.icon} ${escape(statusLabel(item.label))}${count} · ${item.duration}${mark}`;
}

/**
 * Telegram Rich Message markdown. Only the model name is bold; every card is a
 * list item, because a single "\n" is collapsed into a space by rich markdown.
 */
export function statusMarkdown(snapshot: StatusSnapshot, bulletItems = false): string {
  const identity = (value: string) => value;
  const lines = [`🟢 **${statusLabel(snapshot.model)}** · ${snapshot.phase} ${snapshot.elapsed}`];
  for (const item of snapshot.tools) lines.push(itemLine(item, identity, bulletItems));
  for (const item of snapshot.subagents) lines.push(itemLine(item, identity, bulletItems));
  return lines.join("\n");
}

/** Telegram status with guaranteed per-item lines (`- ` bullets). */
export function statusMarkdownList(snapshot: StatusSnapshot): string {
  return statusMarkdown(snapshot, true);
}

/** Classic Telegram `parse_mode: "HTML"` variant of the same block. */
export function statusHtml(snapshot: StatusSnapshot): string {
  const lines = [`🟢 <b>${escapeHtml(statusLabel(snapshot.model))}</b> · ${escapeHtml(snapshot.phase)} ${snapshot.elapsed}`];
  for (const item of snapshot.tools) lines.push(itemLine(item, escapeHtml, true));
  for (const item of snapshot.subagents) lines.push(itemLine(item, escapeHtml, true));
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
