import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log.ts";

export interface OcSession {
  id: string;
  title: string;
  parentID?: string | null;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  cost?: number;
  tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } };
  time: { created: number; updated: number; busy?: number; idle?: number };
  location?: { directory: string };
  permissions?: unknown[];
}

export interface OcPart {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  state?: { status?: string; input?: unknown; content?: Array<{ type: string; text?: string }> };
}

export interface OcMessage {
  id: string;
  type: string;
  text?: string;
  content?: OcPart[];
  time?: { created?: number; firstToken?: number; streamed?: number; completed?: number };
  cost?: number;
  tokens?: unknown;
  error?: unknown;
}

export interface OcEvent {
  type: string;
  data: Record<string, any>;
}

export interface Endpoint {
  baseUrl: string;
  password: string;
  source: string;
}

interface ServiceFile {
  url?: string;
  password?: string;
}

function readServiceFile(): ServiceFile {
  const candidates = [
    join(homedir(), ".config", "opencode", "service.json"),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "service.json"),
    join(homedir(), ".local", "state", "opencode", "service.json"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as ServiceFile;
    } catch {
      /* ignore malformed */
    }
  }
  return {};
}

const DEFAULT_PORTS = [28894, 49374, 4096];

/**
 * Finds the running OpenCode server. Uses the shared background service, so the
 * bridge sees the same sessions as the desktop app and TUI.
 */
export async function discover(cfg: { baseUrl?: string; password?: string }): Promise<Endpoint> {
  const service = readServiceFile();
  const password = cfg.password || service.password || process.env.OPENCODE_PASSWORD || "";
  const urls: string[] = [];
  if (cfg.baseUrl) urls.push(cfg.baseUrl.replace(/\/+$/, ""));
  if (service.url) urls.push(service.url.replace(/\/+$/, ""));
  for (const port of DEFAULT_PORTS) urls.push(`http://127.0.0.1:${port}`);

  const errors: string[] = [];
  for (const baseUrl of [...new Set(urls)]) {
    try {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: { authorization: basic(password) },
        signal: AbortSignal.timeout(2500),
      });
      if (res.status === 401) {
        errors.push(`${baseUrl}: 401 (password mismatch)`);
        continue;
      }
      if (!res.ok) {
        errors.push(`${baseUrl}: HTTP ${res.status}`);
        continue;
      }
      const info = (await res.json()) as { version?: string };
      log.info(`OpenCode ${info.version ?? "?"} at ${baseUrl}`);
      return { baseUrl, password, source: cfg.baseUrl ? "config" : service.url ? "service.json" : "port-probe" };
    } catch (e) {
      errors.push(`${baseUrl}: ${(e as Error).message}`);
    }
  }
  throw new Error(
    `OpenCode server not found. Tried:\n  ${errors.join("\n  ")}\n` +
      `Start it with "opencode service start" (or the desktop app) and check ~/.config/opencode/service.json.`,
  );
}

