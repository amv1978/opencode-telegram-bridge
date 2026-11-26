import { describe, expect, test } from "bun:test";
import { assistantMessageIDOf, TURN_TTL_MS, TurnRegistry, turnKey, turnTag } from "../src/turns.ts";

/**
 * Streams are keyed by `(sessionID, turnId)`. A turn is one assistant message:
 * a new assistant id starts a new turn, and an end event names the turn it
 * ends instead of relying on a single per-session pointer (the 0.8.6 RCA:
 * 18 turn starts vs 7 ends, ends referencing older messages).
 */
describe("turn keying", () => {
  test("a turn after `end` gets a new id, so begin cannot reuse the message", () => {
    const turns = new TurnRegistry();
    const first = turns.started("ses_a");
    expect(first.fresh).toBe(true);
    turns.bind("ses_a", "msg_1");
    expect(turns.current("ses_a")?.turnId).toBe("msg_1");
    turns.end("ses_a", "msg_1");
    expect(turns.current("ses_a")).toBeUndefined();

    const second = turns.started("ses_a");
    expect(second.fresh).toBe(true);
    expect(second.turnId).not.toBe("msg_1");
    expect(turnKey("ses_a", second.turnId)).not.toBe(turnKey("ses_a", "msg_1"));
  });

  test("the provisional turn is adopted by the first assistant message id", () => {
    const turns = new TurnRegistry();
    const provisional = turns.started("ses_a");
    expect(provisional.provisional).toBe(true);
    const bound = turns.bind("ses_a", "msg_1");
    expect(bound.adoptedFrom).toBe(provisional.turnId);
    expect(bound.turnId).toBe("msg_1");
    // Same message id again: same turn, no adoption.
    expect(turns.bind("ses_a", "msg_1").adoptedFrom).toBeUndefined();
  });

  test("a new assistant id starts a new turn", () => {
    const turns = new TurnRegistry();
    turns.started("ses_a", "msg_1");
    const second = turns.bind("ses_a", "msg_2");
    expect(second.turnId).toBe("msg_2");
    expect(second.fresh).toBe(true);
    expect(turns.current("ses_a")?.turnId).toBe("msg_2");
    // A late delta for the first message reuses its own turn, not msg_2.
    const late = turns.bind("ses_a", "msg_1");
    expect(late.turnId).toBe("msg_1");
    expect(late.fresh).toBe(false);
    // ...and does not move the newest pointer.
    expect(turns.current("ses_a")?.turnId).toBe("msg_2");
  });

  test("an id of an ended turn is stale and never reopens it", () => {
    const turns = new TurnRegistry();
    turns.started("ses_a", "msg_1");
    turns.end("ses_a", "msg_1");
    const late = turns.bind("ses_a", "msg_1");
    expect(late.stale).toBe(true);
    const replay = turns.started("ses_a", "msg_1");
    expect(replay.stale).toBe(true);
    expect(turns.current("ses_a")).toBeUndefined();
  });

  test("a replayed execution.started naming the same message is the same turn", () => {
    const turns = new TurnRegistry();
    const first = turns.started("ses_a", "msg_1");
    const replay = turns.started("ses_a", "msg_1");
    expect(replay.turnId).toBe(first.turnId);
    expect(replay.fresh).toBe(false);
  });

  test("20 sequential turns never lose their end", () => {
    const turns = new TurnRegistry();
    for (let index = 0; index < 20; index += 1) {
      const id = `msg_${index}`;
      const started = turns.started("ses_a");
      expect(started.fresh).toBe(true);
      const bound = turns.bind("ses_a", id);
      expect(bound.turnId).toBe(id);
      turns.end("ses_a", id);
      expect(turns.current("ses_a")).toBeUndefined();
    }
  });

  test("ending by the carried id leaves another live turn alive", () => {
    const turns = new TurnRegistry();
    turns.started("ses_a", "msg_1");
    turns.started("ses_a", "msg_2");
    turns.end("ses_a", "msg_1");
    expect(turns.current("ses_a")?.turnId).toBe("msg_2");
    expect(turns.bind("ses_a", "msg_1").stale).toBe(true);
  });

  test("sessions do not share turns", () => {
    const turns = new TurnRegistry();
    turns.started("ses_a", "msg_a");
    turns.started("ses_b", "msg_b");
    expect(turns.current("ses_a")?.turnId).toBe("msg_a");
    expect(turns.current("ses_b")?.turnId).toBe("msg_b");
    turns.end("ses_a", "msg_b"); // wrong turn id: must not end ses_b
    expect(turns.current("ses_b")?.turnId).toBe("msg_b");
  });

  test("abandoned turns expire after the TTL", () => {
    const turns = new TurnRegistry(TURN_TTL_MS);
    const now = 1_000_000;
    turns.started("ses_a", "msg_1", now);
    expect(turns.current("ses_a", now + TURN_TTL_MS - 1)?.turnId).toBe("msg_1");
    expect(turns.current("ses_a", now + TURN_TTL_MS + 1)).toBeUndefined();
    turns.started("ses_b", "msg_2", now);
    expect(turns.pruneAll(now + TURN_TTL_MS + 1)).toBe(1);
  });
});

describe("turn payload helpers", () => {
  test("reads the assistant message id from the event payload", () => {
    expect(assistantMessageIDOf({ sessionID: "ses_a", assistantMessageID: "msg_1" })).toBe("msg_1");
    expect(assistantMessageIDOf({ assistantMessageId: " msg_2 " })).toBe("msg_2");
    expect(assistantMessageIDOf({ item: { assistantMessageID: "msg_3" } })).toBe("msg_3");
    expect(assistantMessageIDOf({ sessionID: "ses_a" })).toBeUndefined();
    expect(assistantMessageIDOf(undefined)).toBeUndefined();
  });

  test("the diagnostics tag is six characters and stable", () => {
    expect(turnTag("msg_abcdef123")).toBe("#tmsgabc");
    expect(turnTag("p12")).toBe("#tp12");
    expect(turnTag(undefined)).toBe("#tnone");
  });
});
