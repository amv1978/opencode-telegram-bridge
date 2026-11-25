/**
 * Small, pure ordering helpers shared by both transports.
 *
 * The bridge has two ordering hazards:
 *  - a mirrored Desktop/TUI prompt must reach the chat before the answer and
 *    must never be posted twice (SSE reconnects replay events);
 *  - a long answer is split into chunks: existing chunks are edited, new ones
 *    are sent strictly left to right, and a retried chunk must never be
 *    appended twice.
 */

export interface ChunkStep {
  index: number;
  action: "send" | "edit";
}

/**
 * Decides what to do with every chunk of the current flush: reuse the recorded
 * message id (`edit`) or send a new message (`send`). Order is always ascending,
 * so chunk 2 can never overtake chunk 1.
 */
export function planChunks<T>(ids: ReadonlyArray<T | undefined>, count: number): ChunkStep[] {
  const steps: ChunkStep[] = [];
  for (let index = 0; index < Math.max(0, count); index += 1) {
    steps.push({ index, action: ids[index] === undefined ? "send" : "edit" });
  }
  return steps;
}

/**
 * Records a delivered chunk at its position. Never pushes, so a retried send
 * cannot add the same chunk twice (holes are filled in place).
 */
export function assignChunk<T>(ids: Array<T | undefined>, index: number, id: T): void {
  while (ids.length < index) ids.push(undefined);
  ids[index] = id;
}

/**
 * Stable id of a mirrored inbox item. OpenCode puts the originating message id
 * in different places depending on the prompt source; all of them are accepted.
 * No id means "cannot deduplicate" and the caller keeps the message.
 */
export function mirrorKey(item: unknown): string | undefined {
  const envelope = item as
    | {
        id?: unknown;
        messageID?: unknown;
        messageId?: unknown;
        payload?: {
          id?: unknown;
          messageID?: unknown;
          messageId?: unknown;
          metadata?: Record<string, unknown>;
        };
      }
    | undefined;
  const metadata = envelope?.payload?.metadata;
  const candidates = [
    metadata?.messageID,
    metadata?.messageId,
    metadata?.message_id,
    envelope?.payload?.messageID,
    envelope?.payload?.messageId,
    envelope?.payload?.id,
    envelope?.messageID,
    envelope?.messageId,
    envelope?.id,
  ];
  for (const value of candidates) {
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return undefined;
}

/** Remembers which mirrored items were already delivered per session. */
export class MirrorLedger {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly maxEntries = 500,
  ) {}

  /** `true` = first delivery, `false` = replay and must be skipped. */
  claim(sessionID: string, item: unknown, now = Date.now()): boolean {
    const id = mirrorKey(item);
    if (!id) return true;
    const key = `${sessionID}:${id}`;
    const at = this.seen.get(key);
    if (at !== undefined && now - at <= this.ttlMs) return false;
    this.seen.set(key, now);
    if (this.seen.size > this.maxEntries) {
      const cutoff = now - this.ttlMs;
      for (const [entry, stamp] of this.seen) if (stamp < cutoff) this.seen.delete(entry);
    }
    return true;
  }
}

/**
 * Suppresses a second placeholder for a turn that already ended: late SSE
 * events (`text.delta`, a duplicate `execution.started`) arrive after
 * `execution.*` and used to spawn an orphan "thinking…" message.
 */
export class TurnGate {
  private readonly closedAt = new Map<string, number>();

  constructor(private readonly ttlMs = 15_000) {}

  close(sessionID: string, now = Date.now()): void {
    this.closedAt.set(sessionID, now);
  }

  /** A new turn (`execution.started`) reopens the gate immediately. */
  open(sessionID: string): void {
    this.closedAt.delete(sessionID);
  }

  allowsBegin(sessionID: string, now = Date.now()): boolean {
    const at = this.closedAt.get(sessionID);
    if (at === undefined) return true;
    if (now - at > this.ttlMs) {
      this.closedAt.delete(sessionID);
      return true;
    }
    return false;
  }
}
