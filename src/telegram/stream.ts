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

interface State {
  sessionID: string;
  target: Target;
  text: string;
  tools: string[];
  messageIds: number[];
  timer?: ReturnType<typeof setTimeout>;
  typing?: ReturnType<typeof setInterval>;
  startedAt: number;
  lastEditAt: number;
  finished: boolean;
}

const PLACEHOLDER = "⏳ Думаю…";

export class Streamer {
  private readonly states = new Map<string, State>();
  /** Flipped to false permanently once Telegram rejects a rich message. */
  private rich: boolean;

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

  async begin(sessionID: string, target: Target): Promise<void> {
    if (this.states.has(sessionID)) return;
    const state: State = {
      sessionID,
      target,
      text: "",
      tools: [],
      messageIds: [],
      startedAt: Date.now(),
      lastEditAt: 0,
      finished: false,
    };
    this.states.set(sessionID, state);
    const messageId = await this.send(sessionID, state, PLACEHOLDER);
    if (messageId) state.messageIds.push(messageId);
    state.typing = setInterval(() => {
      void this.api.sendChatAction(target.chatId, "typing").catch(() => undefined);
    }, 5000);
    state.typing.unref?.();
  }

  append(sessionID: string, delta: string): void {
    const state = this.states.get(sessionID);
    if (!state || !delta) return;
    state.text += delta;
    this.schedule(sessionID, state);
  }

  setText(sessionID: string, text: string): void {
    const state = this.states.get(sessionID);
    if (!state || !text) return;
    state.text = text;
    this.schedule(sessionID, state);
  }

  tool(sessionID: string, label: string): void {
    const state = this.states.get(sessionID);
    if (!state || this.options.showTools === "off") return;
    if (state.tools[state.tools.length - 1] === label) return;
    state.tools.push(label);
    if (state.tools.length > 6) state.tools.shift();
    this.schedule(sessionID, state);
  }

  async end(sessionID: string, footer?: string): Promise<void> {
    const state = this.states.get(sessionID);
    if (!state) return;
    state.finished = true;
    if (state.timer) clearTimeout(state.timer);
    if (state.typing) clearInterval(state.typing);

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

  private schedule(sessionID: string, state: State): void {
    if (state.timer) return;
    const wait = Math.max(0, this.options.editIntervalMs - (Date.now() - state.lastEditAt));
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.flush(sessionID, state).catch((error) => log.warn("stream flush failed:", (error as Error).message));
    }, wait);
    state.timer.unref?.();
  }

  private composeMarkdown(state: State, footer?: string): string {
    const parts: string[] = [];
    if (state.tools.length && this.options.showTools !== "off") parts.push(`_${state.tools.join(" · ")}_`);
    if (state.text.trim()) parts.push(state.text.trim());
    if (footer) parts.push(footer.split("\n").map((line) => `_${line}_`).join("\n"));
    return parts.join("\n\n") || PLACEHOLDER;
  }

  private composeHtml(state: State, footer?: string): string {
    const parts: string[] = [];
    if (state.tools.length && this.options.showTools !== "off") parts.push(`<i>${state.tools.join(" · ")}</i>`);
    if (state.text.trim()) parts.push(markdownToHtml(state.text));
    if (footer) parts.push(footer.split("\n").map((line) => `<i>${line}</i>`).join("\n"));
    return parts.join("\n\n") || PLACEHOLDER;
  }

  private async flush(sessionID: string, state: State, footer?: string): Promise<void> {
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
