// Prints and verifies the composed live-status block. Run: bun run scripts/status-check.ts
import { statusHtml, statusMarkdown, statusMarkdownList } from "../src/status.ts";
import { modelKey, sanitizeModelName, UNKNOWN_MODEL } from "../src/model.ts";

const snapshot = {
  model: "DeepSeek V4.1 Flash",
  phase: "thinking…",
  elapsed: "12s",
  tools: [
    { icon: "🛠", label: "tool Fix subagent live lines", code: true, duration: "1s", mark: "✓" },
    { icon: "💻", label: "bash npm *test*", code: true, duration: "3s", mark: "✗" },
  ],
  subagents: [{ icon: "🧩", label: "general", duration: "5s" }],
};

const path = "cd 'D:\\Home\\Mike\\Work\\Test\\opencode-telegram-bridge'";
const pathBlock = statusMarkdownList({
  model: "DeepSeek V4.1 Flash",
  phase: "thinking…",
  elapsed: "13s",
  tools: [{ icon: "💻", label: path, code: true, count: 2, duration: "13s" }],
  subagents: [],
});

const longPath = "cd 'D:\\Home\\Mike\\Work\\Test\\opencode-telegram-bridge\\very\\long\\nested\\folder\\name'";
const longBlock = statusMarkdownList({
  model: "DeepSeek V4.1 Flash",
  phase: "thinking…",
  elapsed: "20s",
  tools: [{ icon: "💻", label: longPath, code: true, duration: "20s" }],
  subagents: [],
});

const markdown = statusMarkdownList(snapshot);
const plain = statusMarkdown(snapshot);
const html = statusHtml(snapshot);

const literal = statusMarkdown({
  model: "OpenCode",
  phase: "thinking…",
  elapsed: "1s",
  tools: [],
  subagents: [],
});
const emptyModel = statusMarkdown({
  model: "",
  phase: "thinking…",
  elapsed: "1s",
  tools: [],
  subagents: [],
});
console.log("--- telegram markdown ---");
console.log(markdown);
console.log("-------------------------");
console.log("--- windows path ---");
console.log(pathBlock);
console.log("--- long path (truncated) ---");
console.log(longBlock);
console.log("--------------------");
console.log("--- html ---");
console.log(html);
console.log("------------");

const lines = markdown.split("\n");
const pathLine = pathBlock.split("\n")[1] ?? "";
const longLine = longBlock.split("\n")[1] ?? "";
const checks: Array<[string, boolean]> = [
  ["model + 2 tools + agent = 4 physical lines", lines.length === 4],
  ["model line is bold, only the model", lines[0] === "🟢 **DeepSeek V4.1 Flash** · thinking… 12s"],
  ["first tool is a bullet without literal 'tool'", lines[1] === "- 🛠 `Fix subagent live lines` · 1s ✓"],
  ["second tool keeps text, duration, mark", lines[2] === "- 💻 `bash npm *test*` · 3s ✗"],
  ["subagent is a bullet", lines[3] === "- 🧩 general · 5s"],
  ["every item starts with '- '", lines.slice(1).every((line) => line.startsWith("- "))],
  ["balanced emphasis", (markdown.match(/\*\*/g) ?? []).length === 2],
  ["discord layout has no bullets", plain.split("\n")[1] === "🛠 `Fix subagent live lines` · 1s ✓"],
  ["html uses <b> for the model", html.split("\n")[0] === "🟢 <b>DeepSeek V4.1 Flash</b> · thinking… 12s"],
  ["html has no literal **", !html.includes("**")],
  ["path keeps every backslash", pathLine === "- 💻 `cd 'D:\\Home\\Mike\\Work\\Test\\opencode-telegram-bridge'` ×2 · 13s"],
  ["path is wrapped in inline code", pathLine.startsWith("- 💻 `cd 'D:\\") && pathLine.includes("'` ×2")],
  ["long label is truncated with …", longLine.includes("very…`") && longLine.includes("· 20s")],
  ["truncation never drops backslashes", longLine.includes("D:\\Home\\Mike") && !/\\…/.test(longLine)],
  ["no mangled path (backslashes removed)", !longLine.includes("HomeMikeWork")],
  ["literal 'OpenCode' never rendered as a model", literal.startsWith("🟢 **unknown model**")],
  ["empty model falls back to 'unknown model'", emptyModel.startsWith("🟢 **unknown model**")],
  ["sanitize trims and rejects the product name", sanitizeModelName("  OpenCode Bridge ") === UNKNOWN_MODEL],
  ["sanitize keeps a real name", sanitizeModelName("DeepSeek V4.1 Flash") === "DeepSeek V4.1 Flash"],
  ["modelKey joins provider and id", modelKey({ providerID: "routerai", id: "deepseek/deepseek-v4.1-flash-1017" }) === "routerai/deepseek/deepseek-v4.1-flash-1017"],
  ["modelKey rejects a partial model", modelKey({ providerID: "routerai" }) === undefined],
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
