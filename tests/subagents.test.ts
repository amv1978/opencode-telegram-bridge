import { describe, expect, test } from "bun:test";
import { formatSubagentDuration, normalizeSubagentMode, subagentPlacement } from "../src/subagents.ts";

describe("subagent placement", () => {
  const matrix: Array<[unknown, boolean, string]> = [
    ["auto", true, "inline"],
    ["auto", false, "message"],
    [true, true, "inline"],
    [true, false, "message"],
    ["inline", true, "inline"],
    ["inline", false, "off"],
    ["message", true, "message"],
    ["message", false, "message"],
    ["off", true, "off"],
    ["off", false, "off"],
    [false, true, "off"],
  ];

  for (const [mode, active, expected] of matrix) {
    test(`${String(mode)} + stream=${active} → ${expected}`, () => {
      expect(subagentPlacement(mode, active)).toBe(expected);
    });
  }

  test("legacy and invalid values fall back to auto", () => {
    expect(normalizeSubagentMode(undefined)).toBe("auto");
    expect(normalizeSubagentMode(true)).toBe("auto");
    expect(normalizeSubagentMode("nonsense")).toBe("auto");
    expect(normalizeSubagentMode(false)).toBe("off");
  });

  test("background duration has the documented shape", () => {
    expect(formatSubagentDuration(12_000)).toBe("0m 12s");
    expect(formatSubagentDuration(65_000)).toBe("1m 05s");
    expect(formatSubagentDuration(0)).toBe("0m 00s");
  });
});
