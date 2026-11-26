import { GrammyError, type Api } from "grammy";
import { log } from "../log.ts";
import { sanitizeModelName, UNKNOWN_MODEL } from "../model.ts";
import { assignChunk, planChunks, TurnGate } from "../order.ts";
import { RETRY_ATTEMPTS, RetryCounters, errorText, retryAfterMs, withRetry } from "../retry.ts";
import { statusHtml, statusMarkdownList, type StatusItem } from "../status.ts";
import { TypingPulse } from "../typing.ts";
import { markdownToHtml, splitHtml, splitMarkdown, stripHtml } from "./render.ts";
import { TURN_TTL_MS, TurnRegistry, turnKey, type TurnRef } from "../turns.ts";

export interface Target {
  chatId: number;
  threadId?: number;
}

export interface StreamerOptions {
  editIntervalMs: number;
  showTools: "off" | "compact" | "full";
  /** "rich" = Telegram Rich Messages with native Markdown; "html" = classic parse_mode. */
  format: "rich" | "html";
  /** Called when Telegram reports that the bound topic no longer exists. */
  onThreadGone?: (sessionID: string) => void;
  /** `ui.diagnostics`: turn ids in logs and in the stats line (default off). */
  diagnostics?: () => boolean;
}

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

interface State {
  sessionID: string;
  /** Assistant message id of this turn; a message is never shared by turns. */
  turnId: string;
  target: Target;
  text: string;
  tools: ToolState[];
  subagents: SubagentState[];
  messageIds: Array<number | undefined>;
  timer?: ReturnType<typeof setTimeout>;
  typing?: TypingPulse;
  /** Repeating ticker: elapsed time changes even without new events. */
  ticker?: ReturnType<typeof setInterval>;
  finalizeTimer?: ReturnType<typeof setTimeout>;
  /** Parent turn ended but children are still running: keep the block alive. */
  awaiting: boolean;
  footer?: string;
  model: string;
  startedAt: number;
  lastEditAt: number;
  flushing: boolean;
  /** Tool calls refused by a permission rule during this turn. */
  blocked: number;
  /** In-flight flush, so `end()` cannot be skipped by a slow edit. */
  flushPromise?: Promise<void>;
  finished: boolean;
  /** At least one chunk reached Telegram (no duplicate fallback message). */
  delivered: boolean;
}

const PLACEHOLDER = "⏳ Думаю…";
/** Finished tool lines fade out of the status block after this long. */
const TOOL_TTL_MS = 10_000;
const STATUS_TICK_MS = 1200;
const MAX_STATUS_TOOLS = 2;
const MAX_STATUS_SUBAGENTS = 2;
/** A turn id is not reused for this long after its stream was finalized. */
const CLOSED_TTL_MS = 15_000;

export class Streamer {
  /** `sessionID#turnId` → the stream of exactly one turn. */
  private readonly states = new Map<string, State>();
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
  /** Flipped to false permanently once Telegram rejects a rich message. */
  private rich: boolean;
  /** model display name currently used by a session's live block. */
  private readonly models = new Map<string, string>();
  /** 429 retries and lost deliveries, surfaced in `/api/state.delivery`. */
  readonly stats = new RetryCounters();

  constructor(private readonly api: Api, private readonly options: StreamerOptions) {
    this.rich = options.format !== "html";
  }

  /** Delivery counters for the panel/API. */
  retryStats(): { retries: number; lost: number } {
    return this.stats.snapshot();
  }

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

  /** Any stream of the session that has not been finalized yet. */
  hasLive(sessionID: string): boolean {
    for (const state of this.states.values()) {
      if (state.sessionID === sessionID && !state.finished) return true;
    }
    return false;
  }

  /** Turn id of the current stream (diagnostics and footers). */
  turnOf(sessionID: string): string | undefined {
    return this.turns.current(sessionID)?.turnId ?? this.latest(sessionID)?.turnId;
  }

