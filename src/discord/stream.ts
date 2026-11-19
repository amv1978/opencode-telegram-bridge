import type { Client, Message, MessageCreateOptions } from "discord.js";
import { log } from "../log.ts";
import { chunkText, formatDuration, toDiscordMarkdown } from "./render.ts";

const PLACEHOLDER = "⏳ Думаю…";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Finished tool lines fade out of the status block after this long. */
const TOOL_TTL_MS = 10_000;
const MAX_STATUS_TOOLS = 2;
const MAX_STATUS_SUBAGENTS = 2;

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
}

interface State {
  sessionID: string;
  channelId: string;
  text: string;
  tools: ToolState[];
  subagents: SubagentState[];
  messageIds: Array<string | undefined>;
  rendered: Array<string | undefined>;
  timer?: ReturnType<typeof setTimeout>;
  statusTimer?: ReturnType<typeof setInterval>;
  frame: number;
  model: string;
  startedAt: number;
  lastEditAt: number;
  finished: boolean;
}

/**
 * Discord equivalent of the Telegram Streamer: one placeholder message that is
 * edited at most every `editIntervalMs`, plus extra messages for chunks beyond
 * the 2000-char limit. While a turn runs the message starts with a live status
 * block (spinner + model + the last tools).
 */
export class DiscordStreamer {
  private readonly states = new Map<string, State>();
  private readonly models = new Map<string, string>();

  constructor(
    private readonly client: Client,
    private readonly options: DiscordStreamOptions,
  ) {}

  has(sessionID: string): boolean {
    return this.states.has(sessionID);
  }

  elapsedMs(sessionID: string): number | undefined {
    const state = this.states.get(sessionID);
    return state ? Date.now() - state.startedAt : undefined;
  }

  /** Model display name currently used by a session's live block. */
  modelOf(sessionID: string): string {
    return this.models.get(sessionID) ?? "OpenCode";
  }

  async begin(sessionID: string, channelId: string, model?: string): Promise<void> {
    if (this.states.has(sessionID)) return;
    const channel = await this.resolve(channelId);
    if (!channel) {
      log.warn(`discord: channel ${channelId} not found, stream not started`);
      return;
    }
    const state: State = {
      sessionID,
      channelId,
      text: "",
      tools: [],
      subagents: [],
      messageIds: [],
      rendered: [],
      frame: 0,
      model: model || this.models.get(sessionID) || "OpenCode",
      startedAt: Date.now(),
      lastEditAt: 0,
      finished: false,
    };
    this.models.set(sessionID, state.model);
    this.states.set(sessionID, state);
    const message = await channel.send({ content: PLACEHOLDER, allowedMentions: { parse: [] } });
    state.messageIds.push(message.id);
    state.rendered.push(PLACEHOLDER);
    state.lastEditAt = Date.now();
    // Refresh elapsed time / hide stale tools at the same cadence as edits.
    const tick = Math.max(2500, this.options.editIntervalMs || 2500);
    state.statusTimer = setInterval(() => {
      if (state.finished) return;
      this.schedule(state);
    }, tick);
    state.statusTimer.unref?.();
  }

  setModel(sessionID: string, model: string): void {
    const state = this.states.get(sessionID);
    if (!state || !model || state.model === model) return;
    state.model = model;
    this.models.set(sessionID, model);
    this.schedule(state);
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
    this.schedule(state);
  }

  /** `session.tool.success` / `session.tool.failed`. */
  toolFinished(sessionID: string, callID: string, ok: boolean): void {
    const state = this.states.get(sessionID);
    if (!state) return;
    const tool = callID ? state.tools.find((entry) => entry.callID === callID) : undefined;
    if (!tool || tool.state !== "running") return;
    tool.state = ok ? "ok" : "fail";
    tool.finishedAt = Date.now();
    this.schedule(state);
  }

  /** Child session started: `🧩 <agent> · 12s` in the parent's live block. */
  subagentStarted(sessionID: string, label: string): void {
    const state = this.states.get(sessionID);
    if (!state) return;
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
    this.schedule(state);
  }

  /** Child session finished: `✓` / `✗`, fades out after ~10 s. */
  subagentFinished(sessionID: string, label: string, ok: boolean): void {
    const state = this.states.get(sessionID);
    if (!state) return;
    const entry = state.subagents.find((item) => item.label === (label || "subagent") && item.state === "running");
    if (!entry) return;
    entry.state = ok ? "ok" : "fail";
    entry.finishedAt = Date.now();
    this.schedule(state);
  }

