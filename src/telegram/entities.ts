export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

/**
 * Converts a Telegram message (text + entities) back into Markdown, so the model
 * receives the user's formatting instead of a flattened string.
 */
export function entitiesToMarkdown(text: string, entities: TgEntity[] = []): string {
  if (!entities.length) return text;
  const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);
  let out = "";
  let cursor = 0;

  for (const entity of sorted) {
    const start = entity.offset;
    const end = entity.offset + entity.length;
    if (start < cursor || start > text.length || end > text.length) continue;
    out += text.slice(cursor, start);
    out += wrap(entity, text.slice(start, end));
    cursor = end;
  }

  return out + text.slice(cursor);
}

function wrap(entity: TgEntity, inner: string): string {
  switch (entity.type) {
    case "bold":
      return `**${inner}**`;
    case "italic":
      return `*${inner}*`;
    case "underline":
      return `__${inner}__`;
    case "strikethrough":
      return `~~${inner}~~`;
    case "spoiler":
      return `||${inner}||`;
    case "code":
      return inner.includes("`") ? `\`\` ${inner} \`\`` : `\`${inner}\``;
    case "pre": {
      const language = entity.language ?? "";
      return `\`\`\`${language}\n${inner}\n\`\`\``;
    }
    case "text_link":
      return entity.url ? `[${inner}](${entity.url})` : inner;
    case "blockquote":
    case "expandable_blockquote":
      return inner
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    default:
      return inner;
  }
}