  /** Chat message the answer of a turn was written into. */
  messageIdOf(sessionID: string, turnId?: string): number | undefined {
    const state = turnId ? this.states.get(turnKey(sessionID, turnId)) : this.current(sessionID);
    return [...(state?.messageIds ?? [])].reverse().find((id) => id !== undefined);
  }

  elapsedMs(sessionID: string): number | undefined {
    const state = this.current(sessionID) ?? this.latest(sessionID);
    return state ? Date.now() - state.startedAt : undefined;
  }

  modelOf(sessionID: string): string {
    return sanitizeModelName(this.models.get(sessionID) ?? UNKNOWN_MODEL);
  }

  /** `session.model.selected`: update every live block without restarting it. */
  setModel(sessionID: string, model: string): void {
    const label = sanitizeModelName(model);
    this.models.set(sessionID, label);
    for (const state of this.states.values()) {
      if (state.sessionID !== sessionID || state.model === label) continue;
      state.model = label;
      this.schedule(state, STATUS_TICK_MS);
    }
  }

  async begin(sessionID: string, target: Target, model?: string, newTurn = false, hint?: string): Promise<string | undefined> {
    const turn = this.beginTurn(sessionID, newTurn, hint);
    if (turn.stale) {
      log.info(`late event for an ended turn ignored for ${sessionID.slice(0, 16)} (${turn.turnId})`);
      return undefined;
    }
    const key = turnKey(sessionID, turn.turnId);
    const existing = this.states.get(key);
    if (existing) return existing.turnId;
    const closedAt = this.closed.get(key);
    if (closedAt !== undefined && Date.now() - closedAt <= CLOSED_TTL_MS) {
      log.info(`late event after turn end ignored for ${sessionID.slice(0, 16)} (${turn.turnId})`);
      return undefined;
    }
    if (!newTurn && !turn.fresh && !this.gate.allowsBegin(sessionID)) {
      log.info(`late event after turn end ignored for ${sessionID.slice(0, 16)}`);
      return undefined;
    }
    const pending = this.pendingText.get(key);
    this.pendingText.delete(key);
    const state: State = {
      sessionID,
      turnId: turn.turnId,
      target,
      text: pending?.text ?? "",
      tools: [],
      subagents: [],
      messageIds: [],
      awaiting: false,
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
    const messageId = await this.send(sessionID, state, this.composeMarkdown(state));
    if (messageId) {
      state.messageIds.push(messageId);
      state.delivered = true;
      this.noteMessage(sessionID, state.turnId, messageId);
    }
    if (this.diagnostics()) {
      log.info(`turn start ${sessionID.slice(0, 16)} turn=${state.turnId} msg=${messageId ?? "none"}`);
    }
    state.lastEditAt = Date.now();
    state.typing = new TypingPulse(() => this.api.sendChatAction(target.chatId, "typing"), 4500);
    state.typing.start();
    // Repeating ticker (not a one-shot setTimeout chain): recomputes elapsed
    // strings and forces an edit even when only the number changed. Keeps
    // `🧩 … · 12s` / `🛠 … · 3s` moving after the parent turn ended too.
    state.ticker = setInterval(() => {
      if (state.finished && !state.awaiting) return;
      if (state.flushing) return;
      if (Date.now() - state.lastEditAt < Math.max(STATUS_TICK_MS, this.options.editIntervalMs || STATUS_TICK_MS)) return;
      void this.flush(state).catch((error) => log.warn("status tick flush failed:", (error as Error).message));
    }, STATUS_TICK_MS);
    state.ticker.unref?.();
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
    // A replayed `execution.started` without a message id must not open a second
    // message for a turn that is still streaming.
    if (current && !hint && live && !live.finished) {
      return { turnId: current.turnId, fresh: false, provisional: current.provisional };
    }
    return this.turns.started(sessionID, hint);
  }

  /**
   * Moves a provisional stream to the real assistant message id. Before this
   * the two ids addressed two different `begin()` calls (or none).
   */
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

  /**
   * Binds an event to its turn and returns that turn's stream, if any.
   *
   * A new assistant id opens a new turn in the registry. If that turn has no
   * stream yet but the session still has a live one (a later step of the running
   * answer), the text/tool goes to the live stream instead of spawning a second
   * message. An end event later finalizes the live stream with a mismatch log.
   */
  private resolveTurn(sessionID: string, hint?: string): { turnId: string; key: string; state?: State; stale: boolean } {
    const turn = this.turns.bind(sessionID, hint);
    if (turn.stale) {
      return { turnId: turn.turnId, key: turnKey(sessionID, turn.turnId), state: undefined, stale: true };
    }
    if (turn.adoptedFrom) this.rekey(sessionID, turn.adoptedFrom, turn.turnId);
    const key = turnKey(sessionID, turn.turnId);
    let state = this.states.get(key);
    if (!state) {
      const live = this.liveState(sessionID);
      if (live) {
        log.info(
          `event turn ${turn.turnId} routed to live stream ${live.turnId} for ${sessionID.slice(0, 16)}`,
        );
        state = live;
      }
    }
    return { turnId: turn.turnId, key, state, stale: false };
  }

  private current(sessionID: string): State | undefined {
    const turn = this.turns.current(sessionID);
    return turn ? this.states.get(turnKey(sessionID, turn.turnId)) : undefined;
  }

  /** Map key of a stream; always derived from the state, so rekeys stay valid. */
  private keyOf(state: State): string {
    return turnKey(state.sessionID, state.turnId);
  }

  /** Newest stream of a session, even if its turn already ended. */
  private latest(sessionID: string): State | undefined {
    let found: State | undefined;
    for (const state of this.states.values()) {
      if (state.sessionID !== sessionID) continue;
      if (!found || state.startedAt >= found.startedAt) found = state;
    }
    return found;
  }

  /** A message id must belong to one turn; a second owner is a real bug. */
  private noteMessage(sessionID: string, turnId: string, messageId: number): void {
    const key = `${sessionID}:${messageId}`;
    const previous = this.messageTurns.get(key);
    if (previous && previous !== turnId) {
      log.warn(
        `message ${messageId} reused across turns ${previous} → ${turnId} for ${sessionID.slice(0, 16)}`,
      );
    }
    this.messageTurns.set(key, turnId);
  }

  append(sessionID: string, delta: string, hint?: string): void {
    const { key, state, stale } = this.resolveTurn(sessionID, hint);
    if (stale) {
      log.debug(`late delta for an ended turn ignored ${sessionID.slice(0, 16)} (${hint ?? "?"})`);
      return;
    }
    if (!state) {
      if (!delta) return;
      if (this.closed.has(key)) return; // late delta of a finished turn
      const pending = this.pendingText.get(key);
      const text = `${pending?.text ?? ""}${delta}`;
      this.pendingText.set(key, { text: text.slice(-200_000), at: Date.now() });
      return;
    }
    if (!delta || state.finished) return;
    state.text += delta;
    this.schedule(state);
  }

  setText(sessionID: string, text: string, hint?: string): void {
    const { state, stale } = this.resolveTurn(sessionID, hint);
    if (stale || !state || !text || state.finished) return;
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
    this.schedule(state, STATUS_TICK_MS);
  }

  /** `session.tool.success` / `session.tool.failed`. */
  toolFinished(sessionID: string, callID: string, ok: boolean, hint?: string): void {
    const { key, state } = this.resolveTurn(sessionID, hint);
    if (!state) return;
    const tool = callID ? state.tools.find((entry) => entry.callID === callID) : undefined;
    if (!tool || tool.state !== "running") return;
    tool.state = ok ? "ok" : "fail";
    tool.finishedAt = Date.now();
    this.schedule(state, STATUS_TICK_MS);
  }

  /** Child session started: shows `🧩 <agent> · 12s` in the parent's live block. */
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
    this.schedule(state, STATUS_TICK_MS);
  }

