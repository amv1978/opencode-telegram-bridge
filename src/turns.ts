/**
 * Turn identity for streamed answers.
 *
 * A chat message belongs to exactly one turn, so streamer state is keyed by
 * `(sessionID, turnId)` where `turnId` is the assistant message id carried by
 * the event. One assistant message id = one answer: `bind()` starts a new turn
 * as soon as an id it has not seen appears. Ended ids are remembered for the
 * TTL, so a late `text.delta`/`text.ended` for an older message is reported as
 * `stale` and never reopens or edits that message.
 *
 * `execution.started` may arrive without an id; that turn is `provisional` and
 * gets a local `pN` id. The first real assistant id adopts it (`adoptedFrom`),
 * so both spellings address one stream. An end event is routed by the id it
 * carries; the registry never relies on a single per-session pointer for that.
 */

/** Leaked streams (no turn end at all) are cleaned up after this long. */
export const TURN_TTL_MS = 60 * 60 * 1000;
/** How long an ended assistant id is remembered and rejected when it returns. */
export const ENDED_TTL_MS = TURN_TTL_MS;

export interface TurnRef {
  turnId: string;
  /** This call opened a new turn (a new assistant message = a new answer). */
  fresh: boolean;
  /** No assistant message id yet, only the local `pN` placeholder. */
  provisional: boolean;
  /** The provisional id that was just replaced by `turnId` (rekey the state). */
  adoptedFrom?: string;
  /** The id belongs to a turn that already ended: ignore the event. */
  stale?: boolean;
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

/**
 * Per-session turn bookkeeping shared by Telegram and Discord.
 *
 * Every live turn is kept (not just the newest): an end event names its own
 * assistant id and must find *that* turn, while a late delta for an older turn
 * must not move the pointer. The newest turn is `current()`.
 */
export class TurnRegistry {
  /** sessionID → turn id → turn. */
  private readonly turns = new Map<string, Map<string, Turn>>();
  /** sessionID → the newest turn id. */
  private readonly currentIds = new Map<string, string>();
  /** sessionID → ended turn id → timestamp (late events are rejected). */
  private readonly endedIds = new Map<string, Map<string, number>>();
  private seq = 0;

  constructor(private readonly ttlMs: number = TURN_TTL_MS) {}

  /** The newest turn of the session, without creating one. */
  current(sessionID: string, now = Date.now()): TurnRef | undefined {
    this.prune(sessionID, now);
    const map = this.turns.get(sessionID);
    const id = this.currentIds.get(sessionID);
    const turn = map && id ? map.get(id) : undefined;
    if (!turn) {
      this.currentIds.delete(sessionID);
      return undefined;
    }
    return { turnId: turn.id, fresh: false, provisional: turn.provisional };
  }

  /** `session.execution.started`: the turn boundary. */
  started(sessionID: string, hint?: string, now = Date.now()): TurnRef {
    this.prune(sessionID, now);
    const map = this.ensure(sessionID);
    if (hint) {
      const existing = map.get(hint);
      if (existing) {
        existing.at = now;
        this.currentIds.set(sessionID, hint);
        return { turnId: hint, fresh: false, provisional: existing.provisional };
      }
      if (this.wasEnded(sessionID, hint, now)) {
        return { turnId: hint, fresh: false, provisional: false, stale: true };
      }
    }
    const id = hint || `p${++this.seq}`;
    return this.create(sessionID, id, !hint, now);
  }

  /**
   * Any event with an assistant message id:
   * - known live id → reuse that turn (late events of an older turn are allowed,
   *   but do not become the newest);
   * - ended id → `stale`, the caller ignores the event;
   * - provisional current turn → adopt the first real id;
   * - otherwise a new assistant id → a **new** turn.
   */
  bind(sessionID: string, hint?: string, now = Date.now()): TurnRef {
    this.prune(sessionID, now);
    const map = this.ensure(sessionID);
    if (!hint) {
      const current = this.currentTurn(sessionID);
      if (current) {
        current.at = now;
        return { turnId: current.id, fresh: false, provisional: current.provisional };
      }
      return this.create(sessionID, `p${++this.seq}`, true, now);
    }
    const existing = map.get(hint);
    if (existing) {
      existing.at = now;
      return { turnId: existing.id, fresh: false, provisional: existing.provisional };
    }
    if (this.wasEnded(sessionID, hint, now)) {
      return { turnId: hint, fresh: false, provisional: false, stale: true };
    }
    const current = this.currentTurn(sessionID);
    if (current?.provisional) {
      const adoptedFrom = current.id;
      map.delete(adoptedFrom);
      current.id = hint;
      current.provisional = false;
      current.at = now;
      map.set(hint, current);
      this.currentIds.set(sessionID, hint);
      return { turnId: hint, fresh: false, provisional: false, adoptedFrom };
    }
    // A new assistant message id is a new answer, even if the previous stream
    // never reported its end (that was the 18-starts-vs-7-ends RCA).
    return this.create(sessionID, hint, false, now);
  }

