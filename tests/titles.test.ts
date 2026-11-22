import { describe, expect, test } from "bun:test";
import { canRename, renameWait, titleWithMarker } from "../src/titles.ts";

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

describe("rename window", () => {
  const now = 1_000_000;

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
