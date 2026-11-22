/**
 * Permission presets exposed as `/mode` in chat.
 *
 * OpenCode evaluates a session ruleset of `{ action, resource, effect }` rules
 * and applies the most specific/last match, so presets start with a catch-all
 * `allow` and narrow it down.
 */

export type PermissionMode = "ask" | "auto" | "plan";
export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export const PERMISSION_MODES: PermissionMode[] = ["ask", "auto", "plan"];

export const MODE_SUMMARY: Record<PermissionMode, string> = {
  ask: "спрашивать разрешение (по умолчанию)",
  auto: "разрешать всё",
  plan: "запретить запись, правку и bash",
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "ask" || value === "auto" || value === "plan";
}

/** Ruleset for a mode; `null` means "leave/reset to the agent defaults". */
export function rulesForMode(mode: PermissionMode): PermissionRule[] | null {
  if (mode === "auto") return [{ action: "*", resource: "*", effect: "allow" }];
  if (mode === "plan") {
    return [
      { action: "*", resource: "*", effect: "allow" },
      { action: "write", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "deny" },
    ];
  }
  return null;
}

/** Recognises a preset from a session ruleset (for `/mode` without arguments). */
export function modeOf(rules: PermissionRule[] | null | undefined): PermissionMode {
  const list = Array.isArray(rules) ? rules : [];
  if (!list.length) return "ask";
  const denied = new Set(
    list.filter((rule) => rule.effect === "deny").map((rule) => String(rule.action ?? "").toLowerCase()),
  );
  if (denied.has("write") || denied.has("edit") || denied.has("bash")) return "plan";
  const allowAll = list.length === 1 && list[0]!.action === "*" && list[0]!.resource === "*" && list[0]!.effect === "allow";
  return allowAll ? "auto" : "ask";
}
