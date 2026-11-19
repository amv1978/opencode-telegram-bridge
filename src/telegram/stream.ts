import { GrammyError, type Api } from "grammy";
import { log } from "../log.ts";
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

interface State {
  sessionID: string;
  target: Target;
  text: string;
  tools: ToolState[];
  messageIds: number[];
  timer?: ReturnType<typeof setTimeout>;
  typing?: ReturnType<typeof setInterval>;
  spinner?: ReturnType<typeof setInterval>;
  frame: number;
  model: string;
  startedAt: number;
  lastEditAt: number;
  flushing: boolean;
  finished: boolean;
}

const PLACEHOLDER = "⏳ Думаю…";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Finished tool lines fade out of the status block after this long. */
const TOOL_TTL_MS = 10_000;
const STATUS_TICK_MS = 1200;
const MAX_STATUS_TOOLS = 2;

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
    return this.models.get(sessionID) ?? "OpenCode";
  }

  async begin(sessionID: string, target: Target, model?: string): Promise<void> {
    if (this.states.has(sessionID)) return;
    const state: State = {
      sessionID,
      target,
      text: "",
      tools: [],
      messageIds: [],
      frame: 0,
      model: model || this.models.get(sessionID) || "OpenCode",
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
    // Animate the status line only while the turn is running.
    state.spinner = setInterval(() => {
      if (state.finished) return;
      state.frame = (state.frame + 1) % SPINNER.length;
      this.schedule(state, STATUS_TICK_MS);
    }, STATUS_TICK_MS);
    state.spinner.unref?.();
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

  async end(sessionID: string, footer?: string): Promise<void> {
    const state = this.states.get(sessionID);
    if (!state) return;
    state.finished = true;
    if (state.timer) clearTimeout(state.timer);
    if (state.typing) clearInterval(state.typing);
    if (state.spinner) clearInterval(state.spinner);

    let delivered = false;
    for (let attempt = 0; attempt < 3 && !delivered; attempt += 1) {
      try {
        await this.flush(sessionID, state, footer);
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
        const text = this.composeMarkdown(state, footer);
        if (this.rich) await this.api.sendRichMessage(state.target.chatId, { markdown: text }, this.threadOptions(state));
        else await this.api.sendMessage(state.target.chatId, markdownToHtml(text), { parse_mode: "HTML", ...this.threadOptions(state) });
        log.info(`final delivery recovered as a new message for ${sessionID.slice(0, 16)}`);
      } catch (error) {
        log.error(`final delivery lost for ${sessionID.slice(0, 16)}: ${(error as Error).message}`);
      }
    }
    this.states.delete(sessionID);
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

  private composeMarkdown(state: State, footer?: string): string {
    const parts: string[] = [];
    const status = state.finished ? "" : this.statusBlock(state);
    if (status) parts.push(status);
    if (state.text.trim()) parts.push(state.text.trim());
    if (footer) parts.push(`_${footer}_`);
    return parts.join("\n\n") || PLACEHOLDER;
  }

  private composeHtml(state: State, footer?: string): string {
    const parts: string[] = [];
    const status = state.finished ? "" : this.statusBlock(state);
    if (status) parts.push(status);
    if (state.text.trim()) parts.push(markdownToHtml(state.text));
    if (footer) parts.push(`<i>${footer}</i>`);
    return parts.join("\n\n") || PLACEHOLDER;
  }

  /** Variant B status block: model + elapsed, up to two recent tools. */
  private statusBlock(state: State): string {
    const frame = SPINNER[state.frame % SPINNER.length] ?? "⠋";
    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const lines = [`${frame} ${state.model} · thinking… ${elapsed}`];
    if (this.options.showTools !== "off") {
      const now = Date.now();
      const visible = state.tools
        .filter((tool) => tool.state === "running" || !tool.finishedAt || now - tool.finishedAt <= TOOL_TTL_MS)
        .slice(-MAX_STATUS_TOOLS);
      for (const tool of visible) {
        const mark = tool.state === "ok" ? " ✓" : tool.state === "fail" ? " ✗" : "";
        const count = tool.count > 1 ? ` ×${tool.count}` : "";
        const duration = formatElapsed((tool.finishedAt ?? now) - tool.startedAt);
        lines.push(`${tool.icon} ${tool.label}${count} · ${duration}${mark}`);
      }
    }
    return lines.join("\n");
  }

  private async flush(sessionID: string, state: State, footer?: string): Promise<void> {
    if (state.flushing) return;
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
    const chunks = splitMarkdown(this.composeMarkdown(state, footer));
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
    const chunks = splitHtml(this.composeHtml(state, footer));
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
