import type { OcClient } from "../opencode/client.ts";
import { resolveModelLabel, resolveModelName, type ModelRef } from "../model.ts";

/**
 * Human model name from OpenCode `/api/model`; provider/id when unknown and
 * "unknown model" when the session has no model yet. Shared with Telegram via
 * `src/model.ts` so both transports always agree.
 */
export async function modelLabel(oc: OcClient, sessionID: string): Promise<string> {
  return resolveModelLabel(oc, sessionID);
}

/**
 * Mirrors OpenCode's `SessionTurn.duration` / `SessionTurn.tokensPerSecond`:
 * duration is prompt creation → this message completed, and tok/s aggregates
 * every assistant step of the turn over its first-token → streamed window.
 *
 * Deliberately copied from the Telegram adapter instead of imported: the two
 * transports must stay independent.
 */
export async function turnStats(
  oc: OcClient,
  sessionID: string,
  elapsedMs?: number,
): Promise<{ duration?: number; tps?: number; contextTokens?: number; model?: string }> {
  try {
    const fetched = await oc.messages(sessionID, { limit: 60, order: "desc" });
    // The API returns newest-first; OpenCode's turn logic walks the timeline oldest-first.
    const messages = fetched.slice().reverse();
    let end = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.type === "assistant") {
        end = index;
        break;
      }
    }
    const last = messages[end];
    if (!last) return { duration: elapsedMs, model: await modelLabel(oc, sessionID) };
    const tokens = last.tokens as
      | { output?: number; reasoning?: number; input?: number; cache?: { read?: number } }
      | undefined;
    // The model of the last assistant message is the one that actually answered.
    const model = await resolveModelName(oc, (last as { model?: ModelRef }).model);

    // Turn boundary: the prompt after the previous idle marker, or the nearest prompt in legacy sessions.
    const legacy = !messages.some((message) => message.type === "idle");
    let start = -1;
    for (let index = end - 1; index >= 0; index--) {
      const message = messages[index];
      if (!message) break;
      if (message.type === "idle") break;
      if (message.type !== "user" && message.type !== "synthetic") continue;
      if (legacy) {
        start = index;
        break;
      }
      start = index;
    }
    const prompt = start >= 0 ? messages[start] : undefined;
    const steps = (prompt ? messages.slice(start + 1, end + 1) : [last]).filter((message) => message.type === "assistant");

    const contextTokens =
      Number(tokens?.input ?? 0) + Number(tokens?.cache?.read ?? 0) + Number(tokens?.output ?? 0) + Number(tokens?.reasoning ?? 0);

    const completed = last.time?.completed;
    const duration =
      completed && completed > 0 ? Math.max(0, completed - (prompt?.time?.created ?? last.time?.created ?? completed)) : elapsedMs;

    const active = steps.map((step) => {
      const time = step?.time;
      if (time?.streamed === undefined) return undefined;
      return Math.max(0, time.streamed - (time.firstToken ?? time.created ?? time.streamed));
    });
    const generated = active.every((value) => value !== undefined) ? active.reduce<number>((sum, value) => sum + (value ?? 0), 0) : 0;
    const output = steps.reduce((sum, step) => {
      const usage = step?.tokens as { output?: number; reasoning?: number } | undefined;
      return sum + Number(usage?.output ?? 0) + Number(usage?.reasoning ?? 0);
    }, 0);
    const tps = output > 0 && generated > 200 ? output / (generated / 1000) : undefined;

    return { duration, tps, contextTokens, model };
  } catch {
    return { duration: elapsedMs, model: await modelLabel(oc, sessionID) };
  }
}
