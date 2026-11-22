import { GrammyError, type Api } from "grammy";
import { log } from "../log.ts";
import { sanitizeModelName, UNKNOWN_MODEL } from "../model.ts";
import { statusHtml, statusMarkdownList, type StatusItem } from "../status.ts";
import { markdownToHtml, splitHtml, splitMarkdown, stripHtml } from "./render.ts";

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
  target: Target;
  text: string;
  tools: ToolState[];
  subagents: SubagentState[];
  messageIds: number[];
  timer?: ReturnType<typeof setTimeout>;
  typing?: ReturnType<typeof setInterval>;
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
  /** In-flight flush, so `end()` cannot be skipped by a slow edit. */
  flushPromise?: Promise<void>;
  finished: boolean;
}

const PLACEHOLDER = "⏳ Думаю…";
/** Finished tool lines fade out of the status block after this long. */
const TOOL_TTL_MS = 10_000;
const STATUS_TICK_MS = 1200;
const MAX_STATUS_TOOLS = 2;
const MAX_STATUS_SUBAGENTS = 2;

export class Streamer {
  private readonly states = new Map<string, State>();
  /** Flipped to false permanently once Telegram rejects a rich message. */
  private rich: boolean;
  /** model display name currently used by a session's live block. */
  private readonly models = new Map<string, string>();

  constructor(private readonly api: Api, private readonly options: StreamerOptions) {
    this.rich = options.format !== "html";
  }

  has(sessionID: string): boolean {
    return this.states.has(sessionID);
  }

  elapsedMs(sessionID: string): number | undefined {
    const state = this.states.get(sessionID);
    return state ? Date.now() - state.startedAt : undefined;
  }

  modelOf(sessionID: string): string {
    return sanitizeModelName(this.models.get(sessionID) ?? UNKNOWN_MODEL);
  }

  /** `session.model.selected`: update the live block without restarting it. */
  setModel(sessionID: string, model: string): void {
    const label = sanitizeModelName(model);
    this.models.set(sessionID, label);
    const state = this.states.get(sessionID);
    if (!state || state.model === label) return;
    state.model = label;
    this.schedule(state, STATUS_TICK_MS);
  }

  async begin(sessionID: string, target: Target, model?: string): Promise<void> {
    if (this.states.has(sessionID)) return;
    const state: State = {
      sessionID,
      target,
      text: "",
      tools: [],
      subagents: [],
      messageIds: [],
      awaiting: false,
      model: sanitizeModelName(model || this.models.get(sessionID) || UNKNOWN_MODEL),
      startedAt: Date.now(),
      lastEditAt: 0,
      flushing: false,
      finished: false,
    };
    this.models.set(sessionID, state.model);
    this.states.set(sessionID, state);
    const messageId = await this.send(sessionID, state, this.composeMarkdown(state));
    if (messageId) state.messageIds.push(messageId);
    state.lastEditAt = Date.now();
    state.typing = setInterval(() => {
      void this.api.sendChatAction(target.chatId, "typing").catch(() => undefined);
    }, 5000);
    state.typing.unref?.();
    // Repeating ticker (not a one-shot setTimeout chain): recomputes elapsed
    // strings and forces an edit even when only the number changed. Keeps
    // `🧩 … · 12s` / `🛠 … · 3s` moving after the parent turn ended too.
    state.ticker = setInterval(() => {
      if (state.finished && !state.awaiting) return;
      if (state.flushing) return;
      if (Date.now() - state.lastEditAt < Math.max(STATUS_TICK_MS, this.options.editIntervalMs || STATUS_TICK_MS)) return;
      void this.flush(state.sessionID, state).catch((error) =>
        log.warn("status tick flush failed:", (error as Error).message),
      );
    }, STATUS_TICK_MS);
    state.ticker.unref?.();
  }

  append(sessionID: string, delta: string): void {
    const state = this.states.get(sessionID);
    if (!state || !delta) return;
    state.text += delta;
    this.schedule(state);
  }

  setText(sessionID: string, text: string): void {
    const state = this.states.get(sessionID);
    if (!state || !text) return;
    state.text = text;
    this.schedule(state);
  }

