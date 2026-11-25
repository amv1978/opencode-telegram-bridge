/**
 * SSE handlers are serial and must not keep mutating state after their time
 * budget. `runEvent` aborts a per-event signal; handlers check it after awaits.
 */
export const EVENT_TIMEOUT_MS = 20_000;

export async function runEvent(
  task: (signal: AbortSignal) => Promise<void>,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
