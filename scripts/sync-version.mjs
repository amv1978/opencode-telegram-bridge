import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersions, syncVersions } from "../src/version.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

if (!checkOnly) {
  const touched = syncVersions(root, true);
  for (const file of touched) console.log(`version: synced ${file}`);
}

const mismatches = checkVersions(root);
if (mismatches.length) {
  for (const item of mismatches) {
    console.error(`version mismatch: ${item.file}: expected ${item.expected}, found ${item.found}`);
  }
  process.exit(1);
}
console.log("version: all targets match package.json");
