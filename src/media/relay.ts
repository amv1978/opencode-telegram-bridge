import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { MediaConfig } from "../config.ts";
import { log } from "../log.ts";
import type { OcClient } from "../opencode/client.ts";
import type { Store } from "../state/store.ts";

export type MediaOrigin = "telegram" | "discord" | "agent";
export type MediaRelayMode = "none" | "user" | "all";

/** One relayable object: bytes, a remote/data URI, or a local absolute path. */
export interface MediaItem {
  buffer?: Buffer;
  uri?: string;
  mime?: string;
  name: string;
}

export type TelegramMediaTarget = { platform: "telegram"; chatId: number; threadId?: number };
export type DiscordMediaTarget = { platform: "discord"; channelId: string };
export type RelayTarget = TelegramMediaTarget | DiscordMediaTarget;

export interface MediaSendLimits {
  maxPhotoMb: number;
}

export interface MediaSenders {
  telegram?: {
    send(target: TelegramMediaTarget, item: MediaItem, limits: MediaSendLimits): Promise<void>;
    sendText(target: TelegramMediaTarget, text: string): Promise<void>;
  };
  discord?: {
    send(target: DiscordMediaTarget, item: MediaItem, limits: MediaSendLimits): Promise<void>;
    sendText(target: DiscordMediaTarget, text: string): Promise<void>;
  };
}

export interface MediaRelayOptions {
  store: Store;
  media: () => MediaConfig;
  topicsChatId: () => number | undefined;
  senders: MediaSenders;
}

/**
 * Prompt payload for `oc.prompt`: every entry is `{ uri: "data:<mime>;base64,…", name }`.
 * This is the single conversion point so buffers/names can never reach the API.
 */
export function promptFilesFromMedia(items: MediaItem[]): Array<{ uri: string; name: string }> {
  return items.flatMap((item) => {
    const name = item.name || `file-${Date.now()}`;
    if (typeof item.uri === "string" && item.uri.trim()) return [{ uri: item.uri.trim(), name }];
    if (item.buffer?.length) {
      const mime = item.mime || "application/octet-stream";
      return [{ uri: `data:${mime};base64,${item.buffer.toString("base64")}`, name }];
    }
    return [];
  });
}

const MB = 1024 * 1024;const TELEGRAM_DOCUMENT_MB = 50;
const TELEGRAM_PHOTO_MB = 10;
const DISCORD_MB = 10;
const DEDUPE_TTL_MS = 10 * 60 * 1000;

/**
 * Relays media between every chat a session is bound to (Telegram topic/chat
 * and Discord thread/channel), skipping the origin platform. Never throws into
 * the event loop: every failure is logged and the loop continues.
 */
export class MediaRelay {
  private readonly sent = new Map<string, number>();

  constructor(private readonly options: MediaRelayOptions) {}

  relay(sessionID: string, items: MediaItem[], origin: MediaOrigin): void {
    void this.run(sessionID, items, origin).catch((error) =>
      log.warn("media relay failed:", (error as Error).message),
    );
  }

  private async run(sessionID: string, items: MediaItem[], origin: MediaOrigin): Promise<void> {
    const mode = this.options.media().relay ?? "all";
    if (mode === "none") return;
    if (mode === "user" && origin === "agent") return;
    if (!items.length) return;

    const targets = listTargets(this.options.store, sessionID, this.options.topicsChatId());
    const allowed = targets.filter((target) => target.platform !== origin);
    if (!allowed.length) return;

    let index = 0;
    for (const raw of items) {
      index += 1;
      const item = await this.prepare(raw);
      if (!item) continue;
      const key = `${sessionID}:${itemKey(item)}`;
      if (this.recentlySent(key)) {
        log.info(`media relay: skip duplicate ${item.name}`);
        continue;
      }
      this.sent.set(key, Date.now());
      for (const target of allowed) {
        try {
          await this.deliver(target, item);
        } catch (error) {
          log.warn(`media relay → ${target.platform} failed (${item.name}):`, (error as Error).message);
        }
      }
      if (index >= 20) break; // sanity cap per event
    }
    this.prune();
  }

