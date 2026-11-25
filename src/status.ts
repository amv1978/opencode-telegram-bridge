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
  /** Running item: a spinner frame is drawn before the icon. */
  active?: boolean;
}

export interface StatusSnapshot {
  model: string;
  phase: string;
  elapsed: string;
  tools: StatusItem[];
  subagents: StatusItem[];
  /** Animation frame (changed by the status ticker). */
  frame?: number;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Braille spinner frame; stays stable between two ticks of the same message. */
export function spinnerFrame(frame = 0): string {
  return SPINNER[Math.abs(Math.trunc(frame)) % SPINNER.length] ?? SPINNER[0]!;
}

/** `thinking…` / `subagents…` become `thinking.` / `thinking..` / `thinking...`. */
export function animatedPhase(phase: string, frame = 0): string {
  const dots = ".".repeat((Math.abs(Math.trunc(frame)) % 3) + 1);
  if (phase.endsWith("…") || phase.endsWith("...")) {
    return `${phase.replace(/(…|\.{1,3})$/, "")}${dots}`;
  }
  return phase;
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

function itemLine(item: StatusItem, render: (item: StatusItem) => string, bullet: boolean, frame: number): string {
  const count = item.count && item.count > 1 ? ` ×${item.count}` : "";
  const mark = item.mark ? ` ${item.mark}` : "";
  const prefix = bullet ? "- " : "";
  const spin = item.active && !item.mark ? `${spinnerFrame(frame)} ` : "";
  return `${prefix}${spin}${item.icon} ${render(item)}${count} · ${item.duration}${mark}`;
}

/**
 * Telegram Rich Message markdown. Items can be bullets (Telegram collapses a
 * lone "\n" into a space, a list item is always on its own line) or plain
 * lines (Discord).
 */
export function statusMarkdown(snapshot: StatusSnapshot, bulletItems = false): string {
  const frame = snapshot.frame ?? 0;
  const lines = [
    `🟢 **${escapeMarkdown(statusLabel(sanitizeModelName(snapshot.model)))}** · ${animatedPhase(snapshot.phase, frame)} ${snapshot.elapsed}`,
  ];
  for (const item of snapshot.tools) lines.push(itemLine(item, markdownLabel, bulletItems, frame));
  for (const item of snapshot.subagents) lines.push(itemLine(item, markdownLabel, bulletItems, frame));
  return lines.join("\n");
}

/** Telegram status with guaranteed per-item lines (`- ` bullets). */
export function statusMarkdownList(snapshot: StatusSnapshot): string {
  return statusMarkdown(snapshot, true);
}

/** Classic Telegram `parse_mode: "HTML"` variant of the same block. */
export function statusHtml(snapshot: StatusSnapshot): string {
  const frame = snapshot.frame ?? 0;
  const lines = [
    `🟢 <b>${escapeHtml(statusLabel(sanitizeModelName(snapshot.model)))}</b> · ${escapeHtml(animatedPhase(snapshot.phase, frame))} ${snapshot.elapsed}`,
  ];
  for (const item of snapshot.tools) lines.push(itemLine(item, htmlLabel, true, frame));
  for (const item of snapshot.subagents) lines.push(itemLine(item, htmlLabel, true, frame));
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------- /status text

export interface StatusAdapter {
  enabled: boolean;
  state: string;
  network?: string;
  username?: string;
}

export interface StatusTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface StatusSessionInfo {
  title: string;
  id: string;
  directory?: string;
  model: string;
  agent?: string;
  busy: boolean;
  tokens?: StatusTokens;
  /** Pre-computed context size (input + cache.read + output + reasoning). */
  contextTokens?: number;
  cost?: number;
}

export interface StatusReportInput {
  version: string;
  uptimeMs: number;
  adapters: { telegram: StatusAdapter; discord: StatusAdapter };
  opencode: { version: string; url: string };
  session?: StatusSessionInfo;
  sessions: number;
}

export interface StatusReportRow {
  key: string;
  icon: string;
  label: string;
  value: string;
  code?: boolean;
  bold?: boolean;
}

export interface StatusReport {
  header: string;
  meta: string;
  rows: StatusReportRow[];
}

/** Live daemon facts the adapters cannot read from OpenCode/config alone. */
export interface BridgeRuntimeInfo {
  ocVersion: string;
  ocUrl: string;
  uptimeMs: number;
  telegram: StatusAdapter;
  discord: StatusAdapter;
}

/** `42с`, `5м`, `1ч 5м` — the lifecycle notices use the same shape. */
export function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}м`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}ч ${rest}м` : `${hours}ч`;
}

/** `12345` → `12 345`; token counters are easier to scan with thin groups. */
export function formatTokens(value: number | undefined): string {
  const number = Math.max(0, Math.round(Number(value ?? 0)));
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** OpenCode's context size: input + cache.read + output + reasoning. */
export function contextTokensOf(tokens: StatusTokens | undefined): number | undefined {
  if (!tokens) return undefined;
  return Number(tokens.input ?? 0) + Number(tokens.cache?.read ?? 0) + Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
}

function adapterValue(adapter: StatusAdapter): string {
  const parts = [adapter.enabled ? "вкл" : "выкл", adapter.state || "?"];
  if (adapter.network) parts.push(adapter.network);
  if (adapter.username) parts.push(`@${adapter.username}`);
  return parts.join(" · ");
}

/**
 * Extended text-only `/status`: bridge, adapters, OpenCode and the bound
 * session in one message (not a separate always-last panel message).
 */
export function statusReport(input: StatusReportInput): StatusReport {
  const rows: StatusReportRow[] = [
    { key: "telegram", icon: "📡", label: "Telegram", value: adapterValue(input.adapters.telegram) },
    { key: "discord", icon: "📡", label: "Discord", value: adapterValue(input.adapters.discord) },
    {
      key: "opencode",
      icon: "🧠",
      label: "OpenCode",
      value: `${input.opencode.version || "?"} · ${input.opencode.url || "?"}`,
    },
  ];

  const session = input.session;
  if (!session) {
    rows.push({ key: "session", icon: "🗂", label: "сессия", value: "нет активной" });
  } else {
    rows.push({ key: "session.title", icon: "🗂", label: "", value: session.title, bold: true });
    rows.push({ key: "session.id", icon: "#", label: "id", value: session.id, code: true });
    rows.push({ key: "session.directory", icon: "📁", label: "папка", value: session.directory || "?", code: true });
    rows.push({ key: "session.model", icon: "🤖", label: "модель", value: session.model });
    rows.push({ key: "session.agent", icon: "🧩", label: "агент", value: session.agent || "?" });
    rows.push({ key: "session.busy", icon: "⏱", label: "сессия", value: session.busy ? "работает" : "свободна" });

    const context = session.contextTokens ?? contextTokensOf(session.tokens);
    const tokenParts: string[] = [];
    if (context !== undefined) tokenParts.push(`контекст ${formatTokens(context)}`);
    if (session.tokens?.input !== undefined) tokenParts.push(`вход ${formatTokens(session.tokens.input)}`);
    if (session.tokens?.output !== undefined) tokenParts.push(`выход ${formatTokens(session.tokens.output)}`);
    if (session.tokens?.cache?.read !== undefined) tokenParts.push(`кэш ${formatTokens(session.tokens.cache.read)}`);
    if (tokenParts.length) {
      rows.push({ key: "session.tokens", icon: "🔢", label: "токены", value: tokenParts.join(" · ") });
    }
    rows.push({
      key: "session.cost",
      icon: "💰",
      label: "стоимость",
      value: `$${Number(session.cost ?? 0).toFixed(4)}`,
    });
  }

  rows.push({ key: "sessions", icon: "🗂", label: "сессий", value: String(Math.max(0, input.sessions)) });

  return {
    header: `OpenCode Bridge ${input.version}`,
    meta: `uptime ${formatUptime(input.uptimeMs)}`,
    rows,
  };
}

function rowText(row: StatusReportRow): string {
  const label = row.label ? `${row.label}: ` : "";
  return `${row.icon} ${label}${row.value}`;
}

/** Telegram HTML variant of the extended report. */
export function statusReportHtml(report: StatusReport): string {
  const lines = [`📊 <b>${escapeHtml(report.header)}</b> · ${escapeHtml(report.meta)}`];
  for (const row of report.rows) {
    const label = row.label ? `${escapeHtml(row.label)}: ` : "";
    const value = row.code
      ? `<code>${escapeHtml(row.value)}</code>`
      : row.bold
        ? `<b>${escapeHtml(row.value)}</b>`
        : escapeHtml(row.value);
    lines.push(`${row.icon} ${label}${value}`);
  }
  return lines.join("\n");
}

/** Discord Markdown variant of the same rows. */
export function statusReportMarkdown(report: StatusReport): string {
  const lines = [`📊 **${escapeMarkdown(report.header)}** · ${escapeMarkdown(report.meta)}`];
  for (const row of report.rows) {
    const label = row.label ? `${escapeMarkdown(row.label)}: ` : "";
    const value = row.code
      ? `\`${row.value}\``
      : row.bold
        ? `**${escapeMarkdown(row.value)}**`
        : escapeMarkdown(row.value);
    lines.push(`${row.icon} ${label}${value}`);
  }
  return lines.join("\n");
}

/** Plain text, used by tests and CLI-like fallbacks. */
export function statusReportText(report: StatusReport): string {
  return [`📊 ${report.header} · ${report.meta}`, ...report.rows.map(rowText)].join("\n");
}
