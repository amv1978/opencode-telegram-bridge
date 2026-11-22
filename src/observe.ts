import { formatUsd } from "./budget.ts";
import { formatDuration, formatTokens } from "./turn.ts";

/**
 * `/observe`: mirror runs that were started outside the bridge (Desktop/TUI)
 * into a chat that opted in. One compact card is edited in place; the final
 * card replaces it. The module is transport-agnostic: adapters provide
 * `send`/`edit`.
 */

export type ObservePlatform = "telegram" | "discord";

export interface ObserveBinding {
  /** Persisted key: `tg:<chatId>:<threadId|0>` or `dc:<channelId>`. */
  key: string;
  platform: ObservePlatform;
  chatId?: number;
  threadId?: number;
  channelId?: string;
}

export function telegramObserveKey(chatId: number, threadId?: number): string {
  return `tg:${chatId}:${threadId ?? 0}`;
}

export function discordObserveKey(channelId: string): string {
  return `dc:${channelId}`;
}

export function parseObserveKey(key: string): ObserveBinding | undefined {
  const telegram = /^tg:(-?\d+):(\d+)$/.exec(key);
  if (telegram) {
    const chatId = Number(telegram[1]);
    const thread = Number(telegram[2]);
    if (!Number.isFinite(chatId)) return undefined;
    return { key, platform: "telegram", chatId, ...(thread ? { threadId: thread } : {}) };
  }
  const discord = /^dc:(.+)$/.exec(key);
  if (discord?.[1]) return { key, platform: "discord", channelId: discord[1] };
  return undefined;
}

export interface ObserveCandidate {
  /** The session already has a topic/thread/chat binding. */
  bound: boolean;
  /** Child sessions are never observed on their own. */
  parent: boolean;
  /** A normal stream (or another observation) is already active. */
  hasStream: boolean;
}

/**
 * Dedup guard: bound sessions live in their own topic/thread, and a session
 * with an active stream must not get a second card in the same chat.
 */
export function pickObserveTarget(
  candidate: ObserveCandidate,
  targets: ObserveBinding[],
): ObserveBinding | undefined {
  if (candidate.bound || candidate.parent || candidate.hasStream) return undefined;
  return targets[0];
}

export interface ObservationTransport {
  send(target: ObserveBinding, text: string): Promise<string | undefined>;
  edit(target: ObserveBinding, messageId: string, text: string): Promise<void>;
}

export interface ObservationOptions {
  transport: ObservationTransport;
  /** Telegram 1.2 s, Discord 2.5 s. */
  intervalMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export interface ObservationFinal {
  ok: boolean;
  durationMs?: number;
  tps?: number;
  contextTokens?: number;
  costUsd?: number;
}

interface Card {
  sessionID: string;
  target: ObserveBinding;
  title: string;
  model: string;
  startedAt: number;
  tools: number;
  messageId?: string;
  timer?: ReturnType<typeof setInterval>;
  chain: Promise<void>;
  closed: boolean;
  ticking: boolean;
  failures: number;
}

export interface ObservationInfo {
  sessionID: string;
  key: string;
  title: string;
  model: string;
  startedAt: number;
  tools: number;
}

/** Compact live card: session title, model, elapsed, tool count. */
export function liveCardText(card: {
  title: string;
  model: string;
  startedAt: number;
  tools: number;
  sessionID: string;
}, now = Date.now()): string {
  const title = card.title.replace(/\s+/g, " ").trim() || card.sessionID.slice(0, 12);
  const head = `👀 ${title}${card.model ? ` · ${card.model}` : ""}`;
  const line = `⏱ ${formatDuration(now - card.startedAt)} · 🛠 ${card.tools}`;
  return `${head}\n${line}`;
}

/** Final card: ✅/⚠️, duration, tok/s, context, cost. */
export function finalCardText(
  card: { title: string; model: string; sessionID: string },
  final: ObservationFinal,
): string {
  const title = card.title.replace(/\s+/g, " ").trim() || card.sessionID.slice(0, 12);
  const head = `${final.ok ? "✅" : "⚠️"} ${title}${card.model ? ` · ${card.model}` : ""}`;
  const parts: string[] = [];
  if (final.durationMs !== undefined && final.durationMs > 0) parts.push(`⏱ ${formatDuration(final.durationMs)}`);
  if (final.tps) parts.push(`⚡ ${final.tps.toFixed(1)} tok/s`);
  if (final.contextTokens) parts.push(`🧠 ${formatTokens(final.contextTokens)}`);
  if (final.costUsd !== undefined) parts.push(`💰 ${formatUsd(final.costUsd)}`);
  return [head, parts.join(" · ")].filter(Boolean).join("\n");
}

/** One card per session; the card message is always edited, never duplicated. */
export class ObservationCards {
  private readonly cards = new Map<string, Card>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly intervalMs: number;

