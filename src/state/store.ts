import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface SessionRecord {
  id: string;
  title: string;
  directory?: string;
  chatId?: number;
  threadId?: number;
}

export interface DiscordSessionRecord {
  chatId?: string;
  threadId?: string;
  title?: string;
}

export interface State {
  /** forum thread id -> session id */
  topics: Record<string, string>;
  /** private chat id -> current session id */
  chats: Record<string, string>;
  sessions: Record<string, SessionRecord>;
  /** Discord thread id -> session id */
  discordThreads: Record<string, string>;
  /** Discord channel id -> session id */
  discordChannels: Record<string, string>;
  discordSessions: Record<string, DiscordSessionRecord>;
}

const emptyState = (): State => ({ topics: {}, chats: {}, sessions: {}, discordThreads: {}, discordChannels: {}, discordSessions: {} });

export class Store {
  private data: State;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly file: string) {
    this.data = emptyState();
    if (!existsSync(file)) return;
    try {
      const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw) as Partial<State>;
      const base = emptyState();
      this.data = {
        ...base,
        ...parsed,
        // Older state.json has no Discord maps: default them to empty objects.
        discordThreads: parsed.discordThreads ?? {},
        discordChannels: parsed.discordChannels ?? {},
        discordSessions: parsed.discordSessions ?? {},
      };
    } catch {
      // Corrupted state must not prevent the bot from starting.
      this.data = emptyState();
    }
  }

  get session(): State["sessions"] {
    return this.data.sessions;
  }

  byThread(threadId: number): string | undefined {
    return this.data.topics[String(threadId)];
  }

  bindThread(threadId: number, sessionID: string): void {
    // One session lives in exactly one topic: drop stale mappings from re-created topics.
    for (const [key, id] of Object.entries(this.data.topics)) {
      if (id === sessionID && key !== String(threadId)) delete this.data.topics[key];
    }
    this.data.topics[String(threadId)] = sessionID;
    this.touch(sessionID);
  }

  unbindThread(threadId: number): void {
    delete this.data.topics[String(threadId)];
    this.save();
  }

  unbindChat(chatId: number): void {
    delete this.data.chats[String(chatId)];
    this.save();
  }

  /** Drops every topic mapping that points at the session. */
  clearThread(sessionID: string): void {
    for (const [key, id] of Object.entries(this.data.topics)) {
      if (id === sessionID) delete this.data.topics[key];
    }
    const record = this.data.sessions[sessionID];
    if (record) {
      delete record.threadId;
      delete record.chatId;
    }
    this.save();
  }

  setTitle(sessionID: string, title: string): void {
    const record = this.data.sessions[sessionID];
    if (record) record.title = title;
    this.save();
  }

  byChat(chatId: number): string | undefined {
    return this.data.chats[String(chatId)];
  }

  bindChat(chatId: number, sessionID: string): void {
    this.data.chats[String(chatId)] = sessionID;
    this.touch(sessionID);
  }

  private touch(sessionID: string): void {
    const rec = this.data.sessions[sessionID];
    if (rec) rec.id = sessionID;
    this.save();
  }

  upsert(record: SessionRecord): void {
    this.data.sessions[record.id] = { ...this.data.sessions[record.id], ...record };
    this.save();
  }

  locate(sessionID: string): { chatId?: number; threadId?: number } {
    // Live bindings win over stale records.
    for (const [threadId, id] of Object.entries(this.data.topics)) {
      if (id === sessionID) return { threadId: Number(threadId) };
    }
    for (const [chatId, id] of Object.entries(this.data.chats)) {
      if (id === sessionID) return { chatId: Number(chatId) };
    }
    const rec = this.data.sessions[sessionID];
    if (rec?.chatId) return { chatId: rec.chatId, threadId: rec.threadId };
    return {};
  }

  // --------------------------------------------------------------- discord

  byDiscordThread(threadId: string): string | undefined {
    return this.data.discordThreads[threadId];
  }

  byDiscordChannel(channelId: string): string | undefined {
    return this.data.discordChannels[channelId];
  }

  bindDiscordThread(threadId: string, sessionID: string, chatId?: string): void {
    // One session lives in exactly one Discord thread.
    for (const [key, id] of Object.entries(this.data.discordThreads)) {
      if (id === sessionID && key !== threadId) delete this.data.discordThreads[key];
    }
    for (const [key, id] of Object.entries(this.data.discordChannels)) {
      if (id === sessionID) delete this.data.discordChannels[key];
    }
    this.data.discordThreads[threadId] = sessionID;
    this.data.discordSessions[sessionID] = {
      ...this.data.discordSessions[sessionID],
      threadId,
      ...(chatId ? { chatId } : {}),
    };
    this.save();
  }

  bindDiscordChannel(channelId: string, sessionID: string): void {
    for (const [key, id] of Object.entries(this.data.discordChannels)) {
      if (id === sessionID && key !== channelId) delete this.data.discordChannels[key];
    }
    for (const [key, id] of Object.entries(this.data.discordThreads)) {
      if (id === sessionID) delete this.data.discordThreads[key];
    }
    this.data.discordChannels[channelId] = sessionID;
    this.data.discordSessions[sessionID] = { ...this.data.discordSessions[sessionID], chatId: channelId };
    this.save();
  }

  unbindDiscordThread(threadId: string): void {
    delete this.data.discordThreads[threadId];
    this.save();
  }

  unbindDiscordChannel(channelId: string): void {
    delete this.data.discordChannels[channelId];
    this.save();
  }

  clearDiscord(sessionID: string): void {
    for (const [key, id] of Object.entries(this.data.discordThreads)) {
      if (id === sessionID) delete this.data.discordThreads[key];
    }
    for (const [key, id] of Object.entries(this.data.discordChannels)) {
      if (id === sessionID) delete this.data.discordChannels[key];
    }
    delete this.data.discordSessions[sessionID];
    this.save();
  }

  setDiscordTitle(sessionID: string, title: string): void {
    const record = this.data.discordSessions[sessionID];
    if (record) record.title = title;
    this.save();
  }

  locateDiscord(sessionID: string): { chatId?: string; threadId?: string } {
    for (const [threadId, id] of Object.entries(this.data.discordThreads)) {
      if (id === sessionID) return { threadId, chatId: this.data.discordSessions[sessionID]?.chatId };
    }
    for (const [channelId, id] of Object.entries(this.data.discordChannels)) {
      if (id === sessionID) return { chatId: channelId };
    }
    const rec = this.data.discordSessions[sessionID];
    if (rec) return { chatId: rec.chatId, threadId: rec.threadId };
    return {};
  }

  save(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
      } catch {
        /* state persistence is best-effort */
      }
    }, 150);
    this.timer.unref?.();
  }
}