  /** Child session finished: `✓` / `✗`, then the line fades out after ~10 s. */
  subagentFinished(sessionID: string, label: string, ok: boolean): void {
    const state = this.latest(sessionID);
    if (!state) return;
    const entry = state.subagents.find((item) => item.label === (label || "subagent") && item.state === "running");
    if (!entry) return;
    entry.state = ok ? "ok" : "fail";
    entry.finishedAt = Date.now();
    this.schedule(state, STATUS_TICK_MS);
    if (state.awaiting && !hasActiveSubagents(state)) this.scheduleFinalize(state);
  }

  /**
   * Parent turn ended. If children are still running the block stays alive
   * (footer included) until the last child finishes and its line fades.
   * The *turn* itself ends immediately: the next prompt opens a new message,
   * never editing this one.
   *
   * `turnId` is the assistant message id carried by the end event. The stream
   * is looked up by that id; when the event names a different message than the
   * stream (OpenCode is inconsistent here) the mismatch is logged and the newest
   * live stream is finalized instead of silently returning.
   */
  async end(sessionID: string, footer?: string, turnId?: string): Promise<string | undefined> {
    const exact = turnId ? this.states.get(turnKey(sessionID, turnId)) : undefined;
    if (exact?.finished) {
      // Duplicate end (e.g. replay): keep the newest footer, do not re-finalize.
      if (footer && exact.awaiting) exact.footer = footer;
      this.turns.end(sessionID, turnId);
      log.info(`duplicate turn end ignored for ${sessionID.slice(0, 16)} (${turnId})`);
      return exact.turnId;
    }
    const state = exact ?? this.liveState(sessionID);
    const effective = state?.turnId ?? turnId ?? this.turns.current(sessionID)?.turnId;
    this.turns.end(sessionID, turnId);
    if (!state) {
      log.warn(`finalize: no live stream for ${sessionID.slice(0, 16)} turn=${turnId ?? "?"} (footer dropped)`);
      return effective;
    }
    if (turnId && state.turnId !== turnId) {
      log.warn(
        `turn end mismatch ${sessionID.slice(0, 16)}: event turn=${turnId} stream=${state.turnId}; finalizing stream`,
      );
    }
    this.turns.end(sessionID, state.turnId);
    state.finished = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    if (hasActiveSubagents(state)) {
      state.awaiting = true;
      state.footer = footer;
      log.info(`turn ended with active subagents ${sessionID.slice(0, 16)}; keeping live block`);
      await this.flush(state, footer).catch((error) =>
        log.warn("subagent tail flush failed:", (error as Error).message),
      );
      return state.turnId;
    }

    await this.finalize(state, footer);
    return state.turnId;
  }

