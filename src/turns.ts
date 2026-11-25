/**
 * Turn identity for streamed answers.
 *
 * A chat message belongs to exactly one turn, so streamer state is keyed by
 * `(sessionID, turnId)` instead of `sessionID` alone. Before this a turn that
 * ended with active subagents kept its block alive; the next prompt started
 * while that block was still in the map, `begin()` early-returned, and the new
 * text was appended to the *previous* answer (reordering + overwriting).
 *
 * `turnId` is the assistant message id of the turn's events
 * (`session.text.started/delta`, `session.execution.started`). Until the first
 * event that carries it the turn is `provisional` and gets a local `pN` id;
 * the first real assistant message id is adopted, so both spellings address
 * one stream.
 */

/** Leaked streams (no turn end at all) are cleaned up after this long. */
export const TURN_TTL_MS = 60 * 60 * 1000;

export interface TurnRef {
  turnId: string;
  /** No turn existed for this session: a stream may be opened. */
  fresh: boolean;
  /** No assistant message id yet, only the local `pN` placeholder. */
  provisional: boolean;
  /** The provisional id that was just replaced by `turnId` (rekey the state). */
  adoptedFrom?: string;
}

interface Turn {
  id: string;
  provisional: boolean;
  at: number;
}

/** Assistant message id carried by a turn event, when the payload has one. */
export function assistantMessageIDOf(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  const direct = [data.assistantMessageID, data.assistantMessageId, data.assistant_message_id, data.messageID, data.messageId];
  for (const value of direct) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // Some builds wrap the turn in `item` / `message`.
  for (const nested of [data.item, data.message]) {
    if (!nested || typeof nested !== "object") continue;
    const found = assistantMessageIDOf(nested as Record<string, unknown>);
    if (found) return found;
  }
  return undefined;
}

/** `#tabc123` — diagnostics suffix of the stats line (first 6 chars). */
export function turnTag(turnId: string | undefined): string {
  const clean = String(turnId ?? "").replace(/[^0-9a-z]/gi, "");
  return `#t${clean.slice(0, 6) || "none"}`;
}

/** Map key of one turn's stream: `sessionID#turnId`. */
export function turnKey(sessionID: string, turnId: string): string {
  return `${sessionID}#${turnId}`;
}

/** Per-session turn bookkeeping shared by Telegram and Discord. */
export class TurnRegistry {
  private readonly turns = new Map<string, Turn>();
  private seq = 0;

  constructor(private readonly ttlMs: number = TURN_TTL_MS) {}

  /** The turn that new events belong to, without creating one. */
  current(sessionID: string, now = Date.now()): TurnRef | undefined {
    const turn = this.prune(sessionID, now);
    if (!turn) return undefined;
    return { turnId: turn.id, fresh: false, provisional: turn.provisional };
  }

  /** `session.execution.started`: the turn boundary. */
  started(sessionID: string, hint?: string, now = Date.now()): TurnRef {
    const turn = this.prune(sessionID, now);
    // A replay that names the same assistant message is the same turn.
    if (turn && hint && turn.id === hint) {
      turn.at = now;
      return { turnId: turn.id, fresh: false, provisional: turn.provisional };
    }
    const id = hint || `p${++this.seq}`;
    this.turns.set(sessionID, { id, provisional: !hint, at: now });
    return { turnId: id, fresh: true, provisional: !hint };
  }

  /**
   * Any event with an assistant message id: adopt a provisional turn, open a
   * turn if none exists, otherwise keep the current one (later steps of the
   * same turn carry a new assistant message id but are still one answer).
   */
  bind(sessionID: string, hint?: string, now = Date.now()): TurnRef {
    const turn = this.prune(sessionID, now);
    if (!turn) {
      const id = hint || `p${++this.seq}`;
      this.turns.set(sessionID, { id, provisional: !hint, at: now });
      return { turnId: id, fresh: true, provisional: !hint };
    }
    turn.at = now;
    if (!hint || turn.id === hint) {
      return { turnId: turn.id, fresh: false, provisional: turn.provisional };
    }
    if (turn.provisional) {
      const adoptedFrom = turn.id;
      turn.id = hint;
      turn.provisional = false;
      return { turnId: hint, fresh: false, provisional: false, adoptedFrom };
    }
    return { turnId: turn.id, fresh: false, provisional: false };
  }

  /** Turn ended: the next event starts a new one. */
  end(sessionID: string, turnId?: string): void {
    const turn = this.turns.get(sessionID);
    if (!turn) return;
    if (turnId && turn.id !== turnId) return;
    this.turns.delete(sessionID);
  }

  /** Drops abandoned turns (a session that never reported an end). */
  pruneAll(now = Date.now()): number {
    let removed = 0;
    for (const sessionID of [...this.turns.keys()]) {
      if (this.prune(sessionID, now)) continue;
      removed += 1;
    }
    return removed;
  }

  private prune(sessionID: string, now: number): Turn | undefined {
    const turn = this.turns.get(sessionID);
    if (!turn) return undefined;
    if (now - turn.at > this.ttlMs) {
      this.turns.delete(sessionID);
      return undefined;
    }
    return turn;
  }
}
