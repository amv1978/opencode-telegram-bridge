import { log } from "./log.ts";
import type { OcClient } from "./opencode/client.ts";

/**
 * Model display names are shared by Telegram and Discord. The literal product
 * name "OpenCode" is never a model: when nothing can be resolved we say
 * "unknown model" instead of misleading the user.
 */
export const UNKNOWN_MODEL = "unknown model";

export interface ModelRef {
  providerID?: string;
  id?: string;
  /** OpenCode 2.x may report `modelID` instead of `id` (assistant messages). */
  modelID?: string;
  variant?: string;
}

/**
 * `providerID/id` key used by `/api/model` and session.model. A model is only
 * "unknown" when both fields are absent: a lone provider or id still labels the
 * turn instead of collapsing to `unknown model`.
 */
export function modelKey(model?: ModelRef | null): string | undefined {
  const provider = String(model?.providerID ?? "").trim();
  const id = String(model?.id ?? model?.modelID ?? "").trim();
  if (!provider && !id) return undefined;
  if (provider && id) return `${provider}/${id}`;
  return provider || id;
}

/** Drops the bare "OpenCode"/"OpenCode Bridge" label and empty values. */
export function sanitizeModelName(value?: string | null): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return UNKNOWN_MODEL;
  if (/^opencode(\s+bridge)?$/i.test(text)) return UNKNOWN_MODEL;
  return text;
}

const NAME_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 60 * 1000;

/** Per-client cache: `/api/model` names + the label last used per session. */
export class ModelCatalog {
  private names = new Map<string, string>();
  private namesAt = 0;
  private namesInflight?: Promise<Map<string, string>>;
  private readonly sessions = new Map<string, { label: string; at: number }>();
  /** Last `providerID/id` seen per session: the fallback when `/api/model` is down. */
  private readonly keys = new Map<string, string>();

  constructor(private readonly oc: OcClient) {}

  /** Model id → display name from `/api/model`, cached for five minutes. */
  async modelNames(force = false): Promise<Map<string, string>> {
    if (!force && this.namesAt && Date.now() - this.namesAt < NAME_TTL_MS) return this.names;
    if (this.namesInflight) return this.namesInflight;
    this.namesInflight = (async () => {
      const map = new Map<string, string>();
      try {
        for (const model of await this.oc.listModels()) {
          if (!model.name) continue;
          map.set(`${model.providerID}/${model.id}`, sanitizeModelName(model.name));
          if (model.modelID) map.set(`${model.providerID}/${model.modelID}`, sanitizeModelName(model.name));
        }
      } catch (error) {
        log.warn("model list unavailable:", (error as Error).message);
      }
      this.names = map;
      this.namesAt = Date.now();
      return map;
    })().finally(() => {
      this.namesInflight = undefined;
    });
    return this.namesInflight;
  }

  /** Resolves one model reference; never returns "OpenCode". */
  async labelFor(model?: ModelRef | null): Promise<string> {
    const key = modelKey(model);
    if (!key) return UNKNOWN_MODEL;
    return this.labelForKey(key);
  }

  /** Display name for `providerID/id`; the raw key when `/api/model` has no entry. */
  private async labelForKey(key: string): Promise<string> {
    const names = await this.modelNames();
    return sanitizeModelName(names.get(key) ?? key);
  }

  async label(sessionID: string, refresh = false): Promise<string> {
    const cached = this.sessions.get(sessionID);
    if (!refresh && cached && Date.now() - cached.at < SESSION_TTL_MS) return cached.label;
    try {
      const session = await this.oc.getSession(sessionID);
      const key = modelKey(session.model) ?? this.keys.get(sessionID);
      if (key) {
        this.keys.set(sessionID, key);
        const label = await this.labelForKey(key);
        this.sessions.set(sessionID, { label, at: Date.now() });
        return label;
      }
      return cached?.label ?? UNKNOWN_MODEL;
    } catch (error) {
      log.warn(`model label for ${sessionID.slice(0, 16)}: ${(error as Error).message}`);
      // A failed session fetch must not erase a known model: fall back to
      // `providerID/id`, then to the last display name.
      const key = this.keys.get(sessionID);
      if (key) return sanitizeModelName(cached?.label && cached.label !== UNKNOWN_MODEL ? cached.label : key);
      return cached?.label ?? UNKNOWN_MODEL;
    }
  }

  remember(sessionID: string, label?: string): void {
    this.sessions.set(sessionID, { label: sanitizeModelName(label), at: Date.now() });
  }

  /** `session.model.selected`: the next label must be fetched again. */
  forget(sessionID: string): void {
    this.sessions.delete(sessionID);
    this.keys.delete(sessionID);
  }
}

const catalogs = new WeakMap<OcClient, ModelCatalog>();

export function catalogFor(oc: OcClient): ModelCatalog {
  let catalog = catalogs.get(oc);
  if (!catalog) {
    catalog = new ModelCatalog(oc);
    catalogs.set(oc, catalog);
  }
  return catalog;
}

export function resolveModelLabel(oc: OcClient, sessionID: string, refresh = false): Promise<string> {
  return catalogFor(oc).label(sessionID, refresh);
}

export function resolveModelName(oc: OcClient, model?: ModelRef | null): Promise<string> {
  return catalogFor(oc).labelFor(model);
}