  /** `session.tool.called`: remember the tool for the live status block. */
  toolCalled(sessionID: string, callID: string, name: string, input: unknown): void {
    const state = this.states.get(sessionID);
    if (!state || this.options.showTools === "off") return;
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
  toolFinished(sessionID: string, callID: string, ok: boolean): void {
    const state = this.states.get(sessionID);
    if (!state) return;
    const tool = callID ? state.tools.find((entry) => entry.callID === callID) : undefined;
    if (!tool || tool.state !== "running") return;
    tool.state = ok ? "ok" : "fail";
    tool.finishedAt = Date.now();
    this.schedule(state, STATUS_TICK_MS);
  }

  /** Child session started: shows `🧩 <agent> · 12s` in the parent's live block. */
  subagentStarted(sessionID: string, label: string): void {
    const state = this.states.get(sessionID);
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
    const state = this.states.get(sessionID);
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
   */
  async end(sessionID: string, footer?: string): Promise<void> {
    const state = this.states.get(sessionID);
    if (!state) return;
    state.finished = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.typing) clearInterval(state.typing);

    if (hasActiveSubagents(state)) {
      state.awaiting = true;
      state.footer = footer;
      log.info(`turn ended with active subagents ${sessionID.slice(0, 16)}; keeping live block`);
      await this.flush(sessionID, state, footer).catch((error) =>
        log.warn("subagent tail flush failed:", (error as Error).message),
      );
      return;
    }

    await this.finalize(sessionID, state, footer);
  }

  /** Delivers the final message once and removes the state. */
  private async finalize(sessionID: string, state: State, footer?: string): Promise<void> {
    if (this.states.get(sessionID) !== state) return;
    if (state.finalizeTimer) {
      clearTimeout(state.finalizeTimer);
      state.finalizeTimer = undefined;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.ticker) clearInterval(state.ticker);

    const text = footer ?? state.footer;
    let delivered = false;
    for (let attempt = 0; attempt < 3 && !delivered; attempt += 1) {
      try {
        await this.flush(sessionID, state, text);
        delivered = true;
      } catch (error) {
        const wait = attempt === 0 ? 2000 : attempt === 1 ? 5000 : 10000;
        log.warn(`final delivery failed (attempt ${attempt + 1}): ${(error as Error).message}; retry in ${wait}ms`);
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }

    if (!delivered) {
      // Last resort: send the answer as a brand-new message.
      try {
        const markdown = this.composeMarkdown(state, text);
        if (this.rich) await this.api.sendRichMessage(state.target.chatId, { markdown }, this.threadOptions(state));
        else await this.api.sendMessage(state.target.chatId, markdownToHtml(markdown), { parse_mode: "HTML", ...this.threadOptions(state) });
        log.info(`final delivery recovered as a new message for ${sessionID.slice(0, 16)}`);
      } catch (error) {
        log.error(`final delivery lost for ${sessionID.slice(0, 16)}: ${(error as Error).message}`);
      }
    }
    this.states.delete(sessionID);
  }

  /** Keeps the finished child line visible for the TTL, then finalizes. */
  private scheduleFinalize(state: State): void {
    if (state.finalizeTimer) return;
    state.finalizeTimer = setTimeout(() => {
      state.finalizeTimer = undefined;
      if (hasActiveSubagents(state)) return;
      void this.finalize(state.sessionID, state).catch((error) =>
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
      void this.flush(state.sessionID, state).catch((error) => log.warn("stream flush failed:", (error as Error).message));
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
    const stats = line ? (html ? `<i>${line}</i>` : `_${line}_`) : "";
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

  private async flush(sessionID: string, state: State, footer?: string): Promise<void> {
    // A slow Telegram edit must not swallow the final message: wait for the
    // in-flight flush, then run ours (the `end()` footer would otherwise be
    // dropped while the placeholder stayed on screen forever).
    while (state.flushPromise) await state.flushPromise.catch(() => undefined);
    if (this.states.get(sessionID) !== state) return;
    const run = this.performFlush(sessionID, state, footer);
    state.flushPromise = run;
    try {
      await run;
    } finally {
      if (state.flushPromise === run) state.flushPromise = undefined;
    }
  }

  private async performFlush(sessionID: string, state: State, footer?: string): Promise<void> {
    state.flushing = true;
    try {
      if (this.rich) {
        try {
          await this.flushRich(state, footer);
          state.lastEditAt = Date.now();
          return;
        } catch (error) {
          if (!isRichUnsupported(error)) throw error;
          this.rich = false;
          log.warn("rich messages rejected by Telegram, switching to HTML:", (error as Error).message);
        }
      }
      await this.flushHtml(state, footer);
      state.lastEditAt = Date.now();
      void sessionID;
    } finally {
      state.flushing = false;
    }
  }

  private async flushRich(state: State, footer?: string): Promise<void> {
    const chunks = this.composeChunks(state, footer);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      const messageId = state.messageIds[index];
      if (messageId === undefined) {
        const sent = await this.sendRich(state, chunk);
        if (sent) state.messageIds.push(sent);
        continue;
      }
      await this.editRich(state, messageId, chunk);
    }
  }

  private async flushHtml(state: State, footer?: string): Promise<void> {
    const chunks = this.composeChunks(state, footer, true);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      const messageId = state.messageIds[index];
      if (messageId === undefined) {
        const sent = await this.sendHtml(state, chunk);
        if (sent) state.messageIds.push(sent);
        continue;
      }
      await this.editHtml(state, messageId, chunk);
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
      const message = await this.api.sendRichMessage(state.target.chatId, { markdown }, this.threadOptions(state));
      return message.message_id;
    } catch (error) {
      if (isThreadMissing(error) && state.target.threadId) {
        log.warn(`thread ${state.target.threadId} is gone, posting to the chat root`);
        this.options.onThreadGone?.(state.sessionID);
        state.target.threadId = undefined;
        const message = await this.api.sendRichMessage(state.target.chatId, { markdown });
        return message.message_id;
      }
      throw error;
    }
  }

  private async editRich(state: State, messageId: number, markdown: string): Promise<void> {
    try {
      await this.api.editMessageText(state.target.chatId, messageId, { markdown });
    } catch (error) {
      if (isNotModified(error)) return;
      if (error instanceof GrammyError && error.error_code === 429) {
        // Wait `retry_after`; the next 1.2 s tick repeats the edit.
        await this.handleRetry(error);
        return;
      }
      throw error;
    }
  }

  private async sendHtml(state: State, html: string): Promise<number | undefined> {
    const options = { parse_mode: "HTML" as const, ...this.threadOptions(state) };
    try {
      const message = await this.api.sendMessage(state.target.chatId, html, options);
      return message.message_id;
    } catch (error) {
      if (isThreadMissing(error) && state.target.threadId) {
        log.warn(`thread ${state.target.threadId} is gone, posting to the chat root`);
        this.options.onThreadGone?.(state.sessionID);
        state.target.threadId = undefined;
        const message = await this.api.sendMessage(state.target.chatId, html, { parse_mode: "HTML" });
        return message.message_id;
      }
      if (isParseError(error)) {
        const message = await this.api.sendMessage(state.target.chatId, stripHtml(html), this.threadOptions(state));
        return message.message_id;
      }
      await this.handleRetry(error);
      return undefined;
    }
  }

  private async editHtml(state: State, messageId: number, html: string): Promise<void> {
    try {
      await this.api.editMessageText(state.target.chatId, messageId, html, { parse_mode: "HTML" });
    } catch (error) {
      if (isNotModified(error)) return;
      if (isParseError(error)) {
        await this.api.editMessageText(state.target.chatId, messageId, stripHtml(html)).catch(() => undefined);
        return;
      }
      await this.handleRetry(error);
    }
  }

  private async handleRetry(error: unknown): Promise<void> {
    if (error instanceof GrammyError && error.error_code === 429) {
      const retryAfter = (error.parameters as { retry_after?: number } | undefined)?.retry_after ?? 3;
      log.warn(`Telegram 429, retry after ${retryAfter}s`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return;
    }
    log.warn("telegram request failed:", (error as Error).message);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.states.keys()].map((id) => this.end(id)));
  }
}

/** `42s`, `1m 23s` — same shape as the stats footer. */
export function formatElapsed(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
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
