import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discordObserveKey,
  finalCardText,
  liveCardText,
  ObservationCards,
  parseObserveKey,
  pickObserveTarget,
  telegramObserveKey,
  type ObserveBinding,
} from "../src/observe.ts";
import { Store } from "../src/state/store.ts";

const store = () => new Store(join(mkdtempSync(join(tmpdir(), "ocbridge-observe-")), "state.json"));
const binding = (key: string): ObserveBinding => parseObserveKey(key)!;

describe("observe targets", () => {
  test("keys round-trip for Telegram chat/topic and Discord channel", () => {
    expect(telegramObserveKey(989181459)).toBe("tg:989181459:0");
    expect(telegramObserveKey(-1003870928790, 460)).toBe("tg:-1003870928790:460");
    expect(parseObserveKey("tg:-1003870928790:460")).toEqual({
      key: "tg:-1003870928790:460",
      platform: "telegram",
      chatId: -1003870928790,
      threadId: 460,
    });
    expect(parseObserveKey(discordObserveKey("1573135452737904680"))).toEqual({
      key: "dc:1573135452737904680",
      platform: "discord",
      channelId: "1573135452737904680",
    });
    expect(parseObserveKey("bogus")).toBeUndefined();
  });

  test("dedup guard skips bound, child and already-streamed sessions", () => {
    const targets = [binding("tg:1:0")];
    expect(pickObserveTarget({ bound: false, parent: false, hasStream: false }, targets)?.key).toBe("tg:1:0");
    expect(pickObserveTarget({ bound: true, parent: false, hasStream: false }, targets)).toBeUndefined();
    expect(pickObserveTarget({ bound: false, parent: true, hasStream: false }, targets)).toBeUndefined();
    expect(pickObserveTarget({ bound: false, parent: false, hasStream: true }, targets)).toBeUndefined();
    expect(pickObserveTarget({ bound: false, parent: false, hasStream: false }, [])).toBeUndefined();
  });
});

describe("observe persistence", () => {
  test("enabled flag, sessions and clearing survive a reload", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ocbridge-observe-")), "state.json");
    const first = new Store(file);
    first.observeEnable("tg:1:0");
    first.observeAdd("tg:1:0", "ses_a");
    first.observeAdd("tg:1:0", "ses_b");
    first.saveNow();

    const second = new Store(file);
    expect(second.observeEnabled("tg:1:0")).toBe(true);
    expect(second.observeFor("tg:1:0")).toEqual(["ses_a", "ses_b"]);

    second.observeRemove("ses_a");
    expect(second.observeFor("tg:1:0")).toEqual(["ses_b"]);
    second.observeClear("tg:1:0");
    expect(second.observeEnabled("tg:1:0")).toBe(false);
  });

  test("legacy string values are normalized", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocbridge-observe-"));
    const file = join(dir, "state.json");
    writeFileSync(
      file,
      JSON.stringify({ observe: { "dc:1": "ses_a", "tg:1:0": ["ses_b", "ses_b", ""] } }),
    );
    const fresh = new Store(file);
    expect(fresh.observeFor("dc:1")).toEqual(["ses_a"]);
    expect(fresh.observeFor("tg:1:0")).toEqual(["ses_b"]);
  });
});

describe("ObservationCards", () => {
  test("one card per session, edited in place, then replaced by the final card", async () => {
    const sent: string[] = [];
    const edits: string[] = [];
    const cards = new ObservationCards({
      intervalMs: 60_000,
      transport: {
        send: async (_target, text) => {
          sent.push(text);
          return "msg-1";
        },
        edit: async (_target, _messageId, text) => {
          edits.push(text);
        },
      },
    });
    const target = binding("tg:1:0");
    expect(await cards.begin("ses_a", target, "DeepSeek", "Fix login")).toBe(true);
    // Dedup guard: the same session must not get a second card.
    expect(await cards.begin("ses_a", target, "DeepSeek", "Fix login")).toBe(false);
    cards.toolCalled("ses_a");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("👀 Fix login");
    expect(sent[0]).toContain("🛠 0");

    await cards.end("ses_a", { ok: false, durationMs: 62_000, tps: 12.3, contextTokens: 24_000, costUsd: 0.0123 });
    expect(cards.has("ses_a")).toBe(false);
    expect(edits.at(-1)).toContain("⚠️ Fix login");
    expect(edits.at(-1)).toContain("⏱ 1m 2s");
    expect(edits.at(-1)).toContain("💰 $0.0123");
    await cards.shutdown();
  });

  test("card text formats elapsed, tools and success", () => {
    const live = liveCardText({ title: "", model: "m", startedAt: 0, tools: 3, sessionID: "ses_1234567890" }, 12_000);
    expect(live.split("\n")[0]).toContain("ses_12345678");
    expect(live).toContain("⏱ 12s · 🛠 3");
    const final = finalCardText({ title: "T", model: "m", sessionID: "s" }, { ok: true, durationMs: 5_000, costUsd: 0 });
    expect(final.split("\n")[0]).toBe("✅ T · m");
    expect(final).toContain("💰 $0.0000");
  });
});
