/**
 * Bounded retry for chat API calls.
 *
 * Telegram answers a rate limit with HTTP 429 and `parameters.retry_after`
 * (seconds). The old handler slept inside the serial chain and then *returned
 * success*, so the chunk was considered delivered and never sent again. Here the
 * same call is awaited and repeated: wait `retry_after`, retry, and only after
 * `RETRY_ATTEMPTS` failures log the loss and rethrow so the next flush tick can
 * try again.
 */

/** Attempts per call, including the first one. */
export const RETRY_ATTEMPTS = 3;

export interface RetryInfo {
  attempt: number;
  waitMs: number;
}

export interface RetryHooks {
  /** Milliseconds to wait for a retryable error; `undefined` = not retryable. */
  retryAfterMs?: (error: unknown) => number | undefined;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: RetryInfo, error: unknown) => void;
  onLost?: (error: unknown, attempts: number) => void;
  attempts?: number;
}

/** Rate-limit wait from a Telegram or Discord error, when it carries one. */
export function retryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as {
    error_code?: number;
    parameters?: { retry_after?: number };
    retryAfter?: number;
    rawError?: { retry_after?: number };
    status?: number;
    httpStatus?: number;
    code?: number;
    name?: string;
  };
  const telegram = value.error_code === 429 || value.parameters?.retry_after !== undefined;
  const discord =
    value.status === 429 ||
    value.httpStatus === 429 ||
    value.code === 429 ||
    value.name === "RateLimitError" ||
    value.retryAfter !== undefined ||
    value.rawError?.retry_after !== undefined;
  if (!telegram && !discord) return undefined;
  const raw = value.parameters?.retry_after ?? value.rawError?.retry_after ?? value.retryAfter;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    // 429 without a usable hint: wait a conservative default.
    return 3000;
  }
  // Discord sometimes reports milliseconds; values above 100 are ms.
  const ms = raw > 100 ? raw : raw * 1000;
  return Math.max(1000, Math.round(ms));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Runs `call`, retrying only errors that carry a rate-limit hint. Any other
 * error is rethrown immediately, so `message is not modified` / parse errors
 * keep their existing handling.
 */
export async function withRetry<T>(
  label: string,
  call: () => Promise<T>,
  hooks: RetryHooks = {},
): Promise<T> {
  const attempts = Math.max(1, hooks.attempts ?? RETRY_ATTEMPTS);
  const waitFor = hooks.retryAfterMs ?? retryAfterMs;
  const sleep = hooks.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      const wait = waitFor(error);
      if (wait === undefined) throw error;
      if (attempt >= attempts) break;
      hooks.onRetry?.({ attempt, waitMs: wait }, error);
      await sleep(wait);
    }
  }
  hooks.onLost?.(lastError, attempts);
  throw lastError;
}

/** Counters shown in `/api/state.delivery` (and useful in tests). */
export class RetryCounters {
  retries = 0;
  lost = 0;

  recordRetry(): void {
    this.retries += 1;
  }

  recordLoss(): void {
    this.lost += 1;
  }

  snapshot(): { retries: number; lost: number } {
    return { retries: this.retries, lost: this.lost };
  }
}

/** Terse one-line error message for logs. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
