import { describe, expect, test } from "bun:test";
import {
  contextTokensOf,
  formatTokens,
  formatUptime,
  statusReport,
  statusReportHtml,
  statusReportMarkdown,
  statusReportText,
  type StatusReportInput,
} from "../src/status.ts";

const input: StatusReportInput = {
  version: "0.8.1",
  uptimeMs: 3_900_000,
  adapters: {
    telegram: { enabled: true, state: "running", network: "direct", username: "SRLAgent" },
    discord: { enabled: false, state: "off" },
  },
  opencode: { version: "2.3.2", url: "http://127.0.0.1:28894" },
  session: {
    title: "Ordering fixes",
    id: "ses_abc123",
    directory: "D:\\Home\\Mike\\Work\\Test",
    model: "DeepSeek V4.1 Flash",
    agent: "general",
    busy: true,
    tokens: { input: 10_000, output: 2_000, reasoning: 345, cache: { read: 0, write: 0 } },
    cost: 0.0123,
  },
  sessions: 7,
};

describe("status report formatting", () => {
  test("uptime and token counters are compact", () => {
    expect(formatUptime(42_000)).toBe("42с");
    expect(formatUptime(300_000)).toBe("5м");
    expect(formatUptime(3_900_000)).toBe("1ч 5м");
    expect(formatTokens(12_345)).toBe("12 345");
    expect(formatTokens(0)).toBe("0");
  });

  test("context = input + cache.read + output + reasoning", () => {
    expect(contextTokensOf({ input: 10, output: 2, reasoning: 3, cache: { read: 5 } })).toBe(20);
    expect(contextTokensOf(undefined)).toBeUndefined();
  });

  test("one message covers version, uptime, adapters, OpenCode and the session", () => {
    const report = statusReport(input);
    expect(report.header).toBe("OpenCode Bridge 0.8.1");
    expect(report.meta).toBe("uptime 1ч 5м");
    const text = statusReportText(report);
    expect(text).toContain("📡 Telegram: вкл · running · direct · @SRLAgent");
    expect(text).toContain("📡 Discord: выкл · off");
    expect(text).toContain("🧠 OpenCode: 2.3.2 · http://127.0.0.1:28894");
    expect(text).toContain("🗂 Ordering fixes");
    expect(text).toContain("# id: ses_abc123");
    expect(text).toContain("📁 папка: D:\\Home\\Mike\\Work\\Test");
    expect(text).toContain("🤖 модель: DeepSeek V4.1 Flash");
    expect(text).toContain("🧩 агент: general");
    expect(text).toContain("⏱ сессия: работает");
    expect(text).toContain("контекст 12 345");
    expect(text).toContain("вход 10 000");
    expect(text).toContain("💰 стоимость: $0.0123");
    expect(text).toContain("🗂 сессий: 7");
  });

  test("Telegram HTML keeps ids/directories in code and escapes markup", () => {
    const html = statusReportHtml(
      statusReport({ ...input, session: { ...input.session!, title: "a<b>", directory: "D:\\x&y" } }),
    );
    expect(html.startsWith("📊 <b>OpenCode Bridge 0.8.1</b> · uptime 1ч 5м")).toBe(true);
    expect(html).toContain("<b>a&lt;b&gt;</b>");
    expect(html).toContain("<code>D:\\x&amp;y</code>");
    expect(html).toContain("📡 Telegram: вкл · running · direct · @SRLAgent");
  });

  test("Discord markdown bolds the title and uses backticks", () => {
    const markdown = statusReportMarkdown(statusReport(input));
    expect(markdown).toContain("**Ordering fixes**");
    expect(markdown).toContain("`ses_abc123`");
    expect(markdown).toContain("💰 стоимость: $0.0123");
  });

  test("no active session still reports bridge and OpenCode", () => {
    const text = statusReportText(statusReport({ ...input, session: undefined }));
    expect(text).toContain("🗂 сессия: нет активной");
    expect(text).toContain("🧠 OpenCode: 2.3.2");
    expect(text).not.toContain("модель:");
  });
});
