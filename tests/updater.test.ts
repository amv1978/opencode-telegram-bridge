import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyScript, rollbackScript, sha256File, Updater } from "../src/updater.ts";

const winTest = process.platform === "win32" ? test : test.skip;

/** Minimal app dir + bundle zip, exactly what the installer helper would move. */
function fixture(version: string): { app: string; updateDir: string; zip: string; configText: string } {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-update-test-"));
  const app = join(root, "app");
  const updateDir = join(root, "update");
  const payload = join(root, "payload");
  mkdirSync(app, { recursive: true });
  mkdirSync(updateDir, { recursive: true });
  mkdirSync(payload, { recursive: true });

  const configText = JSON.stringify(
    {
      telegram: { token: "123:secret", enabled: true, proxy: "socks5://127.0.0.1:1080" },
      discord: { enabled: true, token: "discord-secret" },
      mode: "both",
    },
    null,
    2,
  );
  writeFileSync(join(app, "config.json"), configText, "utf8");
  writeFileSync(join(payload, "ocbridge.exe"), "fake-binary", "utf8");
  writeFileSync(join(payload, "version.json"), JSON.stringify({ version }), "utf8");

  const zip = join(updateDir, "bundle.zip");
  const result = spawnSync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Compress-Archive -Path '${payload}\\*' -DestinationPath '${zip}' -Force`,
  ], { windowsHide: true });
  if (!existsSync(zip)) throw new Error(`zip not created: ${String(result.stderr)}`);
  return { app, updateDir, zip, configText };
}

describe("updater helpers", () => {
  test("sha256File matches a one-shot digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocbridge-sha-"));
    const file = join(dir, "blob.bin");
    writeFileSync(file, "hello bundle");
    const expected = createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(await sha256File(file)).toBe(expected);
  });

  test("apply and rollback scripts move only installed items, never config", () => {
    const apply = applyScript({
      app: "C:\\Apps\\Bridge",
      next: "C:\\Apps\\Bridge\\new",
      prev: "C:\\Apps\\Bridge\\prev",
      port: 7789,
      items: ["ocbridge.exe", "desktop", "version.json"],
      healthSeconds: 60,
    });
    expect(apply).toContain("$Port = 7789");
    expect(apply).toContain("127.0.0.1:$Port/api/state");
    expect(apply).not.toContain("config.json");
    expect(apply).not.toContain("state.json");

    const rollback = rollbackScript({
      app: "C:\\Apps\\Bridge",
      prev: "C:\\Apps\\Bridge\\prev",
      port: 7790,
      items: ["ocbridge.exe"],
      healthSeconds: 30,
    });
    expect(rollback).toContain("$Port = 7790");
    expect(rollback).not.toContain("config.json");
  });
});

describe("updater state", () => {
  test("a verified bundle on disk is reported as verified after restart", async () => {
    const { updateDir, zip, app } = fixture("0.8.4");
    const sha = await sha256File(zip);
    writeFileSync(join(updateDir, "bundle.meta.json"), JSON.stringify({ version: "0.8.4", sha256: sha }), "utf8");

    const updater = new Updater({
      packaged: true,
      dataDir: app,
      installDir: app,
      updateDir,
      currentVersion: "0.8.3",
    });
    updater.restore({ latest: "0.8.4", available: true, bundled: true }, "0.8.3");
    const snapshot = updater.snapshot();
    expect(snapshot.verified).toBe(true);
    expect(snapshot.progress).toBe(100);
    expect(snapshot.latest).toBe("0.8.4");
  });

  test("a bundle for another version is not treated as verified", async () => {
    const { updateDir, zip, app } = fixture("0.8.1");
    const sha = await sha256File(zip);
    writeFileSync(join(updateDir, "bundle.meta.json"), JSON.stringify({ version: "0.8.1", sha256: sha }), "utf8");

    const updater = new Updater({
      packaged: true,
      dataDir: app,
      installDir: app,
      updateDir,
      currentVersion: "0.8.3",
    });
    updater.restore({ latest: "0.8.4", available: true }, undefined);
    expect(updater.snapshot().verified).toBe(false);
  });

  test("dev builds report a clear reason instead of downloading", async () => {
    const updater = new Updater({
      packaged: false,
      dataDir: mkdtempSync(join(tmpdir(), "ocbridge-dev-")),
      currentVersion: "0.8.3",
      updateDir: mkdtempSync(join(tmpdir(), "ocbridge-dev-update-")),
    });
    const snapshot = await updater.download();
    expect(snapshot.errorCode).toBe("dev");
    expect(snapshot.error).toContain("собранной версии");
    expect(snapshot.downloading).toBe(false);
  });
});

describe("update keeps user config", () => {
  winTest("install unpacks the bundle and leaves config.json untouched", async () => {
    const { updateDir, zip, app, configText } = fixture("0.8.4");
    const sha = await sha256File(zip);
    writeFileSync(join(updateDir, "bundle.meta.json"), JSON.stringify({ version: "0.8.4", sha256: sha }), "utf8");

    let helperScript = "";
    let notified = "";
    const updater = new Updater({
      packaged: true,
      dataDir: app,
      installDir: app,
      updateDir,
      currentVersion: "0.8.3",
      fetch: () => globalThis.fetch,
      onBeforeInstall: () => undefined,
      notify: (text) => {
        notified = text;
      },
      launchHelper: (script) => {
        helperScript = script;
      },
      exit: () => undefined,
      sleep: async () => undefined,
    });
    updater.restore({ latest: "0.8.4", available: true, bundled: true }, "0.8.3");

    const result = await updater.install();
    expect(result.error).toBe("");
    expect(result.installing).toBe(true);
    expect(notified).toContain("0.8.3");
    expect(notified).toContain("0.8.4");
    expect(helperScript).toContain("apply-update.ps1");

    // Payload is staged next to the app, not applied by the test.
    expect(existsSync(join(app, "new", "ocbridge.exe"))).toBe(true);

    // The whole point: telegram/discord settings survive an update run.
    const after = readFileSync(join(app, "config.json"), "utf8");
    expect(after).toBe(configText);
    const parsed = JSON.parse(after);
    expect(parsed.telegram.token).toBe("123:secret");
    expect(parsed.telegram.proxy).toBe("socks5://127.0.0.1:1080");
    expect(parsed.discord.enabled).toBe(true);
    expect(parsed.discord.token).toBe("discord-secret");
  });
});