  async end(sessionID: string, footer?: string): Promise<void> {
    const state = this.states.get(sessionID);
    if (!state) return;
    state.finished = true;
    if (state.timer) clearTimeout(state.timer);
    if (state.statusTimer) clearInterval(state.statusTimer);
    this.states.delete(sessionID);

    let delivered = false;
    for (let attempt = 0; attempt < 3 && !delivered; attempt += 1) {
      try {
        await this.flush(state, footer);
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
        const chunks = chunkText(this.compose(state, footer));
        if (channel) {
          for (const chunk of chunks) {
            await channel.send({ content: chunk, allowedMentions: { parse: [] } });
          }
          log.info(`discord final delivery recovered as a new message for ${sessionID.slice(0, 16)}`);
        }
      } catch (error) {
        log.error(`discord final delivery lost for ${sessionID.slice(0, 16)}: ${(error as Error).message}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.states.keys()].map((id) => this.end(id)));
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

  private compose(state: State, footer?: string): string {
    const parts: string[] = [];
    const status = state.finished ? "" : this.statusBlock(state);
    if (status) parts.push(status);
    const body = state.text.trim();
    if (body) parts.push(toDiscordMarkdown(body));
    if (footer) parts.push(footer);
    return parts.join("\n\n") || PLACEHOLDER;
  }

  /** Spinner + model + two recent tools + two subagents, like Telegram. */
  private statusBlock(state: State): string {
    const frame = SPINNER[state.frame % SPINNER.length] ?? "⠋";
    const elapsed = formatDuration(Date.now() - state.startedAt);
    const lines = [`${frame} ${state.model} · thinking… ${elapsed}`];
    if (this.options.showTools !== "off") {
      const now = Date.now();
      const visible = state.tools
        .filter((tool) => tool.state === "running" || !tool.finishedAt || now - tool.finishedAt <= TOOL_TTL_MS)
        .slice(-MAX_STATUS_TOOLS);
      for (const tool of visible) {
        const mark = tool.state === "ok" ? " ✓" : tool.state === "fail" ? " ✗" : "";
        const count = tool.count > 1 ? ` ×${tool.count}` : "";
        const duration = formatDuration((tool.finishedAt ?? now) - tool.startedAt);
        lines.push(`${tool.icon} ${tool.label}${count} · ${duration}${mark}`);
      }
    }
    const now = Date.now();
    const subagents = state.subagents
      .filter((entry) => entry.state === "running" || !entry.finishedAt || now - entry.finishedAt <= TOOL_TTL_MS)
      .slice(-MAX_STATUS_SUBAGENTS);
    for (const sub of subagents) {
      const mark = sub.state === "ok" ? " ✓" : sub.state === "fail" ? " ✗" : "";
      const count = sub.count > 1 ? ` ×${sub.count}` : "";
      lines.push(`🧩 ${sub.label}${count} · ${formatSubagentElapsed((sub.finishedAt ?? now) - sub.startedAt)}${mark}`);
    }
    return lines.join("\n");
  }

  private async flush(state: State, footer?: string): Promise<void> {
    if (!state.finished) state.frame = (state.frame + 1) % SPINNER.length;
    const channel = await this.resolve(state.channelId);
    if (!channel) {
      this.options.onGone?.(state.sessionID);
      return;
    }
    const chunks = chunkText(this.compose(state, footer));
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      if (!chunk) continue;
      const messageId = state.messageIds[index];
      if (!messageId) {
        const message = await channel.send({ content: chunk, allowedMentions: { parse: [] } });
        state.messageIds[index] = message.id;
        state.rendered[index] = chunk;
        continue;
      }
      if (state.rendered[index] === chunk) continue;
      try {
        const message = await channel.messages.fetch(messageId);
        await message.edit({ content: chunk, allowedMentions: { parse: [] } });
        state.rendered[index] = chunk;
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (code === 10008 || code === 10003) {
          // Message or channel was deleted mid-stream: send this chunk afresh.
          state.messageIds[index] = undefined;
          state.rendered[index] = undefined;
          const message = await channel.send({ content: chunk, allowedMentions: { parse: [] } });
          state.messageIds[index] = message.id;
          state.rendered[index] = chunk;
          continue;
        }
        throw error;
      }
    }
    state.lastEditAt = Date.now();
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
