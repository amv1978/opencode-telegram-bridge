import { describe, expect, test } from "bun:test";
import { isPermissionMode, MODE_SUMMARY, modeOf, rulesForMode } from "../src/permissions.ts";

describe("permission modes", () => {
  test("recognises only the three presets", () => {
    expect(isPermissionMode("ask")).toBe(true);
    expect(isPermissionMode("auto")).toBe(true);
    expect(isPermissionMode("plan")).toBe(true);
    expect(isPermissionMode("yolo")).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
  });

  test("ask resets to agent defaults", () => {
    expect(rulesForMode("ask")).toBeNull();
  });

  test("auto allows everything, plan denies write/edit/bash", () => {
    expect(rulesForMode("auto")).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
    const plan = rulesForMode("plan")!;
    expect(plan[0]).toEqual({ action: "*", resource: "*", effect: "allow" });
    for (const action of ["write", "edit", "bash"]) {
      expect(plan).toContainEqual({ action, resource: "*", effect: "deny" });
    }
  });

  test("modeOf round-trips and treats empty as ask", () => {
    for (const mode of ["ask", "auto", "plan"] as const) {
      expect(modeOf(rulesForMode(mode))).toBe(mode);
    }
    expect(modeOf(undefined)).toBe("ask");
    expect(modeOf([])).toBe("ask");
    expect(MODE_SUMMARY.plan).toContain("bash");
  });
});
