/**
 * Pure updater policy: error classification, retry backoff, `.sha256` parsing
 * and the auto-download state machine. No I/O here so it is cheap to test.
 */

export type UpdateErrorCode =
  | "network"
  | "rate-limit"
  | "http"
  | "hash"
  | "write"
  | "asset"
  | "state"
  | "dev"
  | "canceled"
  | "unknown";

export interface UpdateProblem {
  code: UpdateErrorCode;
  status?: number;
  /** Text shown in the panel banner, toast, tray and admin chat. */
  message: string;
  /** Extra actionable line (rate limit reset, release page hint). */
  hint?: string;
}

const NO_NETWORK =
  "Нет сети или GitHub недоступен. Проверьте подключение или прокси в настройках → «Сеть (прокси / IP)».";

const RATE_LIMIT = "GitHub ограничил частоту запросов (rate limit) — обновление не проверено.";

const NO_WRITE =
  "Нет прав на запись в папку установки. Закройте приложение или запустите обновление от администратора.";

const HASH_MISMATCH = "SHA256 скачанного файла не совпал — обновление отменено, текущая версия сохранена.";

const NO_ASSET = "В релизе нет bundle или файла SHA256 — обновитесь через установщик.";

const DEV_ONLY = "Автообновление доступно только для собранной версии.";

/** HTTP 403 is GitHub's unauthenticated rate limit (and 429 is the same idea). */
export function statusProblem(status: number, resetAt?: number, now = Date.now()): UpdateProblem {
  if (status === 403 || status === 429) {
    const minutes = resetAt && resetAt > now ? Math.max(1, Math.ceil((resetAt - now) / 60_000)) : 0;
    return {
      code: "rate-limit",
      status,
      message: RATE_LIMIT,
      hint: minutes
        ? `Лимит сбросится примерно через ${minutes} мин. Проверка повторится автоматически.`
        : "Повторите через 10–60 минут; проверка повторится автоматически.",
    };
  }
  if (status === 404) {
    return { code: "asset", status, message: `GitHub ответил HTTP 404: релиз или файл не найден.` };
  }
  return { code: "http", status, message: `GitHub ответил HTTP ${status}.` };
}

function textOf(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  const value = error as { message?: unknown; code?: unknown; cause?: unknown };
  const parts = [value.message, value.code, (value.cause as { message?: unknown } | undefined)?.message];
  return parts.filter((part) => typeof part === "string" && part).join(" | ");
}

/** Maps a thrown value (plus optional HTTP details) to user-facing text. */
export function mapUpdateFailure(
  error: unknown,
  options: { status?: number; remaining?: string | null; resetAt?: number; now?: number } = {},
): UpdateProblem {
  const text = textOf(error);
  const explicitStatus = Number(options.status);
  const fromText = Number(/(?:HTTP|status)\s*(\d{3})/i.exec(text)?.[1] ?? 0);
  const status = Number.isFinite(explicitStatus) && explicitStatus > 0 ? explicitStatus : fromText;

  if (status >= 400 && status < 600) {
    const problem = statusProblem(status, options.resetAt, options.now);
    if (status >= 500) return { ...problem, code: "http", message: `GitHub временно недоступен (HTTP ${status}).` };
    return problem;
  }

  if (/\b(canceled|cancelled|отменен|отменён)\b/i.test(text)) {
    return { code: "canceled", message: "Загрузка отменена." };
  }
  if (/sha256\s+для\s+bundle|bundle\s+не\s+опубликован|release has no tag|no tag_name|нет bundle|не найден bundle|asset/i.test(text)) {
    return { code: "asset", message: NO_ASSET };
  }
  if (/sha256|hash mismatch|не совпал/i.test(text)) {
    return { code: "hash", message: HASH_MISMATCH, hint: "Повторите загрузку: файл будет скачан заново." };
  }
  if (/EACCES|EPERM|EBUSY|EROFS|access is denied|permission denied|не удалось распаковать/i.test(text)) {
    return { code: "write", message: NO_WRITE };
  }
  if (/incomplete|не завершен|не завершён/i.test(text)) {
    return { code: "network", message: "Загрузка оборвалась — продолжим с того же места.", hint: "Проверка повторится автоматически." };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|fetch failed|network|socket|TLS|certificate/i.test(text)) {
    return { code: "network", message: NO_NETWORK, hint: "Проверка повторится автоматически." };
  }
  if (/только для собранной версии/i.test(text)) {
    return { code: "dev", message: DEV_ONLY };
  }
  return { code: "unknown", message: text ? `Обновление не удалось: ${text}` : "Обновление не удалось." };
}

/** 5 s → 30 s → 5 min, then give up (a human can press Retry). */
export function retryDelay(attempt: number): number | undefined {
  const delays = [5_000, 30_000, 300_000];
  if (!Number.isInteger(attempt) || attempt < 0) return undefined;
  return delays[attempt];
}

/** Retrying a hash/write/asset failure would just fail again. */
export function isRetryable(code: UpdateErrorCode | undefined): boolean {
  return code === "network" || code === "rate-limit" || code === "http" || code === undefined;
}

/**
 * `.sha256` files are either `<hash>  <name>`, `<hash> <name>` or just the hash.
 * Returns a lowercase 64-char digest or `""`.
 */
export function parseSha256(text: string | undefined): string {
  if (!text) return "";
  const token = text.trim().split(/\s+/)[0]?.replace(/^\*/, "") ?? "";
  const hash = token.toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

export interface AutoState {
  available: boolean;
  autoDownload: boolean;
  downloading: boolean;
  verified: boolean;
  errorCode?: UpdateErrorCode;
}

export type AutoAction = "none" | "download" | "wait-busy" | "wait-progress" | "ready";

/**
 * What the background downloader should do next. A turn in flight pauses the
 * transfer; a permanent failure stops it until the user presses Retry.
 */
export function autoAction(state: AutoState, busy: boolean): AutoAction {
  if (!state.available) return "none";
  if (state.verified) return "ready";
  if (!state.autoDownload) return "none";
  if (state.downloading) return busy ? "wait-busy" : "wait-progress";
  if (state.errorCode && !isRetryable(state.errorCode)) return "none";
  return busy ? "wait-busy" : "download";
}
