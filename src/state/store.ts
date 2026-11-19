import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface SessionRecord {
  id: string;
  title: string;
  directory?: string;
  chatId?: number;
  threadId?: number;
}

export interface State {
  /** forum thread id -> session id */
  topics: Record<string, string>;
  /** private chat id -> current session id */
  chats: Record<string, string>;
  sessions: Record<string, SessionRecord>;
}

const EMPTY: State = { topics: {}, chats: {}, sessions: {} };

export class Store {
  private data: State;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly file: string) {
    this.data = { ...EMPTY };
    if (!existsSync(file)) return;
    try {
      const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      this.data = { ...EMPTY, ...(JSON.parse(raw) as Partial<State>) };
    } catch {
      // Corrupted state must not prevent the bot from starting.
      this.data = { ...EMPTY };
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
