/** Discord hard limit is 2000 chars; keep headroom for edits and footers. */
export const DISCORD_CHUNK = 1900;

/** Splits text on line boundaries, hard-splitting any single overlong line. */
export function chunkText(text: string, limit = DISCORD_CHUNK): string[] {
  const value = text.replace(/\r\n/g, "\n");
  if (value.length <= limit) return [value];

  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current);
    current = "";
  };

  for (const line of value.split("\n")) {
    if (line.length > limit) {
      push();
      for (let index = 0; index < line.length; index += limit) {
        chunks.push(line.slice(index, index + limit));
      }
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      push();
      current = line;
    } else {
      current = candidate;
    }
  }
  push();
  return chunks.length ? chunks : [""];
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
