import type { Client, Message, MessageCreateOptions } from "discord.js";
import { log } from "../log.ts";
import { sanitizeModelName, UNKNOWN_MODEL } from "../model.ts";
import { assignChunk, planChunks, TurnGate } from "../order.ts";
import { statusMarkdown, type StatusItem } from "../status.ts";
import { TypingPulse } from "../typing.ts";
import { DISCORD_CHUNK, chunkText, formatDuration, toDiscordMarkdown } from "./render.ts";
import { TURN_TTL_MS, TurnRegistry, turnKey, type TurnRef } from "../turns.ts";

const PLACEHOLDER = "⏳ Думаю…";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Finished tool lines fade out of the status block after this long. */
const TOOL_TTL_MS = 10_000;
const MAX_STATUS_TOOLS = 2;
const MAX_STATUS_SUBAGENTS = 2;
/** A turn id is not reused for this long after its stream was finalized. */
const CLOSED_TTL_MS = 15_000;

type ToolResult = "running" | "ok" | "fail";

interface ToolState {
  callID: string;
  icon: string;
  label: string;
  startedAt: number;
  state: ToolResult;
  finishedAt?: number;
  count: number;
}

interface SubagentState {
  label: string;
  startedAt: number;
  state: ToolResult;
  finishedAt?: number;
  count: number;
}

export interface SendableChannel {
  id: string;
  send(options: MessageCreateOptions): Promise<Message>;
  sendTyping?: () => Promise<void>;
  messages: { fetch(id: string): Promise<Message> };
}

export async function resolveSendable(client: Client, channelId: string): Promise<SendableChannel | undefined> {
  const cached = client.channels.cache.get(channelId);
  const channel = cached ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased()) return undefined;
  const candidate = channel as unknown as Partial<SendableChannel>;
  if (typeof candidate.send !== "function" || !candidate.messages) return undefined;
  return candidate as SendableChannel;
}

export interface DiscordStreamOptions {
  /** Discord rate limits edits per channel; never below 2500 ms. */
  editIntervalMs: number;
  showTools: "off" | "compact" | "full";
  /** Called when the bound thread/channel no longer exists. */
  onGone?: (sessionID: string) => void;
  /** `ui.diagnostics`: turn ids in logs and in the stats line (default off). */
  diagnostics?: () => boolean;
}

interface State {
  sessionID: string;
  /** Assistant message id of this turn; a message is never shared by turns. */
  turnId: string;
  channelId: string;
  text: string;
  tools: ToolState[];
  subagents: SubagentState[];
  messageIds: Array<string | undefined>;
  rendered: Array<string | undefined>;
  timer?: ReturnType<typeof setTimeout>;
  statusTimer?: ReturnType<typeof setInterval>;
  typing?: TypingPulse;
  finalizeTimer?: ReturnType<typeof setTimeout>;
  /** Parent turn ended but children are still running: keep the block alive. */
  awaiting: boolean;
  footer?: string;
  frame: number;
  model: string;
  startedAt: number;
  lastEditAt: number;
  lastTickLogAt?: number;
  flushing: boolean;
  /** Tool calls refused by a permission rule during this turn. */
  blocked: number;
  /** In-flight flush, so `end()` cannot be skipped by a slow edit. */
  flushPromise?: Promise<void>;
  finished: boolean;
  /** At least one chunk reached Discord (no duplicate fallback message). */
  delivered: boolean;
}

/**
 * Discord equivalent of the Telegram Streamer: one placeholder message that is
 * edited at most every `editIntervalMs`, plus extra messages for chunks beyond
 * the 2000-char limit. While a turn runs the message starts with a live status
 * block (spinner + model + the last tools).
 */
