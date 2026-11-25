import { atomicWrite, readJsonFile } from "../atomic.ts";

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
  /** Last GitHub update check (cache for the UI and 6 h timer). */
  update?: Record<string, unknown>;
  /** Version replaced by the last successful bundle update ({app}\prev). */
  prevVersion?: string;
  /** Cost spent today (UTC) for the budget tracker, survives restarts. */
  budget?: { day: string; spentUsd: number };
  /**
   * `/observe`: target key (`tg:<chatId>:<threadId|0>` / `dc:<channelId>`) →
   * sessions mirrored into that chat. An empty array means "enabled, nothing
   * running yet".
   */
  observe?: Record<string, string[]>;
  /** Panel-only preferences: sessions hidden from "Current sessions". */
  ui?: { hiddenSessions?: string[] };
}

const emptyState = (): State => ({
  topics: {},
  chats: {},
  sessions: {},
  discordThreads: {},
  discordChannels: {},
  discordSessions: {},
  observe: {},
  ui: { hiddenSessions: [] },
});

export class Store {
  private data: State;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly file: string) {
    this.data = emptyState();
    const parsed = readJsonFile(file) as Partial<State> | undefined;
    if (!parsed || typeof parsed !== "object") return;
    const base = emptyState();
    this.data = {
      ...base,
      ...parsed,
      // Older state.json has no Discord maps: default them to empty objects.
      discordThreads: parsed.discordThreads ?? {},
      discordChannels: parsed.discordChannels ?? {},
      discordSessions: parsed.discordSessions ?? {},
      observe: normalizeObserve(parsed.observe),
      ui: { hiddenSessions: normalizeIdList(parsed.ui?.hiddenSessions) },
    };
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
    const record = this.data.discordSessions[sessionID] ?? (this.data.discordSessions[sessionID] = {});
    record.title = title;
    this.save();
  }

  updateCache(): Record<string, unknown> | undefined {
    return this.data.update;
  }

  setUpdateCache(cache: Record<string, unknown>): void {
    this.data.update = cache;
    this.save();
  }

  /** Remembers which version sits in `{app}\prev` across the restart. */
  setPrevVersion(version: string | undefined): void {
    if (version) this.data.prevVersion = version;
    else delete this.data.prevVersion;
    this.saveNow();
  }

  getPrevVersion(): string | undefined {
    return this.data.prevVersion;
  }

  budgetState(): { day: string; spentUsd: number } | undefined {
    return this.data.budget;
  }

  setBudgetState(value: { day: string; spentUsd: number } | undefined): void {
    if (value) this.data.budget = value;
    else delete this.data.budget;
    this.save();
  }

  // --------------------------------------------------------------- observe

  /** Every enabled target, including ones with no active session yet. */
  observeKeys(): string[] {
    return Object.keys(this.data.observe ?? {});
  }

  observeEnabled(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.observe ?? {}, key);
  }

  observeFor(key: string): string[] {
    return [...(this.data.observe?.[key] ?? [])];
  }

  observeEnable(key: string): void {
    this.data.observe ??= {};
    this.data.observe[key] ??= [];
    this.save();
  }

  observeAdd(key: string, sessionID: string): void {
    this.data.observe ??= {};
    const current = this.data.observe[key] ?? [];
    if (!current.includes(sessionID)) current.push(sessionID);
    this.data.observe[key] = current;
    this.save();
  }

  /** Removes the session from every target; enabled flags stay in place. */
  observeRemove(sessionID: string): void {
    const observe = this.data.observe;
    if (!observe) return;
    let changed = false;
    for (const [key, sessions] of Object.entries(observe)) {
      const next = sessions.filter((id) => id !== sessionID);
      if (next.length !== sessions.length) {
        observe[key] = next;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  observeClear(key: string): void {
    if (this.data.observe && key in this.data.observe) {
      delete this.data.observe[key];
      this.save();
    }
  }

  // ------------------------------------------------------------- panel state

  /** Sessions hidden in the panel only; nothing is deleted in OpenCode. */
  hiddenSessions(): string[] {
    return [...(this.data.ui?.hiddenSessions ?? [])];
  }

  isSessionHidden(sessionID: string): boolean {
    return (this.data.ui?.hiddenSessions ?? []).includes(sessionID);
  }

  hideSession(sessionID: string): void {
    const id = String(sessionID ?? "").trim();
    if (!id) return;
    this.data.ui ??= { hiddenSessions: [] };
    const hidden = this.data.ui.hiddenSessions ?? [];
    if (hidden.includes(id)) return;
    this.data.ui.hiddenSessions = [...hidden, id];
    this.saveNow();
  }

  showSession(sessionID: string): void {
    const id = String(sessionID ?? "").trim();
    if (!id) return;
    const hidden = this.data.ui?.hiddenSessions ?? [];
    if (!hidden.includes(id)) return;
    this.data.ui = { ...(this.data.ui ?? {}), hiddenSessions: hidden.filter((item) => item !== id) };
    this.saveNow();
  }

  /** Flush immediately: the process is about to be replaced by the updater. */
  saveNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      atomicWrite(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      /* state persistence is best-effort */
    }
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
        atomicWrite(this.file, JSON.stringify(this.data, null, 2));
      } catch {
        /* state persistence is best-effort */
      }
    }, 150);
    this.timer.unref?.();
  }
}

/** Tolerates old/hand-edited state: strings, arrays, junk entries. */
function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function normalizeObserve(value: unknown): Record<string, string[]> {  if (!value || typeof value !== "object") return {};
  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.trim()) {
      result[key] = [entry.trim()];
      continue;
    }
    if (!Array.isArray(entry)) continue;
    result[key] = [...new Set(entry.map((item) => String(item).trim()).filter(Boolean))];
  }
  return result;
}
