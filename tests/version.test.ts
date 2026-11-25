import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkVersions, readRootVersion, syncVersions } from "../src/version.ts";

function fixture(version: string): string {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-version-"));
  mkdirSync(join(root, "desktop"), { recursive: true });
  mkdirSync(join(root, "cli"), { recursive: true });
  mkdirSync(join(root, "installer"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }, null, 2));
  writeFileSync(join(root, "desktop", "package.json"), JSON.stringify({ version }, null, 2));
  writeFileSync(
    join(root, "cli", "cli.csproj"),
    `<Project><Version>${version}</Version><FileVersion>${version}</FileVersion><AssemblyVersion>${version}.0</AssemblyVersion><InformationalVersion>${version}</InformationalVersion></Project>`,
  );
  writeFileSync(join(root, "cli", "Program.cs"), `public const string Version = "${version}";`);
  writeFileSync(join(root, "installer", "ocbridge.iss"), `#define AppVersion "${version}"`);
  writeFileSync(join(root, "installer", "ocbridge-lite.iss"), `#define AppVersion "${version}"`);
  return root;
}

describe("version single source", () => {
  test("root package.json is the version", () => {
    const root = fixture("9.9.9");
    expect(readRootVersion(root)).toBe("9.9.9");
    expect(checkVersions(root)).toEqual([]);
  });

  test("sync copies the root version into every target", () => {
    const root = fixture("1.0.0");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.0.0" }));
    expect(checkVersions(root).length).toBeGreaterThan(0);
    syncVersions(root, true);
    expect(checkVersions(root)).toEqual([]);
    expect(readRootVersion(root)).toBe("2.0.0");
  });

  test("the repository is in sync", () => {
    const root = resolve(import.meta.dir, "..");
    expect(checkVersions(root)).toEqual([]);
  });
});
