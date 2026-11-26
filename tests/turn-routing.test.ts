import { describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import { Streamer } from "../src/telegram/stream.ts";

/**
 * The RCA for 0.8.6: `turn start` was logged 18 times while only 7 turns ended;
 * end events named older assistant messages and were finalized against the
 * wrong (or a missing) stream. `Streamer.end()` now routes by the id carried by
 * the event and falls back to the newest live stream instead of dropping the end.
 */
interface FakeApi {
  api: Api;
  edits: Array<{ id: number; text: string }>;
  sent: number;
}

function fakeApi(): FakeApi {
  let nextId = 100;
  const edits: Array<{ id: number; text: string }> = [];
  const result: FakeApi = {
    sent: 0,
    edits,
    api: undefined as unknown as Api,
  };
  result.api = {
    sendRichMessage: async () => {
      result.sent += 1;
      return { message_id: ++nextId };
    },
    sendMessage: async () => {
      result.sent += 1;
      return { message_id: ++nextId };
    },
    editMessageText: async (_chatId: number, messageId: number, body: { markdown?: string } | string) => {
      edits.push({ id: messageId, text: typeof body === "string" ? body : (body.markdown ?? "") });
      return true;
    },
    sendChatAction: async () => true,
  } as unknown as Api;
  return result;
}

function makeStreamer(api: Api): Streamer {
  return new Streamer(api, {
    editIntervalMs: 60_000,
    showTools: "off",
    format: "rich",
    diagnostics: false,
  });
}

describe("turn routing", () => {
  test("20 sequential turns each get their own finalized message", async () => {
    const fake = fakeApi();
    const streamer = makeStreamer(fake.api);
    const target = { chatId: 1 };

    for (let index = 0; index < 20; index += 1) {
      const turnId = `msg_${index}`;
      const started = await streamer.begin("ses_20", target, "test-model", true, turnId);
      expect(started).toBe(turnId);
      streamer.append("ses_20", `answer ${index}`, turnId);
      const ended = await streamer.end("ses_20", `footer ${index}`, turnId);
      expect(ended).toBe(turnId);
      expect(streamer.hasBlock("ses_20")).toBe(false);
    }

    await streamer.shutdown();
    expect(fake.sent).toBe(20);
    const footers = fake.edits.filter((edit) => /^footer \d+$/.test(edit.text) || edit.text.includes("footer"));
    expect(footers.length).toBe(20);
    const ids = new Set(fake.edits.map((edit) => edit.id));
    expect(ids.size).toBe(20);
  });

  test("an end naming another assistant id finalizes the live stream instead of dropping it", async () => {
    const fake = fakeApi();
    const streamer = makeStreamer(fake.api);

    // execution.started without an id → provisional pN, then text binds msg_A.
    const turnId = await streamer.begin("ses_mismatch", { chatId: 1 }, "test-model", true);
    expect(turnId?.startsWith("p")).toBe(true);
    streamer.append("ses_mismatch", "the answer", "msg_A");

    const ended = await streamer.end("ses_mismatch", "footer mismatch", "msg_B");
    expect(ended).toBe("msg_A");
    expect(streamer.hasBlock("ses_mismatch")).toBe(false);
    expect(fake.edits.some((edit) => edit.text.includes("footer mismatch"))).toBe(true);
    await streamer.shutdown();
  });

  test("a late delta for an ended turn never reopens or edits the message", async () => {
    const fake = fakeApi();
    const streamer = makeStreamer(fake.api);
    await streamer.begin("ses_late", { chatId: 1 }, "test-model", true, "msg_1");
    streamer.append("ses_late", "first", "msg_1");
    await streamer.end("ses_late", "done", "msg_1");
    const editsAfterEnd = fake.edits.length;

    streamer.append("ses_late", " LATE", "msg_1");
    streamer.setText("ses_late", "rewritten", "msg_1");
    const reopened = await streamer.begin("ses_late", { chatId: 1 }, "test-model", false, "msg_1");
    expect(reopened).toBeUndefined();
    expect(streamer.hasBlock("ses_late")).toBe(false);
    expect(fake.edits.length).toBe(editsAfterEnd);
    await streamer.shutdown();
  });

  test("an end for a session with no live stream is logged, not silently dropped", async () => {
    const fake = fakeApi();
    const streamer = makeStreamer(fake.api);
    expect(await streamer.end("ses_none", "footer", "msg_missing")).toBe("msg_missing");
    expect(fake.edits).toEqual([]);
    await streamer.shutdown();
  });
});
