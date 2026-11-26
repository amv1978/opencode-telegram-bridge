import { describe, expect, test } from "bun:test";
import { RETRY_ATTEMPTS, RetryCounters, retryAfterMs, withRetry } from "../src/retry.ts";

/** Telegram 429 as grammY exposes it. */
function telegram429(retryAfter: number): unknown {
  return {
    name: "GrammyError",
    error_code: 429,
    description: `Too Many Requests: retry after ${retryAfter}`,
    parameters: { retry_after: retryAfter },
  };
}

/** Discord 429 shape (seconds or milliseconds depending on the layer). */
function discord429(retryAfter: number): unknown {
  return { status: 429, retryAfter, rawError: { retry_after: retryAfter } };
}

describe("retry policy", () => {
  test("reads retry_after in seconds and milliseconds", () => {
    expect(retryAfterMs(telegram429(35))).toBe(35_000);
    expect(retryAfterMs(discord429(2.5))).toBe(2_500);
    expect(retryAfterMs(discord429(2500))).toBe(2_500);
    expect(retryAfterMs({ status: 429 })).toBe(3_000);
    expect(retryAfterMs(new Error("boom"))).toBeUndefined();
    expect(retryAfterMs(undefined)).toBeUndefined();
  });

  test("429 retries the same call after waiting and then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const stats = new RetryCounters();
    const value = await withRetry(
      "send",
      async () => {
        calls += 1;
        if (calls < 3) throw telegram429(4);
        return "delivered";
      },
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
        onRetry: () => stats.recordRetry(),
        onLost: () => stats.recordLoss(),
      },
    );
    expect(value).toBe("delivered");
    expect(calls).toBe(3);
    expect(waits).toEqual([4_000, 4_000]);
    expect(stats.snapshot()).toEqual({ retries: 2, lost: 0 });
  });

  test("gives up after 3 attempts, counts the loss and rethrows", async () => {
    let calls = 0;
    const stats = new RetryCounters();
    const waits: number[] = [];
    await expect(
      withRetry(
        "edit",
        async () => {
          calls += 1;
          throw telegram429(2);
        },
        {
          sleep: async (ms) => {
            waits.push(ms);
          },
          onRetry: () => stats.recordRetry(),
          onLost: () => stats.recordLoss(),
        },
      ),
    ).rejects.toMatchObject({ error_code: 429 });
    expect(calls).toBe(RETRY_ATTEMPTS);
    expect(waits.length).toBe(RETRY_ATTEMPTS - 1);
    expect(stats.snapshot()).toEqual({ retries: 2, lost: 1 });
  });

  test("a non-429 error is not retried", async () => {
    let calls = 0;
    await expect(
      withRetry(
        "send",
        async () => {
          calls += 1;
          throw new Error("message is not modified");
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow("message is not modified");
    expect(calls).toBe(1);
  });

  test("the lost chunk is rethrown so the next flush tick can retry", async () => {
    // A send returning `undefined` used to look like success and the chunk was
    // never retried. withRetry always either returns a value or throws.
    let call = 0;
    await expect(
      withRetry(
        "send",
        async () => {
          call += 1;
          if (call === 1) throw telegram429(1);
          throw new Error("network down");
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow("network down");
    expect(call).toBe(2);
  });
});
