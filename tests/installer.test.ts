import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyInstallerOverrides, loadConfig, saveConfig, type Paths } from "../src/config.ts";
import {
  installerDefaults,
  parseInstallerState,
  readInstallerState,
  rememberedChoices,
  writeInstallerState,
} from "../src/installer.ts";

function tempPaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-installer-"));
  return { configFile: join(dir, "config.json"), stateFile: join(dir, "state.json"), logFile: join(dir, "bridge.log") };
}

const installerFile = (paths: Paths): string => join(dirname(paths.configFile), "installer.json");

describe("installer.json persistence", () => {
  test("keeps every wizard choice across a re-run", () => {
    const paths = tempPaths();
    const file = installerFile(paths);
    writeInstallerState(file, {
      version: "0.8.0",
      installKind: "advanced",
      directory: "C:\\Apps\\Bridge",
      autostart: true,
      language: "ru",
      mode: "topics",
      defaultDirectory: "D:\\Work",
      topicsChatId: -1001234567890,
    });

    const restored = readInstallerState(file);
    expect(restored).toBeDefined();
    expect(rememberedChoices(restored)).toEqual({
      installKind: "advanced",
      directory: "C:\\Apps\\Bridge",
      autostart: true,
      language: "ru",
      mode: "topics",
      defaultDirectory: "D:\\Work",
      topicsChatId: -1001234567890,
    });
    expect(installerDefaults(restored)).toEqual({
      mode: "topics",
      defaultDirectory: "D:\\Work",
      topicsChatId: -1001234567890,
      lang: "ru",
    });
  });

  test("preserves unknown keys and tolerates junk", () => {
    const paths = tempPaths();
    const file = installerFile(paths);
    writeFileSync(file, JSON.stringify({ installKind: "simple", custom: "keep-me", language: "xx" }), "utf8");
    writeInstallerState(file, { autostart: false });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.installKind).toBe("simple");
    expect(raw.custom).toBe("keep-me");
    expect(raw.autostart).toBe(false);
    expect(readInstallerState(file)?.language).toBeUndefined();

    writeFileSync(file, "{ broken", "utf8");
    expect(readInstallerState(file)).toBeUndefined();
    expect(parseInstallerState(null)).toBeUndefined();
  });

  test("merges one-shot overrides once and keeps install metadata", () => {
    const paths = tempPaths();
    const cfg = loadConfig(paths);
    saveConfig(paths, cfg);
    const file = installerFile(paths);
    writeInstallerState(file, {
      installKind: "advanced",
      directory: "C:\\Apps\\Bridge",
      autostart: true,
      language: "ru",
      mode: "both",
      configOnlyIfNew: false,
      config: {
        telegramToken: "123:secret",
        mode: "private",
        defaultDirectory: "D:\\Projects",
        lang: "ru",
        topicsChatId: -100777,
      },
    });

    const fresh = loadConfig(paths);
    expect(applyInstallerOverrides(paths, fresh, true)).toBe(true);
    expect(fresh.telegram.token).toBe("123:secret");
    expect(fresh.mode).toBe("private");
    expect(fresh.defaultDirectory).toBe("D:\\Projects");
    expect(fresh.ui?.lang).toBe("ru");
    expect(fresh.topicsChatId).toBe(-100777);

    const kept = readInstallerState(file);
    expect(kept?.installKind).toBe("advanced");
    expect(kept?.directory).toBe("C:\\Apps\\Bridge");
    expect(kept?.autostart).toBe(true);
    expect(kept?.language).toBe("ru");
    expect(kept?.topicsChatId).toBe(-100777);
    expect(kept?.config).toBeUndefined();
    expect(kept?.configAppliedAt).toBeTruthy();

    // A second run has nothing left to apply.
    expect(applyInstallerOverrides(paths, fresh, true)).toBe(false);
  });

  test("configOnlyIfNew never overwrites an existing config", () => {
    const paths = tempPaths();
    const cfg = loadConfig(paths);
    cfg.telegram.token = "existing";
    saveConfig(paths, cfg);
    writeInstallerState(installerFile(paths), {
      installKind: "simple",
      configOnlyIfNew: true,
      config: { telegramToken: "should-not-apply", lang: "en" },
    });

    const loaded = loadConfig(paths);
    expect(applyInstallerOverrides(paths, loaded, true)).toBe(false);
    expect(loaded.telegram.token).toBe("existing");
  });

  test("remembered choices seed a brand-new config", () => {
    const paths = tempPaths();
    expect(existsSync(paths.configFile)).toBe(false);
    writeInstallerState(installerFile(paths), {
      installKind: "advanced",
      mode: "topics",
      defaultDirectory: "D:\\Keep",
      topicsChatId: -100555,
      language: "en",
    });
    const cfg = loadConfig(paths);
    applyInstallerOverrides(paths, cfg, false);
    expect(cfg.mode).toBe("topics");
    expect(cfg.defaultDirectory).toBe("D:\\Keep");
    expect(cfg.topicsChatId).toBe(-100555);
    expect(cfg.ui?.lang).toBe("en");
  });
});
