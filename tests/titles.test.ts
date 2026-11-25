import { describe, expect, test } from "bun:test";
import { canRename, normalizeTitleStatus, pickTopicIcon, renameWait, sameTitleName, syncTitleName, titleWithMarker } from "../src/titles.ts";

describe("title markers", () => {
  test("prefix by phase and restore the original", () => {
    expect(titleWithMarker("Fix login", "idle")).toBe("Fix login");
    expect(titleWithMarker("Fix login", "start")).toBe("⏳ Fix login");
    expect(titleWithMarker("Fix login", "done")).toBe("✅ Fix login");
    expect(titleWithMarker("  Fix   login  ", "start")).toBe("⏳ Fix login");
  });

  test("respects the platform name limit", () => {
    const name = titleWithMarker("x".repeat(120), "start", 100);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith("…")).toBe(true);
    expect(name.startsWith("⏳ ")).toBe(true);
  });
});

describe("rename window", () => {  const now = 1_000_000;

  test("allows the first rename and blocks inside the window", () => {
    expect(canRename(0, now)).toBe(true);
    expect(canRename(now - 30_000, now)).toBe(false);
    expect(canRename(now - 60_000, now)).toBe(true);
    expect(canRename(now - 30_000, now, 5 * 60_000)).toBe(false);
  });

  test("wait counts down to the window", () => {
    expect(renameWait(0, now)).toBe(0);
    expect(renameWait(now - 30_000, now)).toBe(30_000);
    expect(renameWait(now - 6 * 60_000, now, 5 * 60_000)).toBe(0);
  });
});

describe("session rename sync", () => {
  test("icon mode keeps the clean name, rename mode keeps the marker", () => {
    expect(syncTitleName("Fix login", "icon", "start")).toBe("Fix login");
    expect(syncTitleName("Fix login", "off", "done")).toBe("Fix login");
    expect(syncTitleName("Fix login", "rename", "start")).toBe("⏳ Fix login");
    expect(syncTitleName("Fix login", "rename", "done", 100)).toBe("✅ Fix login");
  });

  test("an unchanged name is skipped, a changed one is applied", () => {
    const name = syncTitleName("Fix login", "icon", "idle");
    expect(sameTitleName(name, "Fix login")).toBe(true);
    expect(sameTitleName("  Fix   login ", name)).toBe(true);
    expect(sameTitleName(undefined, "Fix login")).toBe(false);
    expect(sameTitleName("Old title", name)).toBe(false);
    expect(sameTitleName("⏳ Fix login", name)).toBe(false);
  });
});

describe("title status mode", () => {  test("defaults to the quiet icon mode, never to renames", () => {
    expect(normalizeTitleStatus(undefined)).toBe("icon");
    expect(normalizeTitleStatus("bogus")).toBe("icon");
    expect(normalizeTitleStatus("icon")).toBe("icon");
    expect(normalizeTitleStatus("rename")).toBe("rename");
    expect(normalizeTitleStatus("off")).toBe("off");
  });

  test("picks hourglass and check from the standard topic icon pack", () => {
    const stickers = [
      { emoji: "📊", custom_emoji_id: "1" },
      { emoji: "✅", custom_emoji_id: "2" },
      { emoji: "⏳", custom_emoji_id: "3" },
    ];
    expect(pickTopicIcon(stickers, "start")).toBe("3");
    expect(pickTopicIcon(stickers, "done")).toBe("2");
  });

  test("matches emoji with variation selectors and ignores junk", () => {
    const stickers = [{ emoji: "☑️", custom_emoji_id: "9" }, { emoji: "⏰", custom_emoji_id: "8" }];
    expect(pickTopicIcon(stickers, "done")).toBe("9");
    expect(pickTopicIcon(stickers, "start")).toBe("8");
    expect(pickTopicIcon([], "start")).toBeUndefined();
    expect(pickTopicIcon([{ emoji: "✅" }], "done")).toBeUndefined();
  });
});