  /** Resolves bytes for buffers, data URLs, http(s) URLs and local paths. */
  private async prepare(raw: MediaItem): Promise<MediaItem | undefined> {
    if (raw.buffer?.length) return raw;
    const uri = raw.uri?.trim();
    if (!uri) return undefined;

    if (/^data:/i.test(uri)) {
      const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(uri);
      if (!match) return { ...raw, uri };
      const mime = match[1] || raw.mime || "application/octet-stream";
      const buffer = match[2] ? Buffer.from(match[3] ?? "", "base64") : Buffer.from(decodeURIComponent(match[3] ?? ""));
      return { buffer, mime, uri, name: raw.name || nameFor(mime, undefined) };
    }

    if (/^https?:\/\//i.test(uri)) {
      try {
        const response = await fetch(uri, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) return { ...raw, uri };
        const buffer = Buffer.from(await response.arrayBuffer());
        const mime = response.headers.get("content-type")?.split(";")[0] || raw.mime;
        return { buffer, mime, uri, name: raw.name || nameFor(mime, uri) };
      } catch (error) {
        log.warn(`media relay: fetch failed ${uri.slice(0, 120)}:`, (error as Error).message);
        return { ...raw, uri };
      }
    }

    const path = localPath(uri);
    try {
      if (existsSync(path)) {
        const buffer = readFileSync(path);
        return { buffer, mime: raw.mime || mimeFor(path), uri, name: raw.name || basename(path) };
      }
    } catch (error) {
      log.warn(`media relay: read failed ${path}:`, (error as Error).message);
    }
    return { ...raw, uri: path };
  }

  private async deliver(target: RelayTarget, item: MediaItem, depth = 0): Promise<void> {
    const maxPhotoMb = this.options.media().maxPhotoMb ?? TELEGRAM_PHOTO_MB;
    const size = item.buffer?.length ?? 0;
    const limitMb = target.platform === "telegram" ? TELEGRAM_DOCUMENT_MB : DISCORD_MB;

    if (size > 0 && size <= limitMb * MB) {
      const limits = { maxPhotoMb: Math.min(maxPhotoMb, TELEGRAM_PHOTO_MB) };
      if (target.platform === "telegram") await this.options.senders.telegram?.send(target, item, limits);
      else await this.options.senders.discord?.send(target, item, limits);
      log.info(`media relay: ${item.name} (${Math.round(size / 1024)} KB) → ${target.platform}`);
      return;
    }

    // Oversize or no bytes locally: send a link/absolute path instead.
    const link = linkFor(item);
    if (!link) return;
    const text = `📎 ${item.name}: ${link}`;
    if (target.platform === "telegram") await this.options.senders.telegram?.sendText(target, text);
    else await this.options.senders.discord?.sendText(target, text);
    log.info(`media relay: ${item.name} too big (${Math.round(size / MB)} MB) → link to ${target.platform}`);
    void depth;
  }

  private recentlySent(key: string): boolean {
    const at = this.sent.get(key);
    if (!at) return false;
    if (Date.now() - at > DEDUPE_TTL_MS) {
      this.sent.delete(key);
      return false;
    }
    return true;
  }

  private prune(): void {
    const cutoff = Date.now() - DEDUPE_TTL_MS;
    for (const [key, at] of this.sent) if (at < cutoff) this.sent.delete(key);
  }
}

