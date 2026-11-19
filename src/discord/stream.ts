import type { Client, Message, MessageCreateOptions } from "discord.js";
import { log } from "../log.ts";
import { chunkText } from "./render.ts";

const PLACEHOLDER = "⏳ Думаю…";

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
  editIntervalMs: number;
  showTools: "off" | "compact" | "full";
  /** Called when the bound thread/channel no longer exists. */
  onGone?: (sessionID: string) => void;
}

interface State {
  sessionID: string;
  channelId: string;
  text: string;
  tools: string[];
  messageIds: Array<string | undefined>;
  rendered: Array<string | undefined>;
  timer?: ReturnType<typeof setTimeout>;
  startedAt: number;
  lastEditAt: number;
  finished: boolean;
}

/**
 * Discord equivalent of the Telegram Streamer: one placeholder message that is
 * edited at most every `editIntervalMs`, plus extra messages for chunks beyond
 * the 2000-char limit.
 */
export class DiscordStreamer {
  private readonly states = new Map<string, State>();

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

  async begin(sessionID: string, channelId: string): Promise<void> {
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
      messageIds: [],
      rendered: [],
      startedAt: Date.now(),
      lastEditAt: 0,
      finished: false,
    };
    this.states.set(sessionID, state);
    const message = await channel.send({ content: PLACEHOLDER, allowedMentions: { parse: [] } });
    state.messageIds.push(message.id);
    state.rendered.push(PLACEHOLDER);
    state.lastEditAt = Date.now();
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

  tool(sessionID: string, label: string): void {
    const state = this.states.get(sessionID);
    if (!state || this.options.showTools === "off") return;
    if (state.tools[state.tools.length - 1] === label) return;
    state.tools.push(label);
    if (state.tools.length > 6) state.tools.shift();
    this.schedule(state);
  }

  async end(sessionID: string, footer?: string): Promise<void> {
    const state = this.states.get(sessionID);
    if (!state) return;
    state.finished = true;
    if (state.timer) clearTimeout(state.timer);
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
    if (state.tools.length && this.options.showTools !== "off") parts.push(`*${state.tools.join(" · ")}*`);
    if (state.text.trim()) parts.push(state.text.trim());
    if (footer) parts.push(footer.split("\n").map((line) => `*${line}*`).join("\n"));
    return parts.join("\n\n") || PLACEHOLDER;
  }

  private async flush(state: State, footer?: string): Promise<void> {
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
    const cached = this.client.channels.cache.get(channelId);
    const channel = cached ?? (await this.client.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isTextBased()) return undefined;
    const candidate = channel as unknown as Partial<SendableChannel>;
    if (typeof candidate.send !== "function" || !candidate.messages) return undefined;
    return candidate as SendableChannel;
  }
}
