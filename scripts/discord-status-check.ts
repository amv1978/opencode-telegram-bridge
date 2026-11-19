// Simulates three Discord status ticks and asserts elapsed values change.
// Run: bun run scripts/discord-status-check.ts
import { statusMarkdown } from "../src/status.ts";
import { formatDuration } from "../src/discord/render.ts";

const startedAt = 1_000_000;
const TICK_MS = 2_500;
const elapsed: string[] = [];

for (let tick = 1; tick <= 3; tick += 1) {
  const now = startedAt + tick * TICK_MS;
  const duration = formatDuration(now - startedAt);
  elapsed.push(duration);
  const text = statusMarkdown({
    model: "DeepSeek V4.1 Flash",
    phase: "subagents…",
    elapsed: duration,
    tools: [{ icon: "🛠", label: "Wait one minute test 2", duration: "1s", mark: "✓" }],
    subagents: [{ icon: "🧩", label: "general", duration }],
  });
  console.log(`--- tick ${tick} (+${tick * TICK_MS} ms) ---`);
  console.log(text);
}

const checks: Array<[string, boolean]> = [
  ["three ticks produced three distinct values", new Set(elapsed).size === 3],
  ["elapsed grows 3s → 5s → 8s", elapsed.join(",") === "3s,5s,8s"],
  ["final tick shows 8s", elapsed[2] === "8s"],
];

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed += 1;
}
if (failed) {
  console.error(`\n${failed} checks failed`);
  process.exit(1);
}
console.log("\nAll Discord status tick checks passed.");
