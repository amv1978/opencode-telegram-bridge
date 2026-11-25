import { log } from "./log.ts";

export type SubagentMode = "auto" | "inline" | "message" | "off";
export type SubagentPlacement = "inline" | "message" | "off";

/** Boolean is the legacy value: `true` = auto, `false` = off. */
export function normalizeSubagentMode(value: unknown): SubagentMode {
  if (value === false || value === "off") return "off";
  if (value === "inline" || value === "message" || value === "auto") return value;
  return "auto";
}

export function isSubagentMode(value: unknown): value is SubagentMode {
  return value === "auto" || value === "inline" || value === "message" || value === "off";
}

/**
 * `auto` uses the inline status line when the parent stream is alive and a
 * dedicated message otherwise; `inline`/`message` force one placement; `off`
 * hides subagents. Never both.
 */
export function subagentPlacement(mode: unknown, streamActive: boolean): SubagentPlacement {
  const normalized = normalizeSubagentMode(mode);
  if (normalized === "off") return "off";
  if (normalized === "inline") return streamActive ? "inline" : "off";
  if (normalized === "message") return "message";
  return streamActive ? "inline" : "message";
}

/** `0m 12s`, `1m 05s` — the shape used by background subagent cards. */
export function formatSubagentDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export interface BackgroundSubagentOptions<T> {
  tickMs: number;
  ttlMs?: number;
  maxIndividual?: number;
  send(target: T, text: string): Promise<string | undefined>;
  edit(target: T, messageId: string, text: string): Promise<void>;
  remove?(target: T, messageId: string): Promise<void>;
}

interface Card {
  sessionID: string;
  agent: string;
  title: string;
  startedAt: number;
  state: "running" | "ok" | "fail";
  grouped: boolean;
  messageId?: string;
  keep: boolean;
  deleteTimer?: ReturnType<typeof setTimeout>;
}

interface Bucket<T> {
  target: T;
  cards: Card[];
  groupId?: string;
  groupKeep: boolean;
  groupTimer?: ReturnType<typeof setTimeout>;
  ticker?: ReturnType<typeof setInterval>;
}

/**
 * Dedicated "background subagent" cards for turns whose parent stream is gone.
 * The first few children get one message each; the rest share one edited
 * message with up to three lines. Finished cards stay for 10 minutes unless the
 * user replied to them.
 */
export class BackgroundSubagents<T> {
  private readonly buckets = new Map<string, Bucket<T>>();
  private readonly ttlMs: number;
  private readonly maxIndividual: number;

