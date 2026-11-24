import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store.ts";

function tempStore(): { store: Store; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-state-"));
  const file = join(dir, "state.json");
  return { store: new Store(file), file };
}

describe("panel hidden sessions", () => {
  test("hiding is persisted in state.json and survives a restart", () => {
    const { store, file } = tempStore();
    expect(store.hiddenSessions()).toEqual([]);
    store.hideSession("ses_one");
    store.hideSession("ses_two");
    // Duplicates are ignored.
    store.hideSession("ses_two");
    store.saveNow();
    expect(store.isSessionHidden("ses_one")).toBe(true);

    const restored = new Store(file);
    expect(restored.hiddenSessions()).toEqual(["ses_one", "ses_two"]);
    expect(restored.isSessionHidden("ses_two")).toBe(true);
    expect(restored.isSessionHidden("ses_three")).toBe(false);
  });

  test("hiding is panel-only: topic bindings are untouched", () => {
    const { store } = tempStore();
    store.bindThread(42, "ses_thread");
    store.hideSession("ses_thread");
    store.saveNow();
    expect(store.byThread(42)).toBe("ses_thread");
    expect(store.isSessionHidden("ses_thread")).toBe(true);
  });

  test("show removes only the requested id", () => {
    const { store, file } = tempStore();
    store.hideSession("a");
    store.hideSession("b");
    store.showSession("a");
    store.showSession("missing");
    store.saveNow();
    expect(new Store(file).hiddenSessions()).toEqual(["b"]);
  });

  test("tolerates junk lists in an old state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocbridge-state-"));
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ ui: { hiddenSessions: ["a", "a", "", 5, null] } }), "utf8");
    expect(new Store(file).hiddenSessions()).toEqual(["a", "5"]);
    writeFileSync(file, JSON.stringify({ ui: "broken" }), "utf8");
    expect(new Store(file).hiddenSessions()).toEqual([]);
  });
});
