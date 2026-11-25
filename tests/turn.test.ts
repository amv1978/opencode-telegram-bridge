import { describe, expect, test } from "bun:test";
import { blockedToolsText, composeTurnFooter, isBlockedToolFailure, isStepLimitReason, shortReason, turnReason, toolsWord } from "../src/turn.ts";
import { StopRegistry } from "../src/stops.ts";

describe("turnReason", () => {
  test("a successful turn has no reason", () => {
    expect(turnReason({ type: "succeeded" })).toBeUndefined();
  });

  test("user interrupt says /stop", () => {
    expect(turnReason({ type: "interrupted", stop: { kind: "user" } })).toBe("⚠️ остановлено: /stop");
  });

  test("budget stop shows spent and limit", () => {
    expect(turnReason({ type: "interrupted", stop: { kind: "budget", amountUsd: 0.42, limitUsd: 1 } })).toBe(
      "⛔ бюджет: $0.4200 из $1.00",
    );
  });

  test("step limit is detected in a failed execution", () => {
    expect(turnReason({ type: "failed", data: { error: { message: "Exceeded max steps (12)" } } })).toBe(
      "⚠️ лимит шагов",
    );
    expect(isStepLimitReason("step limit reached")).toBe(true);
    expect(isStepLimitReason("permission denied")).toBe(false);
  });

  test("failed execution uses a short reason", () => {
    expect(turnReason({ type: "failed", data: { error: { message: "model exploded\nsecond line" } } })).toBe(
      "⚠️ ошибка: model exploded second line",
    );
    expect(shortReason("x".repeat(200)).length).toBeLessThanOrEqual(120);
  });

  test("interrupt without a marker still looks abnormal", () => {
    expect(turnReason({ type: "interrupted" })).toBe("⚠️ остановлено");
  });
});

describe("footer", () => {
  test("reason precedes stats and the stats line stays last", () => {
    const footer = composeTurnFooter({
      reason: "⚠️ остановлено: /stop",
      model: "DeepSeek V4.1 Flash",
      durationMs: 83_000,
      tps: 42,
      contextTokens: 531_000,
      blockedTools: 2,
    });
    const [reason, stats] = footer.split("\n");
    expect(reason).toBe("⚠️ остановлено: /stop · 2 инструмента заблокировано");
    expect(stats).toContain("DeepSeek V4.1 Flash");
    expect(stats).toContain("⏱ 1m 23s");
    expect(stats).toContain("⚡ 42.0 tok/s");
    expect(stats).toContain("🧠 531k");
  });

  test("blocked tools are pluralized in Russian", () => {
    expect(toolsWord(1)).toBe("инструмент");
    expect(toolsWord(2)).toBe("инструмента");
    expect(toolsWord(5)).toBe("инструментов");
    expect(blockedToolsText(1)).toBe("1 инструмент заблокирован");
    expect(blockedToolsText(2)).toBe("2 инструмента заблокировано");
    expect(blockedToolsText(5)).toBe("5 инструментов заблокировано");
  });

  test("permission denials count as blocked, other failures do not", () => {
    expect(isBlockedToolFailure({ message: "Permission declined: bash" })).toBe(true);
    expect(isBlockedToolFailure({ message: "ECONNREFUSED" })).toBe(false);
  });

  test("diagnostics tag is appended only when enabled", () => {
    const base = { model: "DeepSeek V4.1 Flash", durationMs: 42_000, turnId: "msg_abcdef123" };
    const off = composeTurnFooter({ ...base, diagnostics: false });
    expect(off.endsWith("#tmsgabc")).toBe(false);
    const on = composeTurnFooter({ ...base, diagnostics: true });
    expect(on.endsWith("#tmsgabc")).toBe(true);
    expect(on.split("\n")).toHaveLength(1);
    const withReason = composeTurnFooter({ ...base, diagnostics: true, reason: "⚠️ остановлено" });
    const [reason, stats] = withReason.split("\n");
    expect(reason).toBe("⚠️ остановлено");
    expect(stats?.endsWith("#tmsgabc")).toBe(true);
    // No turn id (e.g. an event without payload) still yields a stable tag.
    expect(composeTurnFooter({ diagnostics: true }).endsWith("#tnone")).toBe(true);
  });
});

describe("StopRegistry", () => {
  test("shares the reason between transports and is cleared on a new turn", () => {
    const stops = new StopRegistry();
    stops.markBudget("ses_a", 0.5, 1);
    expect(stops.get("ses_a")?.kind).toBe("budget");
    expect(stops.get("ses_a")?.amountUsd).toBe(0.5);
    expect(stops.get("ses_a")?.kind).toBe("budget");
    stops.clear("ses_a");
    expect(stops.get("ses_a")).toBeUndefined();
  });
});