  constructor(private readonly options: BackgroundSubagentOptions<T>) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.maxIndividual = Math.max(1, options.maxIndividual ?? 3);
  }

  has(sessionID: string): boolean {
    for (const bucket of this.buckets.values()) {
      if (bucket.cards.some((card) => card.sessionID === sessionID)) return true;
    }
    return false;
  }

  async start(parentID: string, target: T, sessionID: string, agent: string, title: string): Promise<void> {
    const bucket = this.bucket(parentID, target);
    if (bucket.cards.some((card) => card.sessionID === sessionID)) return;
    const card: Card = {
      sessionID,
      agent: agent || "subagent",
      title: title.trim() || agent || "subagent",
      startedAt: Date.now(),
      state: "running",
      grouped: bucket.cards.filter((entry) => entry.grouped).length > 0 || bucket.cards.length >= this.maxIndividual,
      keep: false,
    };
    bucket.cards.push(card);
    this.cancelGroupDelete(bucket);
    try {
      if (card.grouped) {
        await this.ensureGroup(bucket);
        await this.renderGroup(bucket);
      } else {
        card.messageId = await this.options.send(target, this.line(card));
      }
    } catch (error) {
      log.warn("subagent background card send failed:", (error as Error).message);
    }
    this.startTicker(parentID, bucket);
  }

  async finish(sessionID: string, ok: boolean): Promise<void> {
    for (const bucket of this.buckets.values()) {
      const card = bucket.cards.find((entry) => entry.sessionID === sessionID);
      if (!card) continue;
      card.state = ok ? "ok" : "fail";
      try {
        if (card.grouped) await this.renderGroup(bucket);
        else if (card.messageId) await this.options.edit(bucket.target, card.messageId, this.line(card));
      } catch (error) {
        log.warn("subagent background card edit failed:", (error as Error).message);
      }
      this.scheduleDelete(bucket, card);
      if (!bucket.cards.some((entry) => entry.state === "running")) this.stopTicker(bucket);
      return;
    }
  }

  /** A user replied to a card: keep it forever. Returns true when matched. */
  keep(messageId: string): boolean {
    let matched = false;
    for (const bucket of this.buckets.values()) {
      for (const card of bucket.cards) {
        if (card.messageId !== messageId) continue;
        card.keep = true;
        if (card.deleteTimer) clearTimeout(card.deleteTimer);
        card.deleteTimer = undefined;
        matched = true;
      }
      if (bucket.groupId === messageId) {
        bucket.groupKeep = true;
        this.cancelGroupDelete(bucket);
        matched = true;
      }
    }
    return matched;
  }

  stop(): void {
    for (const bucket of this.buckets.values()) {
      this.stopTicker(bucket);
      for (const card of bucket.cards) if (card.deleteTimer) clearTimeout(card.deleteTimer);
      this.cancelGroupDelete(bucket);
    }
    this.buckets.clear();
  }

  private bucket(parentID: string, target: T): Bucket<T> {
    let bucket = this.buckets.get(parentID);
    if (!bucket) {
      bucket = { target, cards: [], groupKeep: false };
      this.buckets.set(parentID, bucket);
    }
    return bucket;
  }

  private line(card: Card): string {
    const icon = card.state === "ok" ? "✅" : card.state === "fail" ? "✗" : "🧩";
    return `${icon} ${card.agent} · ${card.title} · ${formatSubagentDuration(Date.now() - card.startedAt)}`;
  }

  private groupText(bucket: Bucket<T>): string {
    return bucket.cards
      .filter((card) => card.grouped)
      .slice(0, 3)
      .map((card) => this.line(card))
      .join("\n");
  }

  private async ensureGroup(bucket: Bucket<T>): Promise<void> {
    if (bucket.groupId) return;
    // The caller has only the parent target stored in the bucket.
    const first = bucket.cards[0];
    if (!first) return;
    bucket.groupId = await this.options.send(bucket.target, this.groupText(bucket));
  }

  private async renderGroup(bucket: Bucket<T>): Promise<void> {
    if (!bucket.groupId) return;
    await this.options.edit(bucket.target, bucket.groupId, this.groupText(bucket));
  }

  private startTicker(parentID: string, bucket: Bucket<T>): void {
    if (bucket.ticker) return;
    bucket.ticker = setInterval(() => {
      void (async () => {
        for (const card of bucket.cards) {
          if (card.state !== "running" || card.grouped || !card.messageId) continue;
          await this.options.edit(bucket.target, card.messageId, this.line(card)).catch(() => undefined);
        }
        if (bucket.groupId && bucket.cards.some((card) => card.grouped && card.state === "running")) {
          await this.renderGroup(bucket).catch(() => undefined);
        }
      })();
    }, this.options.tickMs);
    bucket.ticker.unref?.();
    void parentID;
  }

  private stopTicker(bucket: Bucket<T>): void {
    if (bucket.ticker) clearInterval(bucket.ticker);
    bucket.ticker = undefined;
  }

  private scheduleDelete(bucket: Bucket<T>, card: Card): void {
    if (card.keep || card.deleteTimer) return;
    if (card.grouped) {
      if (bucket.cards.some((entry) => entry.grouped && entry.state === "running")) return;
      this.scheduleGroupDelete(bucket);
      return;
    }
    card.deleteTimer = setTimeout(() => {
      card.deleteTimer = undefined;
      if (card.keep) return;
      if (card.messageId) void this.options.remove?.(bucket.target, card.messageId).catch(() => undefined);
      bucket.cards = bucket.cards.filter((entry) => entry !== card);
    }, this.ttlMs);
    card.deleteTimer.unref?.();
  }

  private scheduleGroupDelete(bucket: Bucket<T>): void {
    if (bucket.groupKeep || bucket.groupTimer || !bucket.groupId) return;
    bucket.groupTimer = setTimeout(() => {
      bucket.groupTimer = undefined;
      if (bucket.groupKeep) return;
      const id = bucket.groupId;
      bucket.groupId = undefined;
      bucket.cards = bucket.cards.filter((entry) => !entry.grouped);
      if (id) void this.options.remove?.(bucket.target, id).catch(() => undefined);
    }, this.ttlMs);
    bucket.groupTimer.unref?.();
  }

  private cancelGroupDelete(bucket: Bucket<T>): void {
    if (bucket.groupTimer) clearTimeout(bucket.groupTimer);
    bucket.groupTimer = undefined;
  }
}