/** Every Telegram chat/topic and Discord thread/channel bound to the session. */
export function listTargets(store: Store, sessionID: string, topicsChatId?: number): RelayTarget[] {
  const targets: RelayTarget[] = [];
  const seen = new Set<string>();
  const add = (target: RelayTarget) => {
    const key =
      target.platform === "telegram"
        ? `tg:${target.chatId}:${target.threadId ?? ""}`
        : `dc:${target.channelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  const telegram = store.locate(sessionID);
  if (telegram.chatId) add({ platform: "telegram", chatId: telegram.chatId, threadId: telegram.threadId });
  else if (telegram.threadId && topicsChatId) {
    add({ platform: "telegram", chatId: topicsChatId, threadId: telegram.threadId });
  }

  const discord = store.locateDiscord(sessionID);
  const channelId = discord.threadId ?? discord.chatId;
  if (channelId) add({ platform: "discord", channelId });

  return targets;
}

/**
 * Files attached to the newest assistant messages: `content[]` parts of type
 * `file` and `tool` parts whose `state.content[]` contains file entries.
 * Observed OpenCode 2.3.2 shape: `{ type: "file", uri: "data:<mime>;base64,…" }`.
 */
export async function collectAgentFiles(oc: OcClient, sessionID: string): Promise<MediaItem[]> {
  let messages;
  try {
    messages = await oc.messages(sessionID, { limit: 5, order: "desc" });
  } catch (error) {
    log.warn("agent files: history unavailable:", (error as Error).message);
    return [];
  }

  const items: MediaItem[] = [];
  const seen = new Set<string>();
  const add = (part: Record<string, unknown>) => {
    logPartShape(part);
    const item = mediaFromPart(part);
    if (!item) return;
    const key = item.uri ?? item.name;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const message of messages) {
    if (message.type !== "assistant") continue;
    for (const part of message.content ?? []) {
      const value = part as unknown as Record<string, unknown>;
      if (value.type === "file") add(value);
      if (value.type === "tool") {
        const state = value.state as { content?: unknown } | undefined;
        const content = Array.isArray(state?.content) ? state?.content : [];
        for (const entry of content) {
          const file = entry as Record<string, unknown>;
          if (file?.type === "file") add(file);
        }
      }
      const nested = value.content;
      if (Array.isArray(nested)) {
        for (const entry of nested) {
          const file = entry as Record<string, unknown>;
          if (file?.type === "file") add(file);
        }
      }
    }
  }
  return items;
}

const loggedShapes = new Set<string>();

/** Documents the part format once per distinct key set. */
function logPartShape(part: Record<string, unknown>): void {
  const keys = Object.keys(part).sort().join(",");
  const kind = String(part.type ?? "?");
  const signature = `${kind}:${keys}`;
  if (loggedShapes.has(signature)) return;
  loggedShapes.add(signature);
  const preview: Record<string, unknown> = { type: part.type };
  for (const key of Object.keys(part)) {
    const value = part[key];
    if (typeof value === "string") preview[key] = value.length > 120 ? `${value.slice(0, 120)}…` : value;
    else if (value && typeof value === "object") preview[key] = Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).join(",")}}`;
    else preview[key] = value;
  }
  log.info(`agent file part: ${JSON.stringify(preview)}`);
}

function mediaFromPart(part: Record<string, unknown>): MediaItem | undefined {
  const source = (part.uri ?? part.url ?? part.path ?? part.file ?? part.src) as string | undefined;
  if (!source || typeof source !== "string") return undefined;
  const mime = (part.mime ?? part.mimeType ?? part.mediaType ?? part.contentType) as string | undefined;
  const name =
    (part.name ?? part.filename ?? part.fileName ?? part.title) as string | undefined;
  const uri = /^(https?|data|file):/i.test(source) ? source : resolve(source);
  return {
    uri,
    mime: typeof mime === "string" ? mime : mimeFor(uri),
    name: (typeof name === "string" && name.trim()) || nameFor(mime, uri),
  };
}

function itemKey(item: MediaItem): string {
  if (item.buffer?.length) return `sha256:${createHash("sha256").update(item.buffer).digest("hex")}`;
  return `uri:${item.uri ?? item.name}`;
}

function linkFor(item: MediaItem): string | undefined {
  if (item.uri && /^https?:\/\//i.test(item.uri)) return item.uri;
  if (item.uri) return localPath(item.uri);
  return undefined;
}

function localPath(uri: string): string {
  if (/^file:\/\//i.test(uri)) {
    try {
      return resolve(decodeURIComponent(uri.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1")));
    } catch {
      return resolve(uri.replace(/^file:\/\//i, ""));
    }
  }
  return resolve(uri);
}

function nameFor(mime: unknown, uri: string | undefined): string {
  if (uri) {
    const clean = uri.split(/[?#]/)[0] ?? "";
    const base = clean.split(/[\\/]/).pop();
    if (base && base.length && !/^data:/i.test(uri)) return base;
  }
  const type = typeof mime === "string" ? mime.split("/")[1]?.split(";")[0] : undefined;
  return `file-${Date.now()}.${(type || "bin").replace(/[^a-z0-9]/gi, "")}`;
}

function mimeFor(path: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
    json: "application/json",
    zip: "application/zip",
    mp4: "video/mp4",
    ogg: "audio/ogg",
  };
  return ext ? map[ext] : undefined;
}

/** Size in bytes when known (used by adapters before reading large files). */
export function localSize(item: MediaItem): number | undefined {
  if (item.buffer?.length) return item.buffer.length;
  if (item.uri && !/^(https?|data):/i.test(item.uri)) {
    try {
      return statSync(localPath(item.uri)).size;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
