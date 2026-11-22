import { describe, expect, test } from "bun:test";
import { turnStats } from "../src/discord/stats.ts";
import type { OcClient, OcMessage } from "../src/opencode/client.ts";

/** Only the methods `turnStats`/`ModelCatalog` actually use. */
function fakeClient(messages: OcMessage[], models: Array<{ id: string; providerID: string; name?: string }>) {
  return {
    messages: async () => messages,
    listModels: async () => models,
    getSession: async () => ({ id: "ses", title: "t", time: { created: 0, updated: 0 }, model: { providerID: "p", id: "m" } }),
  } as unknown as OcClient;
}

/** Newest-first, like the real API. */
const messages = [
  {
    id: "a1",
    type: "assistant",
    model: { providerID: "p", id: "m" },
    time: { created: 1000, firstToken: 2000, streamed: 3000, completed: 3500 },
    tokens: { input: 10, cache: { read: 90 }, output: 100 },
  },
  { id: "u1", type: "user", time: { created: 1000 } },
] as unknown as OcMessage[];

describe("turnStats", () => {
  test("duration, tok/s and context follow the OpenCode formula", async () => {
    const stats = await turnStats(fakeClient(messages, [{ id: "m", providerID: "p", name: "Nice Model" }]), "ses");
    expect(stats.duration).toBe(2500);
    expect(stats.tps).toBeCloseTo(100, 5);
    expect(stats.contextTokens).toBe(200);
    expect(stats.model).toBe("Nice Model");
  });

  test("falls back to the raw provider/id when /api/model has no name", async () => {
    const stats = await turnStats(fakeClient(messages, []), "ses");
    expect(stats.model).toBe("p/m");
  });

  test("keeps elapsed time when the history cannot be read", async () => {
    const client = {
      messages: async () => {
        throw new Error("offline");
      },
      listModels: async () => [],
      getSession: async () => {
        throw new Error("offline");
      },
    } as unknown as OcClient;
    const stats = await turnStats(client, "ses", 1234);
    expect(stats.duration).toBe(1234);
    expect(stats.model).toBe("unknown model");
  });
});