  constructor(private readonly options: ObservationOptions) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
    this.intervalMs = Math.max(1000, options.intervalMs ?? 1200);
  }

  has(sessionID: string): boolean {
    return this.cards.has(sessionID);
  }

  elapsedMs(sessionID: string): number | undefined {
    const card = this.cards.get(sessionID);
    return card ? this.now() - card.startedAt : undefined;
  }

  /** `false` when the session is already observed or the first send failed. */
  async begin(sessionID: string, target: ObserveBinding, model: string, title = ""): Promise<boolean> {
    if (this.cards.has(sessionID)) return false;
    const card: Card = {
      sessionID,
      target,
      title,
      model,
      startedAt: this.now(),
      tools: 0,
      chain: Promise.resolve(),
      closed: false,
      ticking: false,
      failures: 0,
    };
    this.cards.set(sessionID, card);
    await this.deliver(card, liveCardText(card, this.now()));
    if (!this.cards.has(sessionID)) return false;
    card.timer = setInterval(() => this.tick(card), this.intervalMs);
    card.timer.unref?.();
    return true;
  }

  setModel(sessionID: string, model: string): void {
    const card = this.cards.get(sessionID);
    if (!card || !model || card.model === model) return;
    card.model = model;
    this.tick(card, true);
  }

  toolCalled(sessionID: string): void {
    const card = this.cards.get(sessionID);
    if (!card) return;
    card.tools += 1;
  }

  entries(key?: string): ObservationInfo[] {
    return [...this.cards.values()]
      .filter((card) => !key || card.target.key === key)
      .map((card) => ({
        sessionID: card.sessionID,
        key: card.target.key,
        title: card.title,
        model: card.model,
        startedAt: card.startedAt,
        tools: card.tools,
      }));
  }

  async end(sessionID: string, final: ObservationFinal): Promise<void> {
    const card = this.cards.get(sessionID);
    if (!card) return;
    card.closed = true;
    if (card.timer) clearInterval(card.timer);
    card.timer = undefined;
    await card.chain.catch(() => undefined);
    await this.deliver(card, finalCardText(card, final));
    this.cards.delete(sessionID);
  }

  async cancel(sessionID: string, text = "⏹ наблюдение выключено"): Promise<void> {
    const card = this.cards.get(sessionID);
    if (!card) return;
    card.closed = true;
    if (card.timer) clearInterval(card.timer);
    card.timer = undefined;
    await card.chain.catch(() => undefined);
    await this.deliver(card, text);
    this.cards.delete(sessionID);
  }

  async cancelKey(key: string, text = "⏹ наблюдение выключено"): Promise<void> {
    for (const card of [...this.cards.values()]) {
      if (card.target.key !== key) continue;
      await this.cancel(card.sessionID, text);
    }
  }

  async shutdown(): Promise<void> {
    for (const card of [...this.cards.values()]) {
      card.closed = true;
      if (card.timer) clearInterval(card.timer);
      card.timer = undefined;
    }
    this.cards.clear();
  }

  private tick(card: Card, force = false): void {
    if (card.closed || (card.ticking && !force)) return;
    card.ticking = true;
    card.chain = card.chain
      .then(() => this.deliver(card, liveCardText(card, this.now())))
      .catch((error) => this.log(`observe card ${card.sessionID.slice(0, 16)}: ${(error as Error).message}`))
      .finally(() => {
        card.ticking = false;
      });
  }

  private async deliver(card: Card, text: string): Promise<void> {
    try {
      if (card.messageId) {
        await this.options.transport.edit(card.target, card.messageId, text);
        card.failures = 0;
        return;
      }
      const messageId = await this.options.transport.send(card.target, text);
      if (messageId) {
        card.messageId = messageId;
        card.failures = 0;
      }
    } catch (error) {
      // A deleted topic/channel or a 429 must never break the event loop; the
      // next tick retries the edit with the same message id. Log sparsely: a
      // 1.2 s tick would otherwise flood the journal.
      card.failures += 1;
      if (card.failures === 1 || card.failures % 10 === 0) {
        this.log(`observe card ${card.sessionID.slice(0, 16)} failed: ${(error as Error).message}`);
      }
    }
  }
}
