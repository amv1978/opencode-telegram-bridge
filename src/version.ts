import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Version single source: root `package.json`.
 *
 * The build script calls `syncVersions(root, true)` and then `checkVersions`
 * must be empty; a mismatch fails the release build instead of shipping a CLI or
 * installer that reports an older version.
 */
export interface VersionMismatch {
  file: string;
  expected: string;
  found: string;
}

interface Target {
  file: string;
  /** Captures the version in the first group (or `group`). */
  pattern: RegExp;
  replace: (version: string) => string;
  /** Extra check for tags that use a four-part version (`0.8.1.0`). */
  expected?: (version: string) => string;
  /** Match group that holds the version; 0 for lookbehind-only patterns. */
  group?: number;
}

function targets(root: string): Target[] {
  return [
    {
      file: join(root, "desktop", "package.json"),
      pattern: /"version"\s*:\s*"([^"]+)"/,
      replace: (version) => `"version": "${version}"`,
    },
    {
      file: join(root, "desktop", "package-lock.json"),
      pattern: /(?<="name":\s*"opencode-bridge-desktop",\s*"version":\s*")[^"]+/,
      replace: (version) => version,
      group: 0,
    },
    {
      file: join(root, "desktop", "package-lock.json"),
      pattern: /(?<="packages":\s*\{\s*"":\s*\{\s*"name":\s*"opencode-bridge-desktop",\s*"version":\s*")[^"]+/,
      replace: (version) => version,
      group: 0,
    },
    {
      file: join(root, "cli", "cli.csproj"),
      pattern: /<Version>([^<]+)<\/Version>/,
      replace: (version) => `<Version>${version}</Version>`,
    },
    {
      file: join(root, "cli", "cli.csproj"),
      pattern: /<FileVersion>([^<]+)<\/FileVersion>/,
      replace: (version) => `<FileVersion>${version}</FileVersion>`,
    },
    {
      file: join(root, "cli", "cli.csproj"),
      pattern: /<AssemblyVersion>([^<]+)<\/AssemblyVersion>/,
      replace: (version) => `<AssemblyVersion>${version}.0</AssemblyVersion>`,
      expected: (version) => `${version}.0`,
    },
    {
      file: join(root, "cli", "cli.csproj"),
      pattern: /<InformationalVersion>([^<]+)<\/InformationalVersion>/,
      replace: (version) => `<InformationalVersion>${version}</InformationalVersion>`,
    },
    {
      file: join(root, "cli", "Program.cs"),
      pattern: /public const string Version\s*=\s*"([^"]+)"/,
      replace: (version) => `public const string Version = "${version}"`,
    },
    {
      file: join(root, "installer", "ocbridge.iss"),
      pattern: /#define AppVersion\s+"([^"]+)"/,
      replace: (version) => `#define AppVersion "${version}"`,
    },
    {
      file: join(root, "installer", "ocbridge-lite.iss"),
      pattern: /#define AppVersion\s+"([^"]+)"/,
      replace: (version) => `#define AppVersion "${version}"`,
    },
  ];
}

export function readRootVersion(root: string): string {
  const text = readFileSync(join(root, "package.json"), "utf8");
  const match = /"version"\s*:\s*"([^"]+)"/.exec(text);
  if (!match?.[1]) throw new Error("package.json has no version");
  return match[1];
}

export function checkVersions(root: string): VersionMismatch[] {
  const expected = readRootVersion(root);
  const mismatches: VersionMismatch[] = [];
  for (const target of targets(root)) {
    if (!existsSync(target.file)) continue;
    const text = readFileSync(target.file, "utf8");
    const match = target.pattern.exec(text);
    const found = match?.[target.group ?? 1];
    if (!found) {
      mismatches.push({ file: target.file, expected, found: "(missing)" });
      continue;
    }
    const wanted = target.expected ? target.expected(expected) : expected;
    if (found !== wanted) {
      mismatches.push({ file: target.file, expected: wanted, found });
    }
  }
  return mismatches;
}

/** Rewrites every target from the root version; returns the files touched. */
export function syncVersions(root: string, write = false): string[] {
  const version = readRootVersion(root);
  const touched: string[] = [];
  for (const target of targets(root)) {
    if (!existsSync(target.file)) continue;
    const text = readFileSync(target.file, "utf8");
    const match = target.pattern.exec(text);
    if (!match) continue;
    const found = match[target.group ?? 1];
    const wanted = target.expected ? target.expected(version) : version;
    if (found === wanted) continue;
    const replaced = text.replace(target.pattern, target.replace(version));
    if (write) writeFileSync(target.file, replaced, "utf8");
    touched.push(target.file);
  }
  return touched;
}
