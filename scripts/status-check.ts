// Prints and verifies the composed live-status block. Run: bun run scripts/status-check.ts
import { statusHtml, statusMarkdown, statusMarkdownList } from "../src/status.ts";

const snapshot = {
  model: "DeepSeek V4.1 Flash",
  phase: "thinking…",
  elapsed: "12s",
  tools: [
    { icon: "🛠", label: "tool Fix subagent live lines", duration: "1s", mark: "✓" },
    { icon: "💻", label: "bash npm *test*", duration: "3s", mark: "✗" },
  ],
  subagents: [{ icon: "🧩", label: "general", duration: "5s" }],
};

const markdown = statusMarkdownList(snapshot);
const plain = statusMarkdown(snapshot);
const html = statusHtml(snapshot);
console.log("--- telegram markdown ---");
console.log(markdown);
console.log("-------------------------");
console.log("--- html ---");
console.log(html);
console.log("------------");

const lines = markdown.split("\n");
const checks: Array<[string, boolean]> = [
  ["model + 2 tools + agent = 4 physical lines", lines.length === 4],
  ["model line is bold, only the model", lines[0] === "🟢 **DeepSeek V4.1 Flash** · thinking… 12s"],
  ["first tool is a bullet without literal 'tool'", lines[1] === "- 🛠 Fix subagent live lines · 1s ✓"],
  ["second tool keeps icon, duration, mark, sanitized", lines[2] === "- 💻 bash npm test · 3s ✗"],
  ["subagent is a bullet", lines[3] === "- 🧩 general · 5s"],
  ["every item starts with '- '", lines.slice(1).every((line) => line.startsWith("- "))],
  ["balanced emphasis", (markdown.match(/\*\*/g) ?? []).length === 2],
  ["discord layout has no bullets", plain.split("\n")[1] === "🛠 Fix subagent live lines · 1s ✓"],
  ["html uses <b> for the model", html.split("\n")[0] === "🟢 <b>DeepSeek V4.1 Flash</b> · thinking… 12s"],
  ["html has no literal **", !html.includes("**")],
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
console.log("\nAll status checks passed.");
