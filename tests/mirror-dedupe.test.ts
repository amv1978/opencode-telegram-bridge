import { describe, expect, test } from "bun:test";
import {
  mirrorHash,
  mirrorTargetKey,
  normalizeMirrorText,
  MirrorLedger,
  uniqueMirrorTargets,
  type MirrorTarget,
} from "../src/order.ts";

/**
 * One external prompt must be mirrored exactly once per target chat: a session
 * can be bound to a Telegram topic, a private chat and a Discord thread at the
 * same time. Dedupe is by normalized text + target, shared by both transports.
 */
describe("mirror text identity", () => {
  test("normalizes whitespace without touching the words", () => {
    expect(normalizeMirrorText("  run\tthe\n\ntests ")).toBe("run the tests");
    expect(mirrorHash("run  the tests")).toBe(mirrorHash("run the tests"));
    expect(mirrorHash("run the tests")).not.toBe(mirrorHash("run the test"));
    expect(mirrorHash("привет")).toMatch(/^[0-9a-f]{8}$/);
  });

  test("target keys distinguish transport, chat and thread", () => {
    expect(mirrorTargetKey({ kind: "tg", chatId: -100, threadId: 12 })).toBe("tg:-100:12");
    expect(mirrorTargetKey({ kind: "tg", chatId: 42 })).toBe("tg:42:0");
    expect(mirrorTargetKey({ kind: "dc", chatId: "999", threadId: "1" })).toBe("dc:999:1");
  });

  test("duplicate targets collapse to one", () => {
    const targets: MirrorTarget[] = [
      { kind: "tg", chatId: -100, threadId: 12 },
      { kind: "tg", chatId: -100, threadId: 12 },
      { kind: "tg", chatId: 42 },
      { kind: "dc", chatId: "999" },
    ];
    expect(uniqueMirrorTargets(targets)).toEqual([
      { kind: "tg", chatId: -100, threadId: 12 },
      { kind: "tg", chatId: 42 },
      { kind: "dc", chatId: "999" },
    ]);
  });
});

describe("a session with 3 targets", () => {
  const sessionID = "ses_three";
  const text = "fix the failing test";
  const targets: MirrorTarget[] = [
    { kind: "tg", chatId: -1003870928790, threadId: 120 }, // forum topic
    { kind: "tg", chatId: 555 }, // private chat
    { kind: "dc", chatId: "1575577617602711717" }, // Discord thread
  ];
  const keys = targets.map(mirrorTargetKey);

  test("one copy per target, nothing duplicated", () => {
    const ledger = new MirrorLedger();
    const delivered: string[] = [];
    for (const key of keys) {
      if (ledger.claim(sessionID, text, key)) delivered.push(key);
    }
    expect(delivered).toEqual(keys);
    expect(new Set(delivered).size).toBe(3);
  });

  test("replays of the same prompt (SSE + history fallback) add no copies", () => {
    const ledger = new MirrorLedger();
    for (const key of keys) expect(ledger.claim(sessionID, text, key, 1_000)).toBe(true);
    // The history fallback carries another item id and reformatted text.
    for (const key of keys) {
      expect(ledger.claim(sessionID, "  fix the failing\ntest ", key, 2_000, "msg_other")).toBe(false);
    }
    expect(ledger.suppressedCount).toBe(3);
  });

  test("a failed send can retry; the other targets are untouched", () => {
    const ledger = new MirrorLedger();
    for (const key of keys) expect(ledger.claim(sessionID, text, key, 1_000)).toBe(true);
    ledger.release(sessionID, text, keys[1]!);
    expect(ledger.claim(sessionID, text, keys[1]!, 2_000)).toBe(true);
  });
});