function basic(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

/** Keeps only valid `{uri,name}` attachments; anything else is dropped and logged. */
function promptFiles(files?: Array<{ uri: string; name?: string }>): Array<{ uri: string; name?: string }> {
  if (!files?.length) return [];
  return files.flatMap((file) => {
    const uri = typeof file?.uri === "string" ? file.uri.trim() : "";
    if (!uri) return [];
    return [{ uri, ...(file.name ? { name: String(file.name) } : {}) }];
  });
}

export class OcClient {
  private readonly auth: string;

  constructor(
    readonly baseUrl: string,
    password: string,
  ) {
    this.auth = basic(password);
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: this.auth, ...extra };
  }

  private async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
      // Chat commands must not hang forever on a half-open local socket; the
      // same limit keeps `ensureStream` and the doctor responsive.
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async info(): Promise<{ version: string; urls: string[] }> {
    return this.call("GET", "/api/info");
  }

  async listSessions(params: { limit?: number; search?: string } = {}): Promise<OcSession[]> {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.search) qs.set("search", params.search);
    const data = await this.call<{ data: OcSession[] }>("GET", `/api/session${qs.size ? `?${qs}` : ""}`);
    return data.data;
  }

  async createSession(input: { title?: string; directory?: string; permissions?: unknown[] }): Promise<OcSession> {
    const data = await this.call<{ data: OcSession }>("POST", "/api/session", {
      title: input.title,
      location: input.directory ? { directory: input.directory } : undefined,
      permissions: input.permissions,
    });
    return data.data;
  }

  async getSession(sessionID: string): Promise<OcSession> {
    return (await this.call<{ data: OcSession }>("GET", `/api/session/${sessionID}`)).data;
  }

  async updateSession(sessionID: string, patch: { title?: string }): Promise<OcSession> {
    return (await this.call<{ data: OcSession }>("PATCH", `/api/session/${sessionID}`, patch)).data;
  }

  async messages(sessionID: string, params: { limit?: number; order?: "asc" | "desc" } = {}): Promise<OcMessage[]> {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.order) qs.set("order", params.order);
    return (await this.call<{ data: OcMessage[] }>("GET", `/api/session/${sessionID}/message${qs.size ? `?${qs}` : ""}`)).data;
  }

  async prompt(
    sessionID: string,
    text: string,
    metadata?: Record<string, unknown>,
    files?: Array<{ uri: string; name?: string }>,
  ): Promise<void> {
    const payload = promptFiles(files);
    if (files?.length && payload.length !== files.length) {
      log.error(`prompt files dropped (missing uri): ${JSON.stringify(files.map((file) => Object.keys(file ?? {})))}`);
    }
    try {
      await this.call("POST", `/api/session/${sessionID}/prompt`, { text, metadata, files: payload });
    } catch (error) {
      const message = (error as Error).message;
      if (/\b400\b/.test(message)) {
        log.error(
          `prompt 400 files=${JSON.stringify(payload.map((file) => Object.keys(file)))} names=${JSON.stringify(payload.map((file) => file.name))}`,
        );
      }
      throw error;
    }
  }

  async interrupt(sessionID: string): Promise<{ interrupted: boolean }> {
    return this.call("POST", `/api/session/${sessionID}/interrupt`);
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: "once" | "always" | "reject",
    message?: string,
  ): Promise<void> {
    await this.call("POST", `/api/session/${sessionID}/permission/${requestID}/reply`, {
      decision,
      message: message ?? null,
    });
  }

  async pendingPermissions(sessionID: string): Promise<Array<Record<string, any>>> {
    return (await this.call<{ data: Array<Record<string, any>> }>("GET", `/api/session/${sessionID}/permission`)).data;
  }

  /** Queued prompts that OpenCode has not started yet. */
  async inbox(sessionID: string): Promise<Array<Record<string, any>>> {
    return (await this.call<{ data: Array<Record<string, any>> }>("GET", `/api/session/${sessionID}/inbox`)).data;
  }

  /** Sessions currently executing (id → `{type: "running"}`). */
  async activeSessions(): Promise<Record<string, { type?: string }>> {
    return (await this.call<{ data: Record<string, { type?: string }> }>("GET", "/api/session/active")).data;
  }

  async setModel(sessionID: string, model: { providerID: string; id: string; variant?: string }): Promise<void> {
    await this.call("POST", `/api/session/${sessionID}/model`, { model });
  }

  async setAgent(sessionID: string, agent: string): Promise<void> {
    await this.call("POST", `/api/session/${sessionID}/agent`, { agent });
  }

  async listAgents(): Promise<Array<{ id: string; name?: string; description?: string }>> {
    const data = await this.call<{ data: Array<{ id: string; name?: string; description?: string }> }>("GET", "/api/agent");
    return data.data;
  }

  /** Configured models (provider/model + human display name) for status lines. */
  async listModels(): Promise<Array<{ id: string; modelID?: string; providerID: string; name?: string }>> {
    const data = await this.call<{ data: Array<{ id: string; modelID?: string; providerID: string; name?: string }> }>(
      "GET",
      "/api/model",
    );
    return data.data;
  }

  /** Subscribes to the SSE event bus. Returns an abort function. */
  subscribe(types: string[], onEvent: (event: OcEvent) => void, onState?: (state: "open" | "closed") => void): () => void {
    const controller = new AbortController();
    // OpenCode expects repeated parameters: ?types=a&types=b, not a comma-joined list.
    const qs = types.length ? `?${types.map((type) => `types=${encodeURIComponent(type)}`).join("&")}` : "";
    let attempt = 0;

    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(`${this.baseUrl}/api/event${qs}`, {
            headers: this.headers({ accept: "text/event-stream" }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
          attempt = 0;
          onState?.("open");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index: number;
            while ((index = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, index).trimEnd();
              buffer = buffer.slice(index + 1);
              if (!line.startsWith("data:")) continue;
              try {
                const parsed = JSON.parse(line.slice(5).trim()) as OcEvent;
                if (parsed?.type) onEvent(parsed);
              } catch (e) {
                log.warn("SSE parse error:", (e as Error).message);
              }
            }
          }
          onState?.("closed");
        } catch (e) {
          if (controller.signal.aborted) return;
          onState?.("closed");
          log.warn("SSE disconnected:", (e as Error).message);
        }
        if (controller.signal.aborted) return;
        attempt += 1;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))));
      }
    };

    void run();
    return () => controller.abort();
  }
}
