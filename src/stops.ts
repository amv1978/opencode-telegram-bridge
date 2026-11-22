import type { StopDetail } from "./turn.ts";

interface Entry extends StopDetail {
  at: number;
}

/** A marker must not leak into the next turn of the same session. */
const TTL_MS = 10 * 60 * 1000;

/**
 * Why the current turn was stopped. `/stop` and the budget tracker are
 * transport-independent: both Telegram and Discord read the same marker, so
 * the footer is identical in every bound chat.
 */
export class StopRegistry {
  private readonly entries = new Map<string, Entry>();

  markUser(sessionID: string): void {
    this.set(sessionID, { kind: "user" });
  }

  markBudget(sessionID: string, amountUsd: number, limitUsd: number): void {
    this.set(sessionID, { kind: "budget", amountUsd, limitUsd });
  }

  markSteps(sessionID: string): void {
    this.set(sessionID, { kind: "steps" });
  }

  /** Consumed by the footer; stays until the next turn starts. */
  get(sessionID: string): StopDetail | undefined {
    this.prune();
    const entry = this.entries.get(sessionID);
    return entry ? { kind: entry.kind, amountUsd: entry.amountUsd, limitUsd: entry.limitUsd } : undefined;
  }

  /** `session.execution.started`: a new turn must not inherit an old reason. */
  clear(sessionID: string): void {
    this.entries.delete(sessionID);
  }

  private set(sessionID: string, detail: StopDetail): void {
    this.entries.set(sessionID, { ...detail, at: Date.now() });
  }

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [sessionID, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(sessionID);
    }
  }
}
