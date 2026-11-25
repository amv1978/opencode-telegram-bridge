import { describe, expect, test } from "bun:test";
import { budgetLevel, BudgetTracker, budgetReport, formatUsd, utcDay } from "../src/budget.ts";
import type { BudgetConfig } from "../src/config.ts";

describe("budget helpers", () => {
  test("levels: 80% warning, 100% over, no cap is ok", () => {
    expect(budgetLevel(0.79, 1)).toBe("ok");
    expect(budgetLevel(0.8, 1)).toBe("warn");
    expect(budgetLevel(1, 1)).toBe("over");
    expect(budgetLevel(5, undefined)).toBe("ok");
    expect(budgetLevel(5, 0)).toBe("ok");
  });

  test("utcDay and formatUsd", () => {
    expect(utcDay(Date.UTC(2026, 10, 22, 23, 59))).toBe("2026-11-22");
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(2.5)).toBe("$2.50");
    expect(formatUsd(-1)).toBe("$0.0000");
  });

  test("report shows limits and spend", () => {
    const lines = budgetReport({
      perTurnUsd: 2,
      dailyUsd: 10,
      action: "stop",
      day: "2026-11-22",
      spentUsd: 4.2,
      active: [{ sessionID: "ses_a", spentUsd: 0.3 }],
    });
    expect(lines.join("\n")).toContain("ход $2.00");
    expect(lines.join("\n")).toContain("$4.20 из $10.00");
    expect(lines.join("\n")).toContain("остановить ход");
    expect(budgetReport(undefined)[0]).toContain("не запущен");
  });
});

describe("BudgetTracker", () => {
  function tracker(options: {
    cfg: BudgetConfig;
    cost: () => number;
    interrupt?: () => void;
    notify?: (text: string) => void;
    now?: () => number;
    saved?: { day: string; spentUsd: number };
  }) {
    const notices: string[] = [];
    let interrupted = 0;
    return {
      notices,
      get interrupted() {
        return interrupted;
      },
      tracker: new BudgetTracker({
        config: () => options.cfg,
        costOf: async () => options.cost(),
        interrupt: async () => {
          interrupted += 1;
          options.interrupt?.();
        },
        notify: async (_sessionID, text) => {
          notices.push(text);
          options.notify?.(text);
        },
        load: () => options.saved,
        save: () => undefined,
        now: options.now,
      }),
    };
  }

  test("warns at 80% and stops the turn at 100% with action=stop", async () => {
    let cost = 0;
    const { tracker: budget, notices } = tracker({ cfg: { perTurnUsd: 1, action: "stop" }, cost: () => cost });
    await budget.startTurn("ses_a");
    cost = 0.8;
    await budget.tick();
    expect(notices.some((text) => text.includes("80%"))).toBe(true);
    cost = 1.05;
    await budget.tick();
    expect(notices.some((text) => text.includes("превышен"))).toBe(true);
    expect((budget as unknown as { turns: Map<string, { stopped: boolean }> }).turns.get("ses_a")?.stopped).toBe(true);
  });

  test("daily total accumulates on finish and resets on a new UTC day", async () => {
    let cost = 0;
    let now = Date.UTC(2026, 10, 22, 12);
    const { tracker: budget } = tracker({ cfg: { dailyUsd: 2 }, cost: () => cost, now: () => now });
    await budget.startTurn("s1");
    cost = 0.5;
    await budget.finishTurn("s1");
    expect(budget.snapshot().spentUsd).toBeCloseTo(0.5, 6);

    now = Date.UTC(2026, 10, 23, 1);
    expect(budget.snapshot().spentUsd).toBe(0);
  });

  test("restores today's spend from state.json", () => {
    const day = utcDay();
    const { tracker: budget } = tracker({ cfg: {}, cost: () => 0, saved: { day, spentUsd: 3.25 } });
    expect(budget.snapshot().spentUsd).toBe(3.25);
  });

  test("warnings and interrupts fire once per turn, not every tick", async () => {
    let cost = 0;
    const started = tracker({
      cfg: { perTurnUsd: 1, action: "stop" },
      cost: () => cost,
    });
    await started.tracker.startTurn("ses_a");
    cost = 0.85;
    await started.tracker.tick();
    await started.tracker.tick();
    await started.tracker.tick();
    expect(started.notices.filter((text) => text.includes("80%")).length).toBe(1);
    cost = 1.2;
    await started.tracker.tick();
    await started.tracker.tick();
    await started.tracker.finishTurn("ses_a");
    expect(started.notices.filter((text) => text.includes("превышен")).length).toBe(1);
    expect(started.interrupted).toBe(1);
  });
});
