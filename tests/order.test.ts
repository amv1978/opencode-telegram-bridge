import { describe, expect, test } from "bun:test";
import { assignChunk, mirrorKey, MirrorLedger, planChunks, TurnGate } from "../src/order.ts";

describe("chunk ordering", () => {
  test("existing chunks are edited in ascending order, new ones sent in place", () => {
    expect(planChunks([11, undefined, 13], 3)).toEqual([
      { index: 0, action: "edit" },
      { index: 1, action: "send" },
      { index: 2, action: "edit" },
    ]);
    expect(planChunks([], 2)).toEqual([
      { index: 0, action: "send" },
      { index: 1, action: "send" },
    ]);
    expect(planChunks([11], 0)).toEqual([]);
  });

  test("a retried chunk reuses its id instead of appending a duplicate", () => {
    const ids: Array<number | undefined> = [10];
    assignChunk(ids, 1, 20);
    assignChunk(ids, 1, 20);
    assignChunk(ids, 0, 10);
    expect(ids).toEqual([10, 20]);
    expect(planChunks(ids, 2).every((step) => step.action === "edit")).toBe(true);
  });

  test("holes are filled in place", () => {
    const ids: Array<string | undefined> = [];
    assignChunk(ids, 2, "c");
    expect(ids).toEqual([undefined, undefined, "c"]);
    expect(planChunks(ids, 3).map((step) => step.action)).toEqual(["send", "send", "edit"]);
  });
});

describe("mirror dedupe", () => {
  test("reads the id from every known inbox/message shape", () => {
    expect(mirrorKey({ id: "msg_1" })).toBe("msg_1");
    expect(mirrorKey({ payload: { metadata: { messageID: 42 } } })).toBe("42");
    expect(mirrorKey({ payload: { id: "item_2" } })).toBe("item_2");
    expect(mirrorKey({ payload: { text: "no id" } })).toBeUndefined();
    expect(mirrorKey(null)).toBeUndefined();
  });

  test("a replayed item is claimed once; a different id is new", () => {
    const ledger = new MirrorLedger();
    const item = { id: "m1", payload: { text: "hi" } };
    expect(ledger.claim("ses_1", item, 1_000)).toBe(true);
    expect(ledger.claim("ses_1", item, 2_000)).toBe(false);
    expect(ledger.claim("ses_2", item, 2_000)).toBe(true);
    expect(ledger.claim("ses_1", { id: "m2" }, 2_000)).toBe(true);
  });

  test("items without an id are never suppressed", () => {
    const ledger = new MirrorLedger();
    expect(ledger.claim("ses_1", { payload: { text: "x" } })).toBe(true);
    expect(ledger.claim("ses_1", { payload: { text: "x" } })).toBe(true);
  });
});

describe("turn gate", () => {
  test("late events cannot open a second placeholder", () => {
    const gate = new TurnGate(1_000);
    expect(gate.allowsBegin("ses_1", 10_000)).toBe(true);
    gate.close("ses_1", 10_000);
    expect(gate.allowsBegin("ses_1", 10_500)).toBe(false);
    expect(gate.allowsBegin("ses_1", 12_000)).toBe(true);
  });

  test("a new execution reopens the gate immediately", () => {
    const gate = new TurnGate(15_000);
    gate.close("ses_1", 10_000);
    expect(gate.allowsBegin("ses_1", 10_100)).toBe(false);
    gate.open("ses_1");
    expect(gate.allowsBegin("ses_1", 10_200)).toBe(true);
  });
});
