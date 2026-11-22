import { describe, expect, test } from "bun:test";
import { ModelCatalog, modelKey, sanitizeModelName, UNKNOWN_MODEL } from "../src/model.ts";
import type { OcClient } from "../src/opencode/client.ts";

describe("modelKey", () => {
  test("prefers provider/id and tolerates partial refs", () => {
    expect(modelKey({ providerID: "p", id: "m" })).toBe("p/m");
    expect(modelKey({ providerID: "p", modelID: "m" })).toBe("p/m");
    expect(modelKey({ providerID: "p" })).toBe("p");
    expect(modelKey({ id: "m" })).toBe("m");
    expect(modelKey({})).toBeUndefined();
    expect(modelKey(null)).toBeUndefined();
  });
});

describe("sanitizeModelName", () => {
  test("never leaks the literal product name", () => {
    expect(sanitizeModelName("OpenCode")).toBe(UNKNOWN_MODEL);
    expect(sanitizeModelName(" OpenCode  Bridge ")).toBe(UNKNOWN_MODEL);
    expect(sanitizeModelName("DeepSeek  V4")).toBe("DeepSeek V4");
    expect(sanitizeModelName("")).toBe(UNKNOWN_MODEL);
  });
});

describe("ModelCatalog fallback", () => {
  const client = (behavior: { fail?: boolean; name?: string } = {}) =>
    ({
      listModels: async () => (behavior.name ? [{ id: "m", providerID: "p", name: behavior.name }] : []),
      getSession: async () => {
        if (behavior.fail) throw new Error("offline");
        return { id: "s", title: "t", time: { created: 0, updated: 0 }, model: { providerID: "p", id: "m" } };
      },
    }) as unknown as OcClient;

  test("maps provider/id through /api/model", async () => {
    const catalog = new ModelCatalog(client({ name: "Nice Model" }));
    expect(await catalog.label("s")).toBe("Nice Model");
  });

  test("falls back to the raw key when the session fetch fails", async () => {
    const catalog = new ModelCatalog(client());
    expect(await catalog.label("s")).toBe("p/m");
    catalog.remember("s", "Cached Name");
    const failing = new ModelCatalog(client({ fail: true }));
    expect(await failing.label("missing")).toBe(UNKNOWN_MODEL);
  });

  test("forget drops the cached label", async () => {
    const catalog = new ModelCatalog(client({ name: "Nice Model" }));
    await catalog.label("s");
    catalog.forget("s");
    expect(await catalog.labelFor(null)).toBe(UNKNOWN_MODEL);
  });
});
