import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTargets, mediaFromPayload, MediaRelay, promptFilesFromMedia } from "../src/media/relay.ts";
import { Store } from "../src/state/store.ts";

const store = () => new Store(join(mkdtempSync(join(tmpdir(), "ocbridge-media-")), "state.json"));

describe("promptFilesFromMedia", () => {
  test("converts buffers to data URIs and keeps existing URIs", () => {
    const files = promptFilesFromMedia([
      { buffer: Buffer.from("hi"), mime: "text/plain", name: "a.txt" },
      { uri: "data:image/png;base64,AAA", name: "b.png" },
      { name: "empty" },
    ]);
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ uri: "data:text/plain;base64,aGk=", name: "a.txt" });
    expect(files[1]).toEqual({ uri: "data:image/png;base64,AAA", name: "b.png" });
  });
});

describe("mediaFromPayload", () => {
  test("reads nested lists and drops duplicate URIs", () => {
    const items = mediaFromPayload({
      files: [{ uri: "https://example.com/a.png", name: "a.png" }],
      payload: {
        attachments: [
          { uri: "https://example.com/a.png", name: "copy.png" },
          { url: "/tmp/b.pdf", mime: "application/pdf" },
        ],
      },
    });
    expect(items).toHaveLength(2);
    expect(items[0]?.name).toBe("a.png");
    expect(items[1]?.uri).toBe("/tmp/b.pdf");
    expect(items[1]?.mime).toBe("application/pdf");
  });

  test("ignores malformed entries", () => {
    expect(mediaFromPayload(null)).toEqual([]);
    expect(mediaFromPayload({ files: [null, {}, { uri: "  " }] })).toEqual([]);
  });
});

describe("listTargets", () => {
  test("dedupes the same chat and skips the origin platform", () => {
    const s = store();
    s.bindThread(42, "ses_a");
    s.upsert({ id: "ses_a", title: "A", chatId: -100, threadId: 42 });
    s.bindDiscordThread("999", "ses_a", "-100");
    const targets = listTargets(s, "ses_a", -100);
    expect(targets).toEqual([
      { platform: "telegram", chatId: -100, threadId: 42 },
      { platform: "discord", channelId: "999" },
    ]);
  });

  test("falls back to topicsChatId when only a topic binding exists", () => {
    const s = store();
    s.bindThread(7, "ses_b");
    const targets = listTargets(s, "ses_b", -555);
    expect(targets).toEqual([{ platform: "telegram", chatId: -555, threadId: 7 }]);
  });
});

describe("relay limits and dedupe", () => {
  function setup() {
    const s = store();
    s.bindThread(1, "ses_big");
    s.bindDiscordThread("999", "ses_big", "-100");
    const files: string[] = [];
    const texts: string[] = [];
    const relay = new MediaRelay({
      store: s,
      media: () => ({ relay: "all", maxPhotoMb: 10 }),
      topicsChatId: () => -100,
      senders: {
        discord: {
          send: async (_target, item) => {
            files.push(item.name);
          },
          sendText: async (_target, text) => {
            texts.push(text);
          },
        },
      },
    });
    return { relay, files, texts };
  }

  test("oversize files go to Discord as a path link instead of an upload", async () => {
    const { relay, files, texts } = setup();
    await relay.relay(
      "ses_big",
      [{ buffer: Buffer.alloc(11 * 1024 * 1024), uri: "D:\\tmp\\big.bin", name: "big.bin" }],
      "telegram",
    );
    expect(files).toEqual([]);
    expect(texts[0]).toContain("📎 big.bin:");
    expect(texts[0]).toContain("big.bin");
  });

  test("the same agent bytes are relayed once", async () => {
    const { relay, files } = setup();
    const item = { buffer: Buffer.from("same-bytes"), mime: "image/png", name: "a.png" };
    await relay.relay("ses_big", [item], "agent");
    await relay.relay("ses_big", [{ ...item }], "agent");
    expect(files).toEqual(["a.png"]);
  });
});