  /** Newest stream of the session that has not been finalized. */
  private liveState(sessionID: string): State | undefined {
    let found: State | undefined;
    for (const state of this.states.values()) {
      if (state.sessionID !== sessionID || state.finished) continue;
      if (!found || state.startedAt >= found.startedAt) found = state;
    }
    return found;
  }

  /** Delivers the final message once and removes the state. */
  private async finalize(state: State, footer?: string): Promise<void> {
    const key = this.keyOf(state);
    if (this.states.get(key) !== state) {
      log.warn(
        `finalize: stream ${state.sessionID.slice(0, 16)} turn=${state.turnId} was already replaced or removed; skipped`,
      );
      return;
    }
    if (state.finalizeTimer) {
      clearTimeout(state.finalizeTimer);
      state.finalizeTimer = undefined;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.ticker) clearInterval(state.ticker);
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
        log.warn(`final delivery failed (attempt ${attempt + 1}): ${(error as Error).message}; retry in ${wait}ms`);
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }

    if (!delivered) {
      // Last resort: reuse the message that already carries part of the answer,
      // otherwise a network hiccup would post the same answer twice.
      try {
        const markdown = this.composeMarkdown(state, text);
        const existing = [...state.messageIds].reverse().find((id) => id !== undefined);
        if (existing !== undefined) {
          if (this.rich) await this.editRich(state, existing, markdown);
          else await this.editHtml(state, existing, markdownToHtml(markdown));
          log.info(`final delivery recovered by editing message ${existing} for ${state.sessionID.slice(0, 16)}`);
        } else if (this.rich) {
          await this.api.sendRichMessage(state.target.chatId, { markdown }, this.threadOptions(state));
          log.info(`final delivery recovered as a new message for ${state.sessionID.slice(0, 16)}`);
        } else {
          await this.api.sendMessage(state.target.chatId, markdownToHtml(markdown), { parse_mode: "HTML", ...this.threadOptions(state) });
          log.info(`final delivery recovered as a new message for ${state.sessionID.slice(0, 16)}`);
        }
      } catch (error) {
        log.error(`final delivery lost for ${state.sessionID.slice(0, 16)}: ${(error as Error).message}`);
      }
    }
    this.closed.set(key, Date.now());
    this.pendingText.delete(key);
    if (this.states.get(key) === state) this.states.delete(key);
    if (this.diagnostics()) {
      const ids = state.messageIds.filter((id): id is number => id !== undefined).join(",");
      log.info(`turn end ${state.sessionID.slice(0, 16)} turn=${state.turnId} msg=${ids || "none"}`);
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
      log.warn(`stale stream ${state.sessionID.slice(0, 16)} turn=${state.turnId} removed after 1 h`);
      if (state.timer) clearTimeout(state.timer);
      if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
      if (state.ticker) clearInterval(state.ticker);
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
        log.warn("subagent finalize failed:", (error as Error).message),
      );
    }, TOOL_TTL_MS);
    state.finalizeTimer.unref?.();
  }

  private schedule(state: State, overrideInterval?: number): void {
    if (state.timer) return;
    const interval = overrideInterval ?? this.options.editIntervalMs;
    const wait = Math.max(0, interval - (Date.now() - state.lastEditAt));
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.flush(state).catch((error) => log.warn("stream flush failed:", (error as Error).message));
    }, wait);
    state.timer.unref?.();
  }

  /**
   * Body + tail (`status` block, then the italic stats line). The status block
   * lives *below* the answer; when the turn ends only the stats line remains.
   */
  private composeParts(state: State, footer?: string, html = false): { body: string; tail: string } {
    const status = state.finished && !state.awaiting ? "" : this.statusBlock(state, html);
    const line = footer ?? state.footer;
    const stats = line ? (html ? footerHtml(line) : footerMarkdown(line)) : "";
    return {
      body: html ? (state.text.trim() ? markdownToHtml(state.text.trim()) : "") : state.text.trim(),
      tail: [status, stats].filter(Boolean).join("\n\n"),
    };
  }

  /** Full text for a single message (last-resort fallback). */
  private composeMarkdown(state: State, footer?: string): string {
    const { body, tail } = this.composeParts(state, footer);
    return [body, tail].filter(Boolean).join("\n\n") || PLACEHOLDER;
  }

  /**
   * Chunks of the answer with the status block + stats appended to the LAST
   * chunk, so split answers never carry the live block in an earlier message.
   */
  private composeChunks(state: State, footer: string | undefined, html = false): string[] {
    const { body, tail } = this.composeParts(state, footer, html);
    if (!body) return tail ? [tail] : [PLACEHOLDER];
    const limit = html ? 3800 : 30_000;
    const reserve = tail ? tail.length + 2 : 0;
    const chunks = html
      ? splitHtml(body, Math.max(500, limit - reserve))
      : splitMarkdown(body, Math.max(1000, limit - reserve));
    if (!chunks.length) return [PLACEHOLDER];
    if (tail) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n${tail}`;
    return chunks;
  }

  /** Three physical lines: model, tools, subagents. Bold only the model. */
  private statusBlock(state: State, html = false): string {
    const now = Date.now();
    const elapsed = formatElapsed(now - state.startedAt);
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
          duration: formatElapsed((tool.finishedAt ?? now) - tool.startedAt),
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
    const snapshot = {
      model: state.model,
      phase: state.awaiting ? "subagents…" : "thinking…",
      elapsed,
      tools,
      subagents,
      frame: Math.floor(now / 120),
    };
    return html ? statusHtml(snapshot) : statusMarkdownList(snapshot);
  }

  private async flush(state: State, footer?: string): Promise<void> {
    // A slow Telegram edit must not swallow the final message: wait for the
    // in-flight flush, then run ours (the `end()` footer would otherwise be
    // dropped while the placeholder stayed on screen forever).
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
      if (this.rich) {
        try {
          await this.flushRich(state, footer);
          state.delivered = true;
          state.lastEditAt = Date.now();
          return;
        } catch (error) {
          if (!isRichUnsupported(error)) throw error;
          this.rich = false;
          log.warn("rich messages rejected by Telegram, switching to HTML:", (error as Error).message);
        }
      }
      await this.flushHtml(state, footer);
      state.delivered = true;
      state.lastEditAt = Date.now();
    } finally {
      state.flushing = false;
    }
  }

  private async flushRich(state: State, footer?: string): Promise<void> {
    const chunks = this.composeChunks(state, footer);
    // Strictly ascending plan: chunks are edited in place or appended; a
    // retried flush reuses recorded ids and never duplicates a chunk.
    for (const step of planChunks(state.messageIds, chunks.length)) {
      const chunk = chunks[step.index] ?? "";
      if (step.action === "edit") {
        await this.editRich(state, state.messageIds[step.index]!, chunk);
        continue;
      }
      const sent = await this.sendRich(state, chunk);
      if (!sent) return;
      assignChunk(state.messageIds, step.index, sent);
      this.noteMessage(state.sessionID, state.turnId, sent);
    }
  }

  private async flushHtml(state: State, footer?: string): Promise<void> {
    const chunks = this.composeChunks(state, footer, true);
    for (const step of planChunks(state.messageIds, chunks.length)) {
      const chunk = chunks[step.index] ?? "";
      if (step.action === "edit") {
        await this.editHtml(state, state.messageIds[step.index]!, chunk);
        continue;
      }
      const sent = await this.sendHtml(state, chunk);
      if (!sent) return;
      assignChunk(state.messageIds, step.index, sent);
      this.noteMessage(state.sessionID, state.turnId, sent);
    }
  }

  /** First send: rich if allowed, otherwise HTML. */
  private async send(sessionID: string, state: State, markdown: string): Promise<number | undefined> {
    void sessionID;
    if (this.rich) {
      try {
        return await this.sendRich(state, markdown);
      } catch (error) {
        if (!isRichUnsupported(error)) throw error;
        this.rich = false;
        log.warn("rich messages rejected, switching to HTML:", (error as Error).message);
      }
    }
    return this.sendHtml(state, markdownToHtml(markdown));
  }

  private threadOptions(state: State): { message_thread_id?: number } {
    return state.target.threadId ? { message_thread_id: state.target.threadId } : {};
  }

  private async sendRich(state: State, markdown: string): Promise<number | undefined> {
    try {
      const message = await this.withApi("sendRichMessage", () =>
        this.api.sendRichMessage(state.target.chatId, { markdown }, this.threadOptions(state)),
      );
      return message.message_id;
    } catch (error) {
      if (isThreadMissing(error) && state.target.threadId) {
        log.warn(`thread ${state.target.threadId} is gone, posting to the chat root`);
        this.options.onThreadGone?.(state.sessionID);
        state.target.threadId = undefined;
        const message = await this.withApi("sendRichMessage", () =>
          this.api.sendRichMessage(state.target.chatId, { markdown }),
        );
        return message.message_id;
      }
      throw error;
    }
  }

  private async editRich(state: State, messageId: number, markdown: string): Promise<void> {
    try {
      await this.withApi("editMessageText", () =>
        this.api.editMessageText(state.target.chatId, messageId, { markdown }),
      );
    } catch (error) {
      if (isNotModified(error)) return;
      throw error;
    }
  }

  private async sendHtml(state: State, html: string): Promise<number | undefined> {
    const options = { parse_mode: "HTML" as const, ...this.threadOptions(state) };
    try {
      const message = await this.withApi("sendMessage", () =>
        this.api.sendMessage(state.target.chatId, html, options),
      );
      return message.message_id;
    } catch (error) {
      if (isThreadMissing(error) && state.target.threadId) {
        log.warn(`thread ${state.target.threadId} is gone, posting to the chat root`);
        this.options.onThreadGone?.(state.sessionID);
        state.target.threadId = undefined;
        const message = await this.withApi("sendMessage", () =>
          this.api.sendMessage(state.target.chatId, html, { parse_mode: "HTML" }),
        );
        return message.message_id;
      }
      if (isParseError(error)) {
        const message = await this.withApi("sendMessage", () =>
          this.api.sendMessage(state.target.chatId, stripHtml(html), this.threadOptions(state)),
        );
        return message.message_id;
      }
      throw error;
    }
  }

  private async editHtml(state: State, messageId: number, html: string): Promise<void> {
    try {
      await this.withApi("editMessageText", () =>
        this.api.editMessageText(state.target.chatId, messageId, html, { parse_mode: "HTML" }),
      );
    } catch (error) {
      if (isNotModified(error)) return;
      if (isParseError(error)) {
        await this.withApi("editMessageText", () =>
          this.api.editMessageText(state.target.chatId, messageId, stripHtml(html)),
        ).catch(() => undefined);
        return;
      }
      throw error;
    }
  }

  /**
   * One Telegram call with bounded 429 retries. The same send/edit is repeated
   * after `retry_after`; a non-429 error is rethrown untouched. After the last
   * attempt the loss is logged and counted, and the error is rethrown so the
   * next flush tick retries the chunk instead of dropping it.
   */
  private withApi<T>(label: string, call: () => Promise<T>): Promise<T> {
    return withRetry(label, call, {
      retryAfterMs,
      onRetry: (info) => {
        this.stats.recordRetry();
        log.warn(`${label} 429, retry ${info.attempt}/${RETRY_ATTEMPTS} after ${Math.round(info.waitMs / 1000)}s`);
      },
      onLost: (error) => {
        this.stats.recordLoss();
        log.error(`${label} lost after ${RETRY_ATTEMPTS} attempts: ${errorText(error)}`);
      },
    });
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await Promise.all(
      [...this.states.values()].map((state) => this.end(state.sessionID, undefined, state.turnId)),
    );
  }
}

/** Footer lines are italic one by one: a two-line footer stays valid markdown. */
function footerMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[*_~`\\]/.test(line) ? line : `_${line}_`))
    .join("\n");
}

function footerHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<i>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</i>`)
    .join("\n");
}

/** `42s`, `1m 23s` — same shape as the stats footer. */
export function formatElapsed(ms: number): string {  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Subagent line: `12s`, `1m 03s` (seconds zero-padded, as in the spec). */
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

/** Anything whose elapsed label must keep ticking. */
function hasLiveLines(state: { tools: ToolState[]; subagents: SubagentState[] }): boolean {
  return (
    state.subagents.some((entry) => entry.state === "running") ||
    state.tools.some((entry) => entry.state === "running")
  );
}

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

function isThreadMissing(error: unknown): boolean {
  return error instanceof GrammyError && /message thread not found/i.test(error.description);
}

function isNotModified(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

function isParseError(error: unknown): boolean {
  return (
    error instanceof GrammyError && /can't parse entities|unsupported start tag|can't find end tag/i.test(error.description)
  );
}

function isRichUnsupported(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  return (
    error.error_code === 404 ||
    /method|not found|unknown|unsupported|can't parse|parse entities|rich/i.test(error.description)
  );
}
