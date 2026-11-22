import { describe, expect, test } from "bun:test";
import { statusHtml, statusLabel, statusMarkdown, statusMarkdownList, type StatusSnapshot } from "../src/status.ts";

const snapshot: StatusSnapshot = {
  model: "OpenCode",
  phase: "thinking…",
  elapsed: "12s",
  tools: [
    { icon: "🛠", label: 'tool edit "src/bot.ts"', code: true, duration: "3s", mark: "✓" },
    { icon: "🔍", label: "grep permission", duration: "1s", mark: "✓", count: 3 },
  ],
  subagents: [{ icon: "🧩", label: "explore", duration: "5s" }],
};

describe("statusLabel", () => {
  test("drops the word tool and collapses whitespace", () => {
    expect(statusLabel("tool   edit\nbot.ts")).toBe("edit bot.ts");
    expect(statusLabel("TOOL")).toBe("call");
    expect(statusLabel("")).toBe("call");
  });

  test("truncates on a word boundary without a dangling backslash", () => {
    const label = statusLabel(`edit D:\\very\\long\\path\\${"x".repeat(80)}\\file.ts`);
    expect(label.length).toBeLessThanOrEqual(61);
    expect(label.endsWith("…")).toBe(true);
    expect(label).not.toMatch(/\\…$/);
  });
});

describe("status composition", () => {
  test("never renders the literal OpenCode as a model", () => {
    const text = statusMarkdown(snapshot);
    expect(text).toContain("**unknown model**");
    expect(text).not.toContain("**OpenCode**");
  });

  test("list variant puts every item on its own bullet line", () => {
    const text = statusMarkdownList(snapshot);
    const lines = text.split("\n");
    expect(lines[0]).toContain("thinking. 12s");
    expect(lines[1]).toStartWith("- 🛠 `edit");
    expect(lines[2]).toContain("×3");
    expect(lines[3]).toStartWith("- 🧩 explore");
  });

  test("a running tool gets a spinner frame before its icon", () => {
    const text = statusMarkdownList({
      ...snapshot,
      frame: 3,
      tools: [{ icon: "🛠", label: "edit bot.ts", duration: "3s", active: true }],
    });
    expect(text.split("\n")[1]).toStartWith("- ⠸ 🛠 edit bot.ts · 3s");
  });

  test("html variant escapes markup and keeps the count/mark", () => {
    const text = statusHtml({ ...snapshot, tools: [{ icon: "🛠", label: "a<b>", duration: "2s", mark: "✓" }] });
    expect(text).toContain("<b>unknown model</b>");
    expect(text).toContain("a&lt;b&gt;");
    expect(text).toContain("2s ✓");
  });
});
