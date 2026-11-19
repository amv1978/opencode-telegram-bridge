const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CODE_TOKEN = "\u0000";

/** Converts the assistant's markdown into the subset of HTML Telegram understands. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const next = lines[i + 1] ?? "";
    if (line.includes("|") && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(next)) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        rows.push(lines[i] ?? "");
        i += 1;
      }
      out.push(`<pre>${escapeHtml(rows.join("\n"))}</pre>`);
      continue;
    }

    if (/^\s*#{1,6}\s+/.test(line)) {
      out.push(`<b>${inline(escapeHtml(line.replace(/^\s*#{1,6}\s+/, "")))}</b>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("──────────");
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      out.push(`▎ ${inline(escapeHtml(line.replace(/^\s*>\s?/, "")))}`);
      i += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      out.push(`• ${inline(escapeHtml(line.replace(/^\s*[-*+]\s+/, "")))}`);
      i += 1;
      continue;
    }

    out.push(inline(escapeHtml(line)));
    i += 1;
  }

  return out.join("\n");
}

function inline(text: string): string {
  const codeSpans: string[] = [];
  let result = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `${CODE_TOKEN}${codeSpans.length - 1}${CODE_TOKEN}`;
  });

  result = result
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>");

  return result.replace(new RegExp(`${CODE_TOKEN}(\\d+)${CODE_TOKEN}`, "g"), (_m, index: string) => codeSpans[Number(index)] ?? "");
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(pre|code|b|i|s|a)>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Splits raw Markdown into chunks under the rich-message limit, keeping code
 * fences balanced by closing and reopening them around each split.
 */
export function splitMarkdown(markdown: string, limit = 30_000): string[] {
  if (markdown.length <= limit) return [markdown];
  const lines = markdown.split("\n");
  const chunks: string[] = [];
  let buffer: string[] = [];
  let size = 0;
  let fence: string | null = null;

  const flush = () => {
    if (!buffer.length) return;
    let text = buffer.join("\n");
    if (fence) text += `\n${fence}`;
    chunks.push(text);
    buffer = fence ? [fence] : [];
    size = buffer.reduce((sum, line) => sum + line.length + 1, 0);
  };

  for (const line of lines) {
    if (line.length + 1 > limit) {
      flush();
      for (let offset = 0; offset < line.length; offset += limit) chunks.push(line.slice(offset, offset + limit));
      continue;
    }
    if (size + line.length + 1 > limit) flush();
    buffer.push(line);
    size += line.length + 1;
    if (/^\s*```/.test(line)) fence = fence ? null : line.trim();
  }

  if (buffer.length) chunks.push(buffer.join("\n"));
  return chunks.length ? chunks : [markdown];
}

/**
 * Splits rendered HTML into Telegram-sized chunks, keeping <pre> blocks valid
 * by closing and reopening them around the split.
 */
export function splitHtml(html: string, limit = 3800): string[] {
  if (html.length <= limit) return [html];
  const blocks = html.split("\n");
  const chunks: string[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.trim()) chunks.push(buffer);
    buffer = "";
  };

  const pushBlock = (block: string) => {
    const separator = buffer ? "\n" : "";
    if (buffer.length + separator.length + block.length <= limit) {
      buffer += separator + block;
      return;
    }
    flush();
    if (block.length <= limit) {
      buffer = block;
      return;
    }
    const wrapped = block.match(/^(<pre[^>]*>(?:<code[^>]*>)?)([\s\S]*?)(<\/code><\/pre>|<\/pre>)$/);
    if (wrapped) {
      const [, open = "", body = "", close = ""] = wrapped;
      const capacity = Math.max(500, limit - open.length - close.length);
      for (let offset = 0; offset < body.length; offset += capacity) {
        chunks.push(open + body.slice(offset, offset + capacity) + close);
      }
      return;
    }
    for (let offset = 0; offset < block.length; offset += limit) chunks.push(block.slice(offset, offset + limit));
  };

  for (const block of blocks) pushBlock(block);
  flush();
  return chunks.length ? chunks : [""];
}
