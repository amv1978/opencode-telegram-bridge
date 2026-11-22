import { describe, expect, test } from "bun:test";
import { chunkText, toDiscordMarkdown } from "../src/discord/render.ts";

describe("chunkText", () => {
  test("keeps short text intact and respects the limit", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
    const long = Array.from({ length: 50 }, (_, i) => `line ${i} with some words`).join("\n");
    const chunks = chunkText(long, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
  });

  test("closes and reopens a fenced code block at the boundary", () => {
    const code = Array.from({ length: 40 }, (_, i) => `const value${i} = ${i};`).join("\n");
    const chunks = chunkText("```ts\n" + code + "\n```", 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]).toStartWith("```ts\n");
  });
});

describe("toDiscordMarkdown", () => {
  test("keeps narrow tables as an aligned code block", () => {
    const md = ["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
    const out = toDiscordMarkdown(md);
    expect(out.startsWith("```")).toBe(true);
    expect(out).toContain("| a");
    expect(out).toContain("| b");
    expect(out).toContain("|---|---|");
  });

  test("turns wide tables into a list", () => {
    const md = ["| a | b | c | d | e |", "|---|---|---|---|---|", "| 1 | 2 | 3 | 4 | 5 |"].join("\n");
    const out = toDiscordMarkdown(md);
    expect(out).not.toContain("```");
    expect(out).toContain("- ");
  });

  test("demotes deep headings and leaves code untouched", () => {
    const md = ["#### Details", "", "```", "#### not a heading", "```"].join("\n");
    const out = toDiscordMarkdown(md);
    expect(out).toContain("**Details**");
    expect(out).toContain("#### not a heading");
  });
});
