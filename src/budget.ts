import type { BudgetConfig } from "./config.ts";

/**
 * Cost caps. OpenCode reports a cumulative `session.cost`; the tracker keeps a
 * baseline per turn and sums positive deltas into the current UTC day. With
 * `action: "stop"` a turn is interrupted once a cap is reached, otherwise the
 * chat only gets a warning.
 */

export interface BudgetSnapshot {
  perTurnUsd?: number;
  dailyUsd?: number;
  action: "warn" | "stop";
  day: string;
  spentUsd: number;
  active: Array<{ sessionID: string; spentUsd: number }>;
}

export type BudgetLevel = "ok" | "warn" | "over";

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** 80% of a cap is a warning, 100% is "over". No cap means always ok. */
export function budgetLevel(spentUsd: number, limitUsd?: number): BudgetLevel {
  if (!limitUsd || limitUsd <= 0) return "ok";
  const ratio = spentUsd / limitUsd;
  if (ratio >= 1) return "over";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

export function formatUsd(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `$${safe < 1 ? safe.toFixed(4) : safe.toFixed(2)}`;
}

/** Human chat report shared by `/budget` in Telegram and Discord. */
export function budgetReport(snapshot: BudgetSnapshot | undefined): string[] {
  if (!snapshot) return ["💰 Бюджет: демон не запущен."];
  const limits: string[] = [];
  if (snapshot.perTurnUsd) limits.push(`ход ${formatUsd(snapshot.perTurnUsd)}`);
  if (snapshot.dailyUsd) limits.push(`день ${formatUsd(snapshot.dailyUsd)}`);
  const lines = ["💰 **Бюджет**"];
  lines.push(limits.length ? `Лимиты: ${limits.join(" · ")}` : "Лимиты не заданы.");
  lines.push(
    snapshot.dailyUsd
      ? `Сегодня (UTC): ${formatUsd(snapshot.spentUsd)} из ${formatUsd(snapshot.dailyUsd)}`
      : `Сегодня (UTC): ${formatUsd(snapshot.spentUsd)}`,
  );
  lines.push(`Действие: ${snapshot.action === "stop" ? "остановить ход" : "предупредить"}`);
  if (snapshot.active.length) {
    lines.push(`Активные ходы: ${snapshot.active.length}`);
    for (const turn of snapshot.active.slice(0, 5)) {
      lines.push(`· ${turn.sessionID.slice(0, 16)}… ${formatUsd(turn.spentUsd)}`);
    }
  }
  if (!limits.length) lines.push("Настройка: `ocbridge-cli budget set per-turn=1 daily=5`.");
  return lines;
}

export interface BudgetTrackerOptions {
  config: () => BudgetConfig | undefined;
  /** Cumulative session cost in USD. */
  costOf: (sessionID: string) => Promise<number | undefined>;
  interrupt: (sessionID: string) => Promise<void>;
  /** Budget stopped a turn: the footer says `⛔ бюджет: $X из $Y`. */
  onStop?: (sessionID: string, detail: { spentUsd: number; limitUsd: number }) => void;
  /** Sends a budget notice to the chat bound to the session. */
  notify: (sessionID: string, text: string) => Promise<void>;
  load?: () => { day?: string; spentUsd?: number } | undefined;
  save?: (state: { day: string; spentUsd: number }) => void;
  now?: () => number;
}

interface ActiveTurn {
  baseUsd: number;
  lastUsd: number;
  warned: boolean;
  stopped: boolean;
}

export class BudgetTracker {
  private day: string;
  private spentUsd = 0;
  private dailyWarned = false;
  private readonly turns = new Map<string, ActiveTurn>();

  constructor(private readonly options: BudgetTrackerOptions) {
    this.day = utcDay(this.now());
    const saved = options.load?.();
    if (saved && saved.day === this.day && Number.isFinite(saved.spentUsd)) {
      this.spentUsd = Math.max(0, Number(saved.spentUsd) || 0);
    }
  }

  /** Remembers the cost baseline at `session.execution.started`. */
  async startTurn(sessionID: string): Promise<void> {
    if (this.turns.has(sessionID)) return;
    const baseUsd = (await this.options.costOf(sessionID)) ?? 0;
    this.turns.set(sessionID, { baseUsd, lastUsd: baseUsd, warned: false, stopped: false });
  }

  /**
   * Live check while a turn runs: warnings, and `interrupt` when a cap is
   * reached and `action = "stop"`.
   */
  async tick(): Promise<void> {
    this.rollDay();
    for (const [sessionID, turn] of [...this.turns]) {
      const total = await this.options.costOf(sessionID);
      if (total === undefined) continue;
      turn.lastUsd = Math.max(turn.lastUsd, total);
      await this.check(sessionID, turn, false);
    }
  }

  /** Final delta: adds the turn to today's spend and applies the last check. */
  async finishTurn(sessionID: string): Promise<void> {
    const turn = this.turns.get(sessionID);
    if (!turn) return;
    this.turns.delete(sessionID);
    this.rollDay();
    const total = (await this.options.costOf(sessionID)) ?? turn.lastUsd;
    const delta = Math.max(0, total - turn.baseUsd);
    if (delta > 0) {
      this.spentUsd += delta;
      this.options.save?.({ day: this.day, spentUsd: this.spentUsd });
    }
    await this.check(sessionID, { ...turn, lastUsd: total }, true);
  }

  snapshot(): BudgetSnapshot {
    this.rollDay();
    const cfg = this.options.config() ?? {};
    return {
      perTurnUsd: cfg.perTurnUsd,
      dailyUsd: cfg.dailyUsd,
      action: cfg.action === "stop" ? "stop" : "warn",
      day: this.day,
      spentUsd: this.spentUsd,
      active: [...this.turns].map(([sessionID, turn]) => ({
        sessionID,
        spentUsd: Math.max(0, turn.lastUsd - turn.baseUsd),
      })),
    };
  }

  private async check(sessionID: string, turn: ActiveTurn, final: boolean): Promise<void> {
    const cfg = this.options.config() ?? {};
    const action = cfg.action === "stop" ? "stop" : "warn";
    const spent = Math.max(0, turn.lastUsd - turn.baseUsd);
    const notices: string[] = [];
    let stop = false;
    let stopSpent = 0;
    let stopLimit = 0;

    const turnLevel = budgetLevel(spent, cfg.perTurnUsd);
    if (turnLevel !== "ok" && (final || !turn.stopped)) {
      if (turnLevel === "warn" && !turn.warned) {
        turn.warned = true;
        notices.push(
          `⚠️ Бюджет хода: ${formatUsd(spent)} из ${formatUsd(cfg.perTurnUsd ?? 0)} (80%).`,
        );
      }
      if (turnLevel === "over") {
        if (action === "stop") {
          stop = true;
          stopSpent = spent;
          stopLimit = cfg.perTurnUsd ?? 0;
          turn.stopped = true;
          notices.push(`⛔️ Бюджет хода превышен: ${formatUsd(spent)} из ${formatUsd(cfg.perTurnUsd ?? 0)}. Ход остановлен.`);
        } else if (!turn.stopped) {
          turn.stopped = true;
          notices.push(`⛔️ Бюджет хода превышен: ${formatUsd(spent)} из ${formatUsd(cfg.perTurnUsd ?? 0)}.`);
        }
      }
    }

    const dayLevel = budgetLevel(this.spentUsd + (final ? 0 : spent), cfg.dailyUsd);
    if (dayLevel === "warn" && !this.dailyWarned) {
      this.dailyWarned = true;
      notices.push(`⚠️ Дневной бюджет: ${formatUsd(this.spentUsd + (final ? 0 : spent))} из ${formatUsd(cfg.dailyUsd ?? 0)} (80%).`);
    }
    if (dayLevel === "over") {
      if (action === "stop") {
        stop = true;
        if (!stopLimit) {
          stopSpent = this.spentUsd;
          stopLimit = cfg.dailyUsd ?? 0;
        }
        notices.push(`⛔️ Дневной бюджет исчерпан: ${formatUsd(this.spentUsd)} из ${formatUsd(cfg.dailyUsd ?? 0)}. Ход остановлен.`);
      } else if (!this.dailyWarned) {
        this.dailyWarned = true;
        notices.push(`⛔️ Дневной бюджет исчерпан: ${formatUsd(this.spentUsd)} из ${formatUsd(cfg.dailyUsd ?? 0)}.`);
      }
    }

    for (const text of new Set(notices)) {
      await this.options.notify(sessionID, text).catch(() => undefined);
    }
    if (stop) {
      this.options.onStop?.(sessionID, { spentUsd: stopSpent, limitUsd: stopLimit });
      await this.options.interrupt(sessionID).catch(() => undefined);
    }
  }

  private rollDay(): void {
    const day = utcDay(this.now());
    if (day === this.day) return;
    this.day = day;
    this.spentUsd = 0;
    this.dailyWarned = false;
    this.options.save?.({ day, spentUsd: 0 });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
