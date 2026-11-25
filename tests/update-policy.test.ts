import { describe, expect, test } from "bun:test";
import {
  autoAction,
  isRetryable,
  mapUpdateFailure,
  parseSha256,
  retryDelay,
  statusProblem,
  type AutoState,
} from "../src/update/policy.ts";

describe("update error mapping", () => {
  test("no network stays network with a proxy hint", () => {
    const problem = mapUpdateFailure(new TypeError("fetch failed"));
    expect(problem.code).toBe("network");
    expect(problem.message).toContain("Нет сети");
    expect(problem.hint).toBeTruthy();
  });

  test("HTTP 403/429 become a GitHub rate-limit hint", () => {
    const reset = Date.now() + 12 * 60_000;
    const forbidden = mapUpdateFailure("GitHub HTTP 403", { status: 403, resetAt: reset });
    expect(forbidden.code).toBe("rate-limit");
    expect(forbidden.status).toBe(403);
    expect(forbidden.hint).toContain("мин");
    expect(mapUpdateFailure("HTTP 429", { status: 429 }).code).toBe("rate-limit");
    expect(statusProblem(403).message).toContain("rate limit");
  });

  test("5xx, hash, write and asset failures get distinct codes", () => {
    expect(mapUpdateFailure("HTTP 503", { status: 503 }).code).toBe("http");
    expect(mapUpdateFailure(new Error("SHA256 mismatch")).code).toBe("hash");
    expect(mapUpdateFailure(new Error("EACCES: permission denied")).code).toBe("write");
    expect(mapUpdateFailure(new Error("SHA256 для bundle не опубликован")).code).toBe("asset");
    expect(mapUpdateFailure(new Error("release has no tag_name")).code).toBe("asset");
    expect(mapUpdateFailure(new Error("canceled")).code).toBe("canceled");
    expect(mapUpdateFailure(new Error("только для собранной версии")).code).toBe("dev");
  });

  test("retries only transient failures, with 5 s / 30 s / 5 min backoff", () => {
    expect(retryDelay(0)).toBe(5_000);
    expect(retryDelay(1)).toBe(30_000);
    expect(retryDelay(2)).toBe(300_000);
    expect(retryDelay(3)).toBeUndefined();
    expect(isRetryable("network")).toBe(true);
    expect(isRetryable("rate-limit")).toBe(true);
    expect(isRetryable("http")).toBe(true);
    expect(isRetryable("hash")).toBe(false);
    expect(isRetryable("write")).toBe(false);
    expect(isRetryable("asset")).toBe(false);
  });
});

describe(".sha256 parsing", () => {
  test("accepts hash-only, hash + name, uppercase and leading *", () => {
    const hash = "a".repeat(64);
    expect(parseSha256(hash)).toBe(hash);
    expect(parseSha256(`${hash}\n`)).toBe(hash);
    expect(parseSha256(`${hash}  ocbridge-bundle-0.8.4.zip`)).toBe(hash);
    expect(parseSha256(`${"B".repeat(64)}  file`)).toBe("b".repeat(64));
    expect(parseSha256(`*${hash}`)).toBe(hash);
    expect(parseSha256("")).toBe("");
    expect(parseSha256("deadbeef")).toBe("");
    expect(parseSha256(undefined)).toBe("");
  });
});

describe("auto-download state machine", () => {
  const base: AutoState = {
    available: true,
    autoDownload: true,
    downloading: false,
    verified: false,
  };

  test("downloads on discovery when idle and autoDownload is on", () => {
    expect(autoAction(base, false)).toBe("download");
  });

  test("waits for a running turn instead of competing with it", () => {
    expect(autoAction(base, true)).toBe("wait-busy");
    expect(autoAction({ ...base, downloading: true }, true)).toBe("wait-busy");
    expect(autoAction({ ...base, downloading: true }, false)).toBe("wait-progress");
  });

  test("verified bundle is ready to install and is not downloaded again", () => {
    expect(autoAction({ ...base, verified: true }, false)).toBe("ready");
    expect(autoAction({ ...base, verified: true }, true)).toBe("ready");
  });

  test("respects autoDownload = false and permanent errors", () => {
    expect(autoAction({ ...base, autoDownload: false }, false)).toBe("none");
    expect(autoAction({ ...base, errorCode: "hash" }, false)).toBe("none");
    expect(autoAction({ ...base, errorCode: "write" }, false)).toBe("none");
    expect(autoAction({ ...base, errorCode: "network" }, false)).toBe("download");
    expect(autoAction({ ...base, errorCode: "rate-limit" }, true)).toBe("wait-busy");
    expect(autoAction({ ...base, available: false }, false)).toBe("none");
  });
});
