/** Discord hard limit is 2000 chars; keep headroom for edits and footers. */
export const DISCORD_CHUNK = 1900;

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

/** Marker (` ``` ` / `~~~`) that closes a fence opened by `line`. */
function fenceMarker(line: string): string {
  return FENCE_OPEN.exec(line)?.[1] ?? "```";
}

/**
 * Splits text on line boundaries, hard-splitting any single overlong line.
 * A chunk never ends inside a fenced code block: the fence is closed at the
 * end of the chunk and reopened (with its language tag) in the next one.
 */
export function chunkText(text: string, limit = DISCORD_CHUNK): string[] {
  const value = text.replace(/\r\n/g, "\n");
  if (value.length <= limit) return [value];

  const chunks: string[] = [];
  let current = "";
  /** Opening fence line while the current chunk is inside a code block. */
  let fence: string | undefined;

  const push = (close: boolean) => {
    const body = close && fence ? `${current}\n${fenceMarker(fence)}` : current;
    if (body.trim()) chunks.push(body);
    current = "";
  };

  for (const line of value.split("\n")) {
    const closesFence = fence !== undefined && FENCE_CLOSE.test(line);

    if (line.length > limit) {
      push(true);
      const room = Math.max(1, limit - (fence ? fenceMarker(fence).length + 1 : 0));
      let rest = line;
      while (rest.length > room) {
        const piece = rest.slice(0, room);
        rest = rest.slice(room);
        current = fence ? `${fence}\n${piece}` : piece;
        push(true);
      }
      current = fence ? `${fence}\n${rest}` : rest;
      continue;
    }

    const overhead = fence && !closesFence ? fenceMarker(fence).length + 1 : 0;
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length + overhead > limit) {
      push(true);
      current = fence ? `${fence}\n${line}` : line;
    } else {
      current = candidate;
    }

    if (fence) {
      if (closesFence) fence = undefined;
    } else if (FENCE_OPEN.test(line)) {
      fence = line.trim();
    }
  }
  push(false);
  return chunks.length ? chunks : [""];
}

