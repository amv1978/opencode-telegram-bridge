import { describe, expect, test } from "bun:test";
import { formatAgo, isUnread, recentEntries, recentLine, shortDirectory } from "../src/recent.ts";

const now = Date.UTC(2026, 10, 22, 12);
const session = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  time: { created: now - 60_000, updated: now - 60_000 },
  location: { directory: "D:\\work\\project" },
  ...patch,
});

describe("unread", () => {
  test("idle after the last view is unread", () => {
    expect(isUnread(session("a", { time: { idle: 10, viewed: 5 } }))).toBe(true);
    expect(isUnread(session("a", { time: { idle: 5, viewed: 10 } }))).toBe(false);
    expect(isUnread(session("a", { time: { idle: 5 } }))).toBe(true);
    expect(isUnread(session("a", { time: { busy: 10, idle: 5, viewed: 10 } }))).toBe(false);
    expect(isUnread(session("a", { time: { busy: 10 } }))).toBe(true);
    expect(isUnread(session("a"))).toBe(false);
  });
});

describe("recentEntries", () => {
  test("filters children/archived, sorts by update and limits", () => {
    const entries = recentEntries(
      [
        session("old", { time: { updated: now - 600_000 } }),
        session("child", { parentID: "old" }),
        session("archived", { time: { updated: now - 10_000, archived: now } }),
        session("new", { time: { updated: now - 5_000, idle: 20, viewed: 10 } }),
      ],
      5,
      now,
    );
    expect(entries.map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(entries[0]?.unread).toBe(true);
    expect(entries[1]?.unread).toBe(false);
  });

  test("line format includes bell, folder and age", () => {
    const [entry] = recentEntries([session("x", { time: { updated: now - 120_000, idle: 20, viewed: 10 } })], 5, now);
    expect(recentLine(entry!, 0)).toBe("1. 🔔 Title x · project · 2м");
  });
});

describe("small helpers", () => {
  test("formatAgo buckets", () => {
    expect(formatAgo(now - 5_000, now)).toBe("сейчас");
    expect(formatAgo(now - 120_000, now)).toBe("2м");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3ч");
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe("2д");
    expect(formatAgo(0, now)).toBe("");
  });

  test("shortDirectory takes the last path segment", () => {
    expect(shortDirectory("D:\\work\\repo\\")).toBe("repo");
    expect(shortDirectory("/home/me/repo")).toBe("repo");
    expect(shortDirectory(undefined)).toBe("");
  });
});
