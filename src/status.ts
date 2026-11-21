/**
 * Pure status-block rendering shared by Telegram and Discord.
 *
 * Layout is always a header line plus one `- ` bullet per tool/agent:
 *
 *   🟢 **DeepSeek V4.1 Flash** · thinking… 12s
 *   - 🛠 `cd 'D:\Home\Mike\Work\Test\opencode-telegram-bridge'` · 13s
 *   - 🧩 general · 5s
 *
 * Only the model name is bold. Tool labels are wrapped in inline code, so
 * Windows paths keep their backslashes; plain labels escape Markdown specials.
 */

import { sanitizeModelName } from "./model.ts";

export interface StatusItem {
  icon: string;
  label: string;
  /** Render the label as inline code (tool names/arguments with paths). */
  code?: boolean;
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

/** One-line label; never the bare word `tool`; ≤60 chars on a word/path boundary. */
export function statusLabel(value: string): string {
  let text = String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/^tool\s+/i, "").replace(/^tool$/i, "");
  if (!text) text = "call";
  return truncateLabel(text, 60);
}

/**
 * Cuts to `max` chars at a space / slash / backslash / quote boundary and adds
 * `…`. Never leaves a dangling backslash or splits a Windows path at `\`.
 */
function truncateLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const boundaries = [" ", "/", "\\", "'", '"'].map((separator) => cut.lastIndexOf(separator));
  const index = Math.max(...boundaries);
  if (index >= Math.floor(max / 2)) cut = cut.slice(0, index);
  cut = cut.replace(/\\+$/g, "").trimEnd();
  if (!cut) cut = text.slice(0, max - 1).replace(/\\+$/g, "");
  return `${cut}…`;
}

/** Escapes Markdown metacharacters for plain (non-code) rich text. */
function escapeMarkdown(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/([*_~[\]`])/g, "\\$1");
}

/** Inline code span; switches to double backticks when the label contains one. */
function inlineCode(text: string): string {
  const fence = text.includes("`") ? "``" : "`";
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function markdownLabel(item: StatusItem): string {
  const label = statusLabel(item.label);
  return item.code ? inlineCode(label) : escapeMarkdown(label);
}

function htmlLabel(item: StatusItem): string {
  const label = escapeHtml(statusLabel(item.label));
  return item.code ? `<code>${label}</code>` : label;
}

function itemLine(item: StatusItem, render: (item: StatusItem) => string, bullet: boolean): string {
  const count = item.count && item.count > 1 ? ` ×${item.count}` : "";
  const mark = item.mark ? ` ${item.mark}` : "";
  const prefix = bullet ? "- " : "";
  return `${prefix}${item.icon} ${render(item)}${count} · ${item.duration}${mark}`;
}

/**
 * Telegram Rich Message markdown. Items can be bullets (Telegram collapses a
 * lone "\n" into a space, a list item is always on its own line) or plain
 * lines (Discord).
 */
export function statusMarkdown(snapshot: StatusSnapshot, bulletItems = false): string {
  const lines = [
    `🟢 **${escapeMarkdown(statusLabel(sanitizeModelName(snapshot.model)))}** · ${snapshot.phase} ${snapshot.elapsed}`,
  ];
  for (const item of snapshot.tools) lines.push(itemLine(item, markdownLabel, bulletItems));
  for (const item of snapshot.subagents) lines.push(itemLine(item, markdownLabel, bulletItems));
  return lines.join("\n");
}

/** Telegram status with guaranteed per-item lines (`- ` bullets). */
export function statusMarkdownList(snapshot: StatusSnapshot): string {
  return statusMarkdown(snapshot, true);
}

/** Classic Telegram `parse_mode: "HTML"` variant of the same block. */
export function statusHtml(snapshot: StatusSnapshot): string {
  const lines = [
    `🟢 <b>${escapeHtml(statusLabel(sanitizeModelName(snapshot.model)))}</b> · ${escapeHtml(snapshot.phase)} ${snapshot.elapsed}`,
  ];
  for (const item of snapshot.tools) lines.push(itemLine(item, htmlLabel, true));
  for (const item of snapshot.subagents) lines.push(itemLine(item, htmlLabel, true));
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