/** `#### title` and deeper → bold; Discord only renders `#`, `##`, `###`. */
function demoteHeading(line: string): string {
  const match = /^\s*(#{4,6})\s+(.*?)\s*$/.exec(line);
  if (!match) return line;
  const text = (match[2] ?? "").replace(/\s+#+\s*$/, "").trim();
  return text ? `**${text}**` : line;
}

/** Splits one pipe-table row into trimmed cells. */
function tableCells(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map((cell) => cell.trim());
}

/** `|---|---|` style alignment row. */
function isSeparatorRow(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|/.test(line) && line.includes("-") && line.includes("|");
}

const TABLE_CELL_LIMIT = 32;
const TABLE_TOTAL_LIMIT = 72;
const TABLE_MAX_COLUMNS = 4;

/** Wraps a cell by words into lines of at most `limit` characters. */
function wrapCell(value: string, limit: number): string[] {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    let rest = word;
    while (rest.length > limit) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    if (!rest) continue;
    if (!current) current = rest;
    else if (current.length + 1 + rest.length <= limit) current += ` ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  if (current || !lines.length) lines.push(current);
  return lines;
}

/**
 * Wide tables do not fit a Discord code block, so they become a compact list:
 *
 *   **A · B · C**
 *   - A: 1 · B: 2 · C: 3
 *
 * Narrow tables stay aligned in a fenced block with cells wrapped to 32 chars.
 */
function renderTable(rows: string[]): string[] {
  const grid = rows.map(tableCells);
  const headers = grid[0] ?? [];
  const columns = Math.max(headers.length, ...grid.map((cells) => cells.length));
  const body = grid.slice(2).map((cells) => Array.from({ length: columns }, (_, index) => cells[index] ?? ""));

  const widths: number[] = [];
  for (let column = 0; column < columns; column += 1) {
    let width = 3;
    const cells = [headers[column] ?? "", ...body.map((row) => row[column] ?? "")];
    for (const cell of cells) {
      for (const line of wrapCell(cell, TABLE_CELL_LIMIT)) width = Math.max(width, line.length);
    }
    widths.push(Math.min(TABLE_CELL_LIMIT, width));
  }

  const total = 1 + widths.reduce((sum, width) => sum + width, 0) + 3 * columns;
  if (columns > TABLE_MAX_COLUMNS || total > TABLE_TOTAL_LIMIT) return renderTableList(headers, body, columns);

  const out = ["```"];
  const headerCells = Array.from({ length: columns }, (_, index) => headers[index] ?? "");
  const headerLines = renderWrappedRow(headerCells, widths);
  out.push(...headerLines);
  out.push(`| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`);
  for (const row of body) out.push(...renderWrappedRow(row, widths));
  out.push("```");
  return out;
}

/** One logical row as several physical lines of `| cell |` text. */
function renderWrappedRow(cells: string[], widths: number[]): string[] {
  const wrapped = cells.map((cell, index) => wrapCell(cell, widths[index] ?? TABLE_CELL_LIMIT));
  const height = Math.max(...wrapped.map((lines) => lines.length));
  const out: string[] = [];
  for (let line = 0; line < height; line += 1) {
    const parts = wrapped.map((lines, index) => (lines[line] ?? "").padEnd(widths[index] ?? TABLE_CELL_LIMIT));
    out.push(`| ${parts.join(" | ")} |`);
  }
  return out;
}

function renderTableList(headers: string[], body: string[][], columns: number): string[] {
  const labels = Array.from({ length: columns }, (_, index) => (headers[index] ?? "").replace(/\s+/g, " ").trim());
  const out = [`**${labels.filter(Boolean).join(" · ")}**`];
  for (const row of body) {
    const cells = row.map((cell, index) => {
      const value = cell.replace(/\s+/g, " ").trim();
      const label = labels[index];
      return label ? `${label}: ${value}` : value;
    });
    out.push(`- ${cells.filter(Boolean).join(" · ")}`);
  }
  return out;
}

/**
 * Makes agent Markdown closer to Telegram output for Discord:
 * tables become aligned code blocks, `####`..`######` become bold.
 * Text inside fenced code blocks and everything else is left untouched.
 */
export function toDiscordMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (inFence) {
      out.push(line);
      if (FENCE_CLOSE.test(line)) inFence = false;
      continue;
    }
    if (FENCE_OPEN.test(line)) {
      inFence = true;
      out.push(line);
      continue;
    }

    const next = lines[index + 1];
    if (line.includes("|") && next !== undefined && isSeparatorRow(next)) {
      const rows = [line, next];
      let cursor = index + 2;
      while (cursor < lines.length) {
        const row = lines[cursor] ?? "";
        if (!row.trim() || !row.includes("|") || FENCE_OPEN.test(row)) break;
        rows.push(row);
        cursor += 1;
      }
      out.push(...renderTable(rows));
      index = cursor - 1;
      continue;
    }

    out.push(demoteHeading(line));
  }
  return out.join("\n");
}

/** Discord thread names are capped at 100 chars. */
export function threadName(title: string, fallback = "OpenCode"): string {
  const value = title.replace(/\s+/g, " ").trim();
  return (value || fallback).slice(0, 100);
}

/** One-line session title from a prompt (60 chars per spec). */
export function titleFromText(text: string, fallback = "Discord session"): string {
  const value = text.replace(/\s+/g, " ").trim();
  return (value || fallback).slice(0, 60);
}

export function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Drops existing Markdown quote markers so text is never quoted twice (`> > `). */
export function stripQuote(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join("\n");
}

/**
 * Builds one Discord blockquote: `> header` immediately followed by every
 * non-empty body line as `> line`, then optional `> footer` lines. Blank lines
 * are skipped because Discord renders a bare `>` as visible text. Existing `>`
 * prefixes in the body are stripped first, so the result never contains `> >`.
 */
export function quoteBlock(header: string, body: string, footer?: string): string {
  const lines = [`> ${stripQuote(header)}`];
  const push = (value: string) => {
    const line = stripQuote(value);
    if (line.trim()) lines.push(`> ${line}`);
  };
  for (const line of body.split("\n")) push(line);
  if (footer) {
    for (const line of footer.split("\n")) push(line);
  }
  return lines.join("\n");
}

/**
 * Discord italics are `_text_`; underscores/asterisks/backticks inside the text
 * break the markup, so such a line falls back to plain text.
 */
export function italicLine(text: string): string {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (/[*_~`\\]/.test(value)) return value;
  return `_${value}_`;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