  /** Turn ended: forget that exact turn and reject its id for the TTL. */
  end(sessionID: string, turnId?: string, now = Date.now()): void {
    const map = this.turns.get(sessionID);
    if (!map) return;
    const id = turnId ?? this.currentIds.get(sessionID);
    if (!id) return;
    const turn = map.get(id);
    if (!turn) return;
    map.delete(id);
    this.markEnded(sessionID, id, now);
    if (this.currentIds.get(sessionID) === id) {
      this.currentIds.delete(sessionID);
      let newest: Turn | undefined;
      for (const entry of map.values()) {
        if (!newest || entry.at >= newest.at) newest = entry;
      }
      if (newest) this.currentIds.set(sessionID, newest.id);
    }
    if (!map.size) this.turns.delete(sessionID);
  }

  /** Drops abandoned turns (a session that never reported an end). */
  pruneAll(now = Date.now()): number {
    let removed = 0;
    for (const sessionID of [...this.turns.keys()]) {
      removed += this.prune(sessionID, now) ? 1 : 0;
      if (!this.turns.get(sessionID)?.size) this.turns.delete(sessionID);
    }
    for (const [sessionID, ended] of [...this.endedIds]) {
      for (const [id, at] of [...ended]) {
        if (now - at > ENDED_TTL_MS) ended.delete(id);
      }
      if (!ended.size) this.endedIds.delete(sessionID);
    }
    return removed;
  }

  /** `true` when this assistant id belonged to an already finished turn. */
  hasEnded(sessionID: string, turnId: string, now = Date.now()): boolean {
    return this.wasEnded(sessionID, turnId, now);
  }

  private create(sessionID: string, id: string, provisional: boolean, now: number): TurnRef {
    const map = this.ensure(sessionID);
    map.set(id, { id, provisional, at: now });
    this.currentIds.set(sessionID, id);
    return { turnId: id, fresh: true, provisional };
  }

  private ensure(sessionID: string): Map<string, Turn> {
    let map = this.turns.get(sessionID);
    if (!map) {
      map = new Map();
      this.turns.set(sessionID, map);
    }
    return map;
  }

  private currentTurn(sessionID: string): Turn | undefined {
    const id = this.currentIds.get(sessionID);
    return id ? this.turns.get(sessionID)?.get(id) : undefined;
  }

  private markEnded(sessionID: string, id: string, now: number): void {
    let ended = this.endedIds.get(sessionID);
    if (!ended) {
      ended = new Map();
      this.endedIds.set(sessionID, ended);
    }
    ended.set(id, now);
  }

  private wasEnded(sessionID: string, id: string, now: number): boolean {
    const ended = this.endedIds.get(sessionID);
    const at = ended?.get(id);
    if (at === undefined) return false;
    if (now - at > ENDED_TTL_MS) {
      ended!.delete(id);
      return false;
    }
    return true;
  }

  /** Removes expired live turns; returns `true` when something was dropped. */
  private prune(sessionID: string, now: number): boolean {
    const map = this.turns.get(sessionID);
    if (!map) return false;
    let removed = false;
    for (const [id, turn] of [...map]) {
      if (now - turn.at <= this.ttlMs) continue;
      map.delete(id);
      this.markEnded(sessionID, id, now);
      removed = true;
    }
    if (removed) {
      const current = this.currentIds.get(sessionID);
      if (!current || !map.get(current)) {
        this.currentIds.delete(sessionID);
        let newest: Turn | undefined;
        for (const entry of map.values()) {
          if (!newest || entry.at >= newest.at) newest = entry;
        }
        if (newest) this.currentIds.set(sessionID, newest.id);
      }
      if (!map.size) this.turns.delete(sessionID);
    }
    return removed;
  }
}
