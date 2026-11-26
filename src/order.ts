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

/** A mirror destination: a transport, a chat and an optional thread. */
export interface MirrorTarget {
  kind: string;
  chatId: string | number;
  threadId?: string | number;
}

/** Stable target key: `tg:-100123:0`, `dc:456:0`. */
export function mirrorTargetKey(target: MirrorTarget): string {
  return `${target.kind}:${target.chatId}:${target.threadId ?? 0}`;
}

/** Drops duplicate targets while keeping the first occurrence. */
export function uniqueMirrorTargets(targets: Iterable<MirrorTarget>): MirrorTarget[] {
  const seen = new Set<string>();
  const result: MirrorTarget[] = [];
  for (const target of targets) {
    const key = mirrorTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}

/** Whitespace-insensitive text, so replayed events with reformatting match. */
export function normalizeMirrorText(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** FNV-1a over UTF-16 code units: short, stable, dependency-free. */
export function mirrorHash(text: string): string {
  let hash = 0x811c9dc5;
  const value = normalizeMirrorText(text);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** How long a mirrored prompt is remembered per target. */
export const MIRROR_TTL_MS = 10 * 60 * 1000;

/**
 * Remembers delivered mirror prompts per `(session, normalized text, target)`.
 *
 * The old ledger keyed on an item id, but the SSE event carries the inbox id
 * while the history fallback carries the message id — the same prompt looked
 * new and was posted twice. Text is the stable identity; the id is only a
 * fallback for prompts without text.
 */
export class MirrorLedger {
  private readonly seen = new Map<string, number>();
  private suppressed = 0;

  constructor(
    private readonly ttlMs = MIRROR_TTL_MS,
    private readonly maxEntries = 1000,
  ) {}

  /**
   * `true` = first delivery to this target, `false` = replay and must be
   * skipped. A prompt may still be claimed once per target.
   */
  claim(sessionID: string, text: string, target: string, now = Date.now(), fallbackId?: string): boolean {
    const key = this.keyOf(sessionID, text, target, fallbackId);
    if (!key) return true;
    const at = this.seen.get(key);
    if (at !== undefined && now - at <= this.ttlMs) {
      this.suppressed += 1;
      return false;
    }
    this.seen.set(key, now);
    if (this.seen.size > this.maxEntries) {
      const cutoff = now - this.ttlMs;
      for (const [entry, stamp] of this.seen) if (stamp < cutoff) this.seen.delete(entry);
    }
    return true;
  }

  /** Frees a claim when every send attempt failed: the next event may retry. */
  release(sessionID: string, text: string, target: string, fallbackId?: string): void {
    const key = this.keyOf(sessionID, text, target, fallbackId);
    if (key) this.seen.delete(key);
  }

  /** How many replays were suppressed (visible in stats/tests). */
  get suppressedCount(): number {
    return this.suppressed;
  }

  private keyOf(sessionID: string, text: string, target: string, fallbackId?: string): string | undefined {
    const normalized = normalizeMirrorText(text);
    if (normalized) return `${sessionID}:${mirrorHash(normalized)}:${target}`;
    if (fallbackId) return `${sessionID}:id:${fallbackId}:${target}`;
    return undefined;
  }
}

/** One ledger for Telegram and Discord: a replay cannot post in either. */
export const sharedMirrorLedger = new MirrorLedger();

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
