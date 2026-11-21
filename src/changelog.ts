import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareVersions } from "./updater.ts";

export interface ChangelogSection {
  version: string;
  heading: string;
  body: string;
}

let cache: { path: string; mtimeMs: number; sections: ChangelogSection[] } | undefined;

function changelogPath(): string {
  const candidates = [join(dirname(process.execPath), "CHANGELOG.md"), join(process.cwd(), "CHANGELOG.md")];
  return candidates.find((file) => existsSync(file)) ?? candidates[0]!;
}

/** Parses `## 1.2.3 — date` blocks from CHANGELOG.md. */
export function changelogSections(): ChangelogSection[] {
  const file = changelogPath();
  try {
    const stat = statSync(file);
    if (cache && cache.path === file && cache.mtimeMs === stat.mtimeMs) return cache.sections;
    const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    const sections: ChangelogSection[] = [];
    const lines = text.split("\n");
    let current: ChangelogSection | undefined;
    for (const line of lines) {
      const match = /^##\s+(?:v)?([0-9][0-9A-Za-z.+-]*)\b(.*)$/.exec(line);
      if (match) {
        if (current) sections.push(current);
        current = { version: match[1]!, heading: line.trim(), body: "" };
        continue;
      }
      if (!current) continue;
      if (/^#\s+/.test(line)) break;
      current.body += `${line}\n`;
    }
    if (current) sections.push(current);
    const clean = sections.map((section) => ({ ...section, body: section.body.trim() }));
    cache = { path: file, mtimeMs: stat.mtimeMs, sections: clean };
    return clean;
  } catch {
    return [];
  }
}

/** Sections in `(from, to]`, newest first. Empty `from` means "only `to`". */
export function changelogBetween(from: string | undefined, to: string): ChangelogSection[] {
  return changelogSections()
    .filter((section) => {
      if (!from) return compareVersions(section.version, to) === 0;
      return compareVersions(section.version, from) > 0 && compareVersions(section.version, to) <= 0;
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}
