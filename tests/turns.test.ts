import { describe, expect, test } from "bun:test";
import { assistantMessageIDOf, TURN_TTL_MS, TurnRegistry, turnKey, turnTag } from "../src/turns.ts";

/**
 * Streams are keyed by `(sessionID, turnId)`. The bug this file guards against:
 * state was keyed by sessionID only, so a turn that ended with active subagents
 * kept its block, the next `begin()` early-returned and the new answer was
 * appended to the previous turn's message.
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

  test("later steps of one turn keep the turn id", () => {
    const turns = new TurnRegistry();
    turns.started("ses_a", "msg_1");
    expect(turns.bind("ses_a", "msg_2").turnId).toBe("msg_1");
    expect(turns.bind("ses_a", "msg_3").turnId).toBe("msg_1");
    expect(turns.current("ses_a")?.turnId).toBe("msg_1");
  });

  test("a replayed execution.started naming the same message is the same turn", () => {
    const turns = new TurnRegistry();
    const first = turns.started("ses_a", "msg_1");
    const replay = turns.started("ses_a", "msg_1");
    expect(replay.turnId).toBe(first.turnId);
    expect(replay.fresh).toBe(false);
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