export class DiscordStreamer {
  /** `sessionID#turnId` → the stream of exactly one turn. */
  private readonly states = new Map<string, State>();
  private readonly models = new Map<string, string>();
  /** Turn bookkeeping: execution.started opens, execution.* ends. */
  private readonly turns = new TurnRegistry();
  /** Blocks a duplicate placeholder after a turn already ended (late SSE). */
  private readonly gate = new TurnGate();
  /** Deltas that arrived before the stream existed; replayed once by `begin`. */
  private readonly pendingText = new Map<string, { text: string; at: number }>();
  /** Finalized turn keys, so a late delta never reopens a finished message. */
  private readonly closed = new Map<string, number>();
  /** `sessionID:messageId` → turn id; a message must never serve two turns. */
  private readonly messageTurns = new Map<string, string>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly client: Client,
    private readonly options: DiscordStreamOptions,
  ) {}

  private diagnostics(): boolean {
    try {
      return this.options.diagnostics?.() === true;
    } catch {
      return false;
    }
  }

  /** Any block of this session is on screen (a parent awaiting subagents too). */
  hasBlock(sessionID: string): boolean {
    return this.latest(sessionID) !== undefined;
  }

  /** The *current* turn of the session still has a live block. */
  has(sessionID: string): boolean {
    const turn = this.turns.current(sessionID);
    return Boolean(turn && this.states.has(turnKey(sessionID, turn.turnId)));
  }

  /** Turn id of the current stream (diagnostics and footers). */
  turnOf(sessionID: string): string | undefined {
    return this.turns.current(sessionID)?.turnId ?? this.latest(sessionID)?.turnId;
  }

  /** Chat message the answer of a turn was written into. */
  messageIdOf(sessionID: string, turnId?: string): string | undefined {
    const state = turnId ? this.states.get(turnKey(sessionID, turnId)) : this.current(sessionID);
    return [...(state?.messageIds ?? [])].reverse().find((id) => Boolean(id));
  }

  elapsedMs(sessionID: string): number | undefined {
    const state = this.current(sessionID) ?? this.latest(sessionID);
    return state ? Date.now() - state.startedAt : undefined;
  }

  /** Model display name currently used by a session's live block. */
  modelOf(sessionID: string): string {
    return sanitizeModelName(this.models.get(sessionID) ?? UNKNOWN_MODEL);
  }

  async begin(sessionID: string, channelId: string, model?: string, newTurn = false, hint?: string): Promise<string | undefined> {
    const turn = this.beginTurn(sessionID, newTurn, hint);
    const key = turnKey(sessionID, turn.turnId);
    const existing = this.states.get(key);
    if (existing) return existing.turnId;
    const closedAt = this.closed.get(key);
    if (closedAt !== undefined && Date.now() - closedAt <= CLOSED_TTL_MS) {
      log.info(`discord late event after turn end ignored for ${sessionID.slice(0, 16)} (${turn.turnId})`);
      return undefined;
    }
    if (!newTurn && !turn.fresh && !this.gate.allowsBegin(sessionID)) {
      log.info(`discord late event after turn end ignored for ${sessionID.slice(0, 16)}`);
      return undefined;
    }
    const channel = await this.resolve(channelId);
    if (!channel) {
      log.warn(`discord: channel ${channelId} not found, stream not started`);
      return undefined;
    }
    const pending = this.pendingText.get(key);
    this.pendingText.delete(key);
    const state: State = {
      sessionID,
      turnId: turn.turnId,
      channelId,
      text: pending?.text ?? "",
      tools: [],
      subagents: [],
      messageIds: [],
      rendered: [],
      awaiting: false,
      frame: 0,
      model: sanitizeModelName(model || this.models.get(sessionID) || UNKNOWN_MODEL),
      startedAt: Date.now(),
      lastEditAt: 0,
      flushing: false,
      blocked: 0,
      finished: false,
      delivered: false,
    };
    this.models.set(sessionID, state.model);
    this.states.set(key, state);
    this.ensureSweep();
    const message = await channel.send({ content: PLACEHOLDER, allowedMentions: { parse: [] } });
    state.messageIds.push(message.id);
    state.rendered.push(PLACEHOLDER);
    state.delivered = true;
    this.noteMessage(sessionID, state.turnId, message.id);
    if (this.diagnostics()) {
      log.info(`discord turn start ${sessionID.slice(0, 16)} turn=${state.turnId} msg=${message.id}`);
    }
    if (channel.sendTyping) {
      state.typing = new TypingPulse(() => channel.sendTyping!(), 8000);
      state.typing.start();
    }
    state.lastEditAt = Date.now();
    // Repeating ticker (not a one-shot setTimeout chain): elapsed labels keep
    // moving without new events, including while children run after the parent
    // turn ended. Discord's edit spacing is respected by `lastEditAt`.
    const tick = Math.max(2500, this.options.editIntervalMs || 2500);
    state.statusTimer = setInterval(() => {
      if (state.finished && !state.awaiting) return;
      if (state.flushing) return;
      if (Date.now() - state.lastEditAt < tick) return;
      if (!state.lastTickLogAt || Date.now() - state.lastTickLogAt >= 10_000) {
        state.lastTickLogAt = Date.now();
        const active = state.subagents.filter((entry) => entry.state === "running").length +
          state.tools.filter((entry) => entry.state === "running").length;
        log.info(
          `discord status tick ${state.sessionID.slice(0, 16)} elapsed=${formatDuration(Date.now() - state.startedAt)} active=${active}`,
        );
      }
      void this.flush(state).catch((error) => log.warn("discord status tick flush failed:", (error as Error).message));
    }, tick);
    state.statusTimer.unref?.();
    return state.turnId;
  }

  /** Resolves the turn for a `begin`; replays of `execution.started` never duplicate. */
  private beginTurn(sessionID: string, newTurn: boolean, hint?: string): TurnRef {
    if (!newTurn) {
      const turn = this.turns.bind(sessionID, hint);
      if (turn.adoptedFrom) this.rekey(sessionID, turn.adoptedFrom, turn.turnId);
      return turn;
    }
    const current = this.turns.current(sessionID);
    const live = current ? this.states.get(turnKey(sessionID, current.turnId)) : undefined;
    if (current && !hint && live && !live.finished) {
      return { turnId: current.turnId, fresh: false, provisional: current.provisional };
    }
    return this.turns.started(sessionID, hint);
  }

  private rekey(sessionID: string, from: string, to: string): void {
    const fromKey = turnKey(sessionID, from);
    const toKey = turnKey(sessionID, to);
    const state = this.states.get(fromKey);
    if (state && !this.states.has(toKey)) {
      this.states.delete(fromKey);
      state.turnId = to;
      this.states.set(toKey, state);
    }
    const pending = this.pendingText.get(fromKey);
    if (pending) {
      this.pendingText.delete(fromKey);
      if (!this.pendingText.has(toKey)) this.pendingText.set(toKey, pending);
    }
    const closedAt = this.closed.get(fromKey);
    if (closedAt !== undefined) {
      this.closed.delete(fromKey);
      this.closed.set(toKey, closedAt);
    }
  }

  private resolveTurn(sessionID: string, hint?: string): { turnId: string; key: string; state?: State } {
    const turn = this.turns.bind(sessionID, hint);
    if (turn.adoptedFrom) this.rekey(sessionID, turn.adoptedFrom, turn.turnId);
    const key = turnKey(sessionID, turn.turnId);
    return { turnId: turn.turnId, key, state: this.states.get(key) };
  }

  private current(sessionID: string): State | undefined {
    const turn = this.turns.current(sessionID);
    return turn ? this.states.get(turnKey(sessionID, turn.turnId)) : undefined;
  }

  /** Map key of a stream; always derived from the state, so rekeys stay valid. */
  private keyOf(state: State): string {
    return turnKey(state.sessionID, state.turnId);
  }

  private latest(sessionID: string): State | undefined {
    let found: State | undefined;
    for (const state of this.states.values()) {
      if (state.sessionID !== sessionID) continue;
      if (!found || state.startedAt >= found.startedAt) found = state;
    }
    return found;
  }

  private noteMessage(sessionID: string, turnId: string, messageId: string): void {
    const key = `${sessionID}:${messageId}`;
    const previous = this.messageTurns.get(key);
    if (previous && previous !== turnId) {
      log.warn(`discord message ${messageId} reused across turns ${previous} → ${turnId} for ${sessionID.slice(0, 16)}`);
    }
    this.messageTurns.set(key, turnId);
  }

  setModel(sessionID: string, model: string): void {
    const label = sanitizeModelName(model);
    this.models.set(sessionID, label);
    for (const state of this.states.values()) {
      if (state.sessionID !== sessionID || state.model === label) continue;
      state.model = label;
      this.schedule(state);
    }
  }

  append(sessionID: string, delta: string, hint?: string): void {
    const { key, state } = this.resolveTurn(sessionID, hint);
    if (!state) {
      if (!delta) return;
      if (this.closed.has(key)) return; // late delta of a finished turn
      const pending = this.pendingText.get(key);
      const text = `${pending?.text ?? ""}${delta}`;
      this.pendingText.set(key, { text: text.slice(-200_000), at: Date.now() });
      return;
    }
    if (!delta) return;
    state.text += delta;
    this.schedule(state);
  }

  setText(sessionID: string, text: string, hint?: string): void {
    const { key, state } = this.resolveTurn(sessionID, hint);
    if (!state || !text) return;
    state.text = text;
    this.schedule(state);
  }

  /** `session.tool.failed` for a permission/policy refusal. */
  blockedTool(sessionID: string, hint?: string): void {
    const state = this.resolveTurn(sessionID, hint).state ?? this.latest(sessionID);
    if (!state) return;
    state.blocked += 1;
  }

  blockedOf(sessionID: string): number {
    return this.current(sessionID)?.blocked ?? this.latest(sessionID)?.blocked ?? 0;
  }

  /** `session.tool.called`: remember the tool for the live status block. */
  toolCalled(sessionID: string, callID: string, name: string, input: unknown, hint?: string): void {
    if (this.options.showTools === "off") return;
    const { key, state } = this.resolveTurn(sessionID, hint);
    if (!state) return;
    const presentation = toolPresentation(name, input);
    const existing = state.tools.find((tool) => tool.label === presentation.label);
    if (existing) {
      existing.count += 1;
      existing.startedAt = Date.now();
      existing.state = "running";
      existing.finishedAt = undefined;
      if (callID) existing.callID = callID;
    } else {
      state.tools.push({
        callID,
        icon: presentation.icon,
        label: presentation.label,
        startedAt: Date.now(),
        state: "running",
        count: 1,
      });
      if (state.tools.length > 24) state.tools.shift();
    }
    this.schedule(state);
  }

  /** `session.tool.success` / `session.tool.failed`. */
  toolFinished(sessionID: string, callID: string, ok: boolean, hint?: string): void {
    const { key, state } = this.resolveTurn(sessionID, hint);
    if (!state) return;
    const tool = callID ? state.tools.find((entry) => entry.callID === callID) : undefined;
    if (!tool || tool.state !== "running") return;
    tool.state = ok ? "ok" : "fail";
    tool.finishedAt = Date.now();
    this.schedule(state);
  }

  /** Child session started: `🧩 <agent> · 12s` in the parent's live block. */
  subagentStarted(sessionID: string, label: string): void {
    const state = this.latest(sessionID);
    if (!state) return;
    if (state.finalizeTimer) {
      clearTimeout(state.finalizeTimer);
      state.finalizeTimer = undefined;
    }
    const value = label || "subagent";
    const existing = state.subagents.find((entry) => entry.label === value);
    if (existing) {
      existing.count += 1;
      existing.startedAt = Date.now();
      existing.state = "running";
      existing.finishedAt = undefined;
    } else {
      state.subagents.push({ label: value, startedAt: Date.now(), state: "running", count: 1 });
      if (state.subagents.length > 24) state.subagents.shift();
    }
    if (state.finished) state.awaiting = true;
    this.schedule(state);
  }

  /** Child session finished: `✓` / `✗`, fades out after ~10 s. */
  subagentFinished(sessionID: string, label: string, ok: boolean): void {
    const state = this.latest(sessionID);
    if (!state) return;
    const entry = state.subagents.find((item) => item.label === (label || "subagent") && item.state === "running");
    if (!entry) return;
    entry.state = ok ? "ok" : "fail";
    entry.finishedAt = Date.now();
    this.schedule(state);
    if (state.awaiting && !hasActiveSubagents(state)) this.scheduleFinalize(state);
  }

  /**
   * Parent turn ended. With children still running the block stays alive
   * (footer included) until the last child finishes and its line fades.
   * The turn itself ends immediately: the next prompt opens a new message.
   */
  async end(sessionID: string, footer?: string, turnId?: string): Promise<string | undefined> {
    const id = turnId ?? this.turns.current(sessionID)?.turnId;
    const key = id ? turnKey(sessionID, id) : undefined;
    const state = key ? this.states.get(key) : undefined;
    this.turns.end(sessionID, id);
    if (!state || !key) return id;
    state.finished = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    if (hasActiveSubagents(state)) {
      state.awaiting = true;
      state.footer = footer;
      log.info(`discord turn ended with active subagents ${sessionID.slice(0, 16)}; keeping live block`);
      await this.flush(state, footer).catch((error) =>
        log.warn("discord subagent tail flush failed:", (error as Error).message),
      );
      return state.turnId;
    }

    await this.finalize(state, footer);
    return state.turnId;
  }

  /** Delivers the final message once and removes the state. */
  private async finalize(state: State, footer?: string): Promise<void> {
    const key = this.keyOf(state);
    if (this.states.get(key) !== state) return;
    if (state.finalizeTimer) {
      clearTimeout(state.finalizeTimer);
      state.finalizeTimer = undefined;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.statusTimer) clearInterval(state.statusTimer);
    state.typing?.stop();
    state.typing = undefined;
    this.gate.close(state.sessionID);
    this.turns.end(state.sessionID, state.turnId);

    const text = footer ?? state.footer;
    let delivered = false;
    for (let attempt = 0; attempt < 3 && !delivered; attempt += 1) {
      try {
        await this.flush(state, text);
        delivered = true;
      } catch (error) {
        const wait = attempt === 0 ? 2000 : attempt === 1 ? 5000 : 10000;
        log.warn(`discord final delivery failed (attempt ${attempt + 1}): ${(error as Error).message}; retry in ${wait}ms`);
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }

    if (!delivered) {
      try {
        const channel = await this.resolve(state.channelId);
        const finalText = this.compose(state, footer ?? state.footer);
        const existing = [...state.messageIds].reverse().find((id) => Boolean(id));
        if (channel && existing) {
          // Reuse the message that already carries part of the answer.
          const message = await channel.messages.fetch(existing);
          await message.edit({ content: finalText, allowedMentions: { parse: [] } });
          log.info(`discord final delivery recovered by editing ${existing} for ${state.sessionID.slice(0, 16)}`);
        } else if (channel) {
          for (const chunk of chunkText(finalText)) {
            await channel.send({ content: chunk, allowedMentions: { parse: [] } });
          }
          log.info(`discord final delivery recovered as a new message for ${state.sessionID.slice(0, 16)}`);
        }
      } catch (error) {
        log.error(`discord final delivery lost for ${state.sessionID.slice(0, 16)}: ${(error as Error).message}`);
      }
    }
    // Delete only after the final flush: an early delete let a late tick find
    // no state and drop the answer.
    this.closed.set(key, Date.now());
    this.pendingText.delete(key);
    if (this.states.get(key) === state) this.states.delete(key);
    if (this.diagnostics()) {
      const ids = state.messageIds.filter((id): id is string => Boolean(id)).join(",");
      log.info(`discord turn end ${state.sessionID.slice(0, 16)} turn=${state.turnId} msg=${ids || "none"}`);
    }
  }

  /** Drops streams whose turn end never arrived, so the maps cannot grow. */
  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, state] of [...this.states]) {
      if (now - state.startedAt <= TURN_TTL_MS) continue;
      log.warn(`discord stale stream ${state.sessionID.slice(0, 16)} turn=${state.turnId} removed after 1 h`);
      if (state.timer) clearTimeout(state.timer);
      if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
      if (state.statusTimer) clearInterval(state.statusTimer);
      state.typing?.stop();
      this.states.delete(key);
      this.closed.set(key, now);
      this.pendingText.delete(key);
      this.turns.end(state.sessionID, state.turnId);
    }
    for (const [key, entry] of [...this.pendingText]) {
      if (now - entry.at > TURN_TTL_MS) this.pendingText.delete(key);
    }
    for (const [key, at] of [...this.closed]) {
      if (now - at > CLOSED_TTL_MS) this.closed.delete(key);
    }
    this.turns.pruneAll(now);
    if (this.messageTurns.size > 1000) this.messageTurns.clear();
  }

  /** Keeps the finished child line visible for the TTL, then finalizes. */
  private scheduleFinalize(state: State): void {
    if (state.finalizeTimer) return;
    state.finalizeTimer = setTimeout(() => {
      state.finalizeTimer = undefined;
      if (hasActiveSubagents(state)) return;
      void this.finalize(state).catch((error) =>
        log.warn("discord subagent finalize failed:", (error as Error).message),
      );
    }, TOOL_TTL_MS);
    state.finalizeTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await Promise.all(
      [...this.states.values()].map((state) => this.end(state.sessionID, undefined, state.turnId)),
    );
  }

  private schedule(state: State): void {
    if (state.timer) return;
    const interval = this.options.editIntervalMs || 2500;
    const wait = Math.max(0, interval - (Date.now() - state.lastEditAt));
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.flush(state).catch((error) => log.warn("discord stream flush failed:", (error as Error).message));
    }, wait);
    state.timer.unref?.();
  }

  /**
   * Body + tail (`status` block, then the stats line). The live status block
   * lives *below* the answer; when the turn ends only the stats line remains.
   */
  private composeParts(state: State, footer?: string): { body: string; tail: string } {
    const status = state.finished && !state.awaiting ? "" : this.statusBlock(state);
    const line = footer ?? state.footer;
    return {
      body: state.text.trim() ? toDiscordMarkdown(state.text.trim()) : "",
      tail: [status, line].filter(Boolean).join("\n\n"),
    };
  }

  private compose(state: State, footer?: string): string {
    const { body, tail } = this.composeParts(state, footer);
    return [body, tail].filter(Boolean).join("\n\n") || PLACEHOLDER;
  }

  /** Chunks with the live block appended to the LAST chunk only. */
  private composeChunks(state: State, footer?: string): string[] {
    const { body, tail } = this.composeParts(state, footer);
    if (!body) return tail ? [tail] : [PLACEHOLDER];
    const reserve = tail ? tail.length + 2 : 0;
    const chunks = chunkText(body, Math.max(400, DISCORD_CHUNK - reserve));
    if (!chunks.length) return [PLACEHOLDER];
    if (tail) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n${tail}`;
    return chunks;
  }

  /** Three physical lines: model, tools, subagents. Bold only the model. */
  private statusBlock(state: State): string {
    const now = Date.now();
    const tools: StatusItem[] = [];
    if (this.options.showTools !== "off") {
      for (const tool of state.tools
        .filter((item) => item.state === "running" || (item.finishedAt !== undefined && now - item.finishedAt <= TOOL_TTL_MS))
        .slice(-MAX_STATUS_TOOLS)) {
        tools.push({
          icon: tool.icon,
          label: tool.label,
          code: true,
          count: tool.count,
          duration: formatDuration((tool.finishedAt ?? now) - tool.startedAt),
          mark: tool.state === "ok" ? "✓" : tool.state === "fail" ? "✗" : "",
          active: tool.state === "running",
        });
      }
    }
    const subagents: StatusItem[] = state.subagents
      .filter((entry) => entry.state === "running" || (entry.finishedAt !== undefined && now - entry.finishedAt <= TOOL_TTL_MS))
      .slice(-MAX_STATUS_SUBAGENTS)
      .map((entry) => ({
        icon: "🧩",
        label: entry.label,
        count: entry.count,
        duration: formatSubagentElapsed((entry.finishedAt ?? now) - entry.startedAt),
        mark: entry.state === "ok" ? "✓" : entry.state === "fail" ? "✗" : "",
      }));
    return statusMarkdown({
      model: state.model,
      phase: state.awaiting ? "subagents…" : "thinking…",
      elapsed: formatDuration(now - state.startedAt),
      tools,
      subagents,
      frame: Math.floor(now / 120),
    });
  }

  private async flush(state: State, footer?: string): Promise<void> {
    // Serialize with any in-flight tick: a slow edit used to make `end()` a
    // no-op, leaving the placeholder on screen with no final answer.
    while (state.flushPromise) await state.flushPromise.catch(() => undefined);
    if (this.states.get(this.keyOf(state)) !== state) return;
    const run = this.performFlush(state, footer);
    state.flushPromise = run;
    try {
      await run;
    } finally {
      if (state.flushPromise === run) state.flushPromise = undefined;
    }
  }

  private async performFlush(state: State, footer?: string): Promise<void> {
    state.flushing = true;
    try {
      if (!state.finished) state.frame = (state.frame + 1) % SPINNER.length;
      const channel = await this.resolve(state.channelId);
      if (!channel) {
        this.options.onGone?.(state.sessionID);
        return;
      }
      const chunks = this.composeChunks(state, footer);
      for (const step of planChunks(state.messageIds, chunks.length)) {
        const chunk = chunks[step.index] ?? "";
        if (!chunk) continue;
        const messageId = state.messageIds[step.index];
        if (messageId === undefined) {
          const message = await channel.send({ content: chunk, allowedMentions: { parse: [] } });
          assignChunk(state.messageIds, step.index, message.id);
          state.rendered[step.index] = chunk;
          this.noteMessage(state.sessionID, state.turnId, message.id);
          continue;
        }
        // Always edit: elapsed strings change every tick, so a same-content
        // guard would leave the live block frozen.
        try {
          const message = await channel.messages.fetch(messageId);
          await message.edit({ content: chunk, allowedMentions: { parse: [] } });
          state.rendered[step.index] = chunk;
        } catch (error) {
          const code = (error as { code?: number }).code;
          if (code === 10008 || code === 10003) {
            // Message or channel was deleted mid-stream: send this chunk afresh.
            state.messageIds[step.index] = undefined;
            state.rendered[step.index] = undefined;
            const message = await channel.send({ content: chunk, allowedMentions: { parse: [] } });
            assignChunk(state.messageIds, step.index, message.id);
            state.rendered[step.index] = chunk;
            this.noteMessage(state.sessionID, state.turnId, message.id);
            continue;
          }
          if (isRateLimited(error)) {
            await waitForRateLimit(error);
            return; // the next 2.5 s tick retries
          }
          throw error;
        }
      }
      state.delivered = true;
      state.lastEditAt = Date.now();
    } finally {
      state.flushing = false;
    }
  }

  private async resolve(channelId: string): Promise<SendableChannel | undefined> {
    return resolveSendable(this.client, channelId);
  }
}

/** Subagent line: `12s`, `1m 03s` (seconds zero-padded). */
function formatSubagentElapsed(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
}

/** At least one child is running (not counting the fade-out window). */
function hasActiveSubagents(state: { subagents: SubagentState[] }): boolean {
  return state.subagents.some((entry) => entry.state === "running");
}

function isRateLimited(error: unknown): boolean {
  const value = error as { status?: number; httpStatus?: number; name?: string; code?: number };
  return value?.status === 429 || value?.httpStatus === 429 || value?.name === "RateLimitError" || value?.code === 429;
}

/** Waits `retry_after` from a Discord 429; the next tick retries the edit. */
async function waitForRateLimit(error: unknown): Promise<void> {
  const value = error as { retryAfter?: number; rawError?: { retry_after?: number } };
  const raw = value?.rawError?.retry_after ?? value?.retryAfter ?? 2.5;
  const ms = Math.max(1000, raw > 100 ? raw : raw * 1000);
  log.warn(`discord 429, retry after ${Math.round(ms / 1000)}s`);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Human label for a tool call (`edit bot.ts`, `bash npm test`). Copied from Telegram. */
function toolPresentation(name: string, input: unknown): { icon: string; label: string } {
  const toolName = (name || "tool").replace(/^[a-z]+_/i, "").toLowerCase() || "tool";
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const file = pick("filePath", "file_path", "path", "filename", "file");
  const command = pick("command", "cmd");
  const pattern = pick("pattern", "query", "search");
  const url = pick("url", "href");
  const description = pick("description", "task");

  if (command) return { icon: "💻", label: `${toolName} ${short(command, 36)}` };
  if (file) {
    const icon = /write|edit|patch|create/.test(toolName) ? "🛠" : "🔍";
    return { icon, label: `${toolName} ${baseName(file)}` };
  }
  if (pattern) {
    const icon = /grep|search|glob|find|list/.test(toolName) ? "🔍" : "🛠";
    const arg = /grep|search/.test(toolName) ? `"${short(pattern, 30)}"` : short(pattern, 32);
    return { icon, label: `${toolName} ${arg}` };
  }
  if (url) return { icon: "🌐", label: `${toolName} ${hostOf(url)}` };
  if (description) return { icon: "🤖", label: `${toolName} ${short(description, 36)}` };
  return { icon: /bash|shell|exec|run/.test(toolName) ? "💻" : "🛠", label: toolName };
}

function short(value: string, max: number): string {
  const line = value.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function baseName(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return clean.split("/").pop() || clean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return short(url, 24);
  }
}
