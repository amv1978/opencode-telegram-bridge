import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, resolvePaths, saveConfig, type Paths } from "../src/config.ts";
import { Store } from "../src/state/store.ts";

function tempPaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-config-"));
  return { configFile: join(dir, "config.json"), stateFile: join(dir, "state.json"), logFile: join(dir, "bridge.log") };
}

describe("config merge", () => {
  test("creates defaults and fills missing sections", () => {
    const paths = tempPaths();
    const first = loadConfig(paths);
    expect(first.web.port).toBe(7788);
    expect(first.permissions?.mode).toBe("ask");
    expect(first.budget?.action).toBe("warn");

    writeFileSync(paths.configFile, JSON.stringify({ mode: "topics", budget: { perTurnUsd: "1.505", action: "stop" } }), "utf8");
    const merged = loadConfig(paths);
    expect(merged.mode).toBe("topics");
    expect(merged.budget?.perTurnUsd).toBe(1.51);
    expect(merged.budget?.action).toBe("stop");
    expect(merged.telegram.allowedUsers).toEqual([]);
  });

  test("clamps invalid values and ignores bad permission modes", () => {
    const paths = tempPaths();
    writeFileSync(
      paths.configFile,
      JSON.stringify({ media: { maxPhotoMb: 99, relay: "bogus" }, permissions: { mode: "yolo" }, budget: { dailyUsd: -4 } }),
      "utf8",
    );
    const cfg = loadConfig(paths);
    expect(cfg.media?.maxPhotoMb).toBe(10);
    expect(cfg.media?.relay).toBe("all");
    expect(cfg.permissions?.mode).toBe("ask");
    expect(cfg.budget?.dailyUsd).toBeUndefined();
  });
});

describe("atomic persistence", () => {
  test("save keeps one .bak and recovers a corrupt main file", () => {
    const paths = tempPaths();
    const cfg = loadConfig(paths);
    cfg.telegram.token = "first";
    saveConfig(paths, cfg);
    cfg.telegram.token = "second";
    saveConfig(paths, cfg);
    expect(existsSync(`${paths.configFile}.bak`)).toBe(true);

    writeFileSync(paths.configFile, "{ broken", "utf8");
    const recovered = loadConfig(paths);
    expect(recovered.telegram.token).toBe("first");
  });

  test("state.json is written atomically and survives corruption", () => {
    const paths = tempPaths();
    const store = new Store(paths.stateFile);
    store.bindThread(10, "ses_a");
    store.saveNow();
    store.bindThread(11, "ses_b");
    store.saveNow();
    expect(readFileSync(paths.stateFile, "utf8")).toContain("ses_b");
    writeFileSync(paths.stateFile, "not json", "utf8");
    const restored = new Store(paths.stateFile);
    expect(restored.byThread(10)).toBe("ses_a");
  });
});

describe("resolvePaths", () => {
  test("honours OCBRIDGE_CONFIG", () => {
    const previous = process.env.OCBRIDGE_CONFIG;
    const paths = tempPaths();
    process.env.OCBRIDGE_CONFIG = paths.configFile;
    try {
      const resolved = resolvePaths();
      expect(resolved.configFile).toBe(paths.configFile);
      expect(resolved.stateFile).toBe(join(dirname(paths.configFile), "state.json"));
    } finally {
      if (previous === undefined) delete process.env.OCBRIDGE_CONFIG;
      else process.env.OCBRIDGE_CONFIG = previous;
    }
  });
});
