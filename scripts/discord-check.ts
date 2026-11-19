// Sanity checks for the Discord renderer. Run: bun run scripts/discord-check.ts
import { italicLine, quoteBlock } from "../src/discord/render.ts";

const text = "привет\n\nвторая строка\n> уже цитата";
const block = quoteBlock("💠 **Расшифровка · голос**", text, "⏱ 4.2 с");
const lines = block.split("\n");

const checks: Array<[string, boolean]> = [
  ["header quoted once", lines[0] === "> 💠 **Расшифровка · голос**"],
  ["blank quote line has no trailing space", lines[1] === ">"],
  ["blank body line is bare >", lines[3] === ">"],
  ["content line quoted", lines[2] === "> привет" && lines[4] === "> вторая строка"],
  ["pre-quoted input not wrapped twice", block.includes("> уже цитата") && !block.includes("> > ")],
  ["no double quote anywhere", !/> >/.test(block)],
  ["footer quoted", lines[lines.length - 1] === "> ⏱ 4.2 с"],
  ["only quote markers at line start", lines.every((line) => !/^>\s?>/.test(line))],
  ["italic ok", italicLine("DeepSeek V4.1 Flash · ⏱ 4s · ⚡ 139.9 tok/s · 🧠 565k") === "_DeepSeek V4.1 Flash · ⏱ 4s · ⚡ 139.9 tok/s · 🧠 565k_"],
  ["italic fallback on underscore", italicLine("my_model · ⏱ 4s") === "my_model · ⏱ 4s"],
];

console.log("--- block ---\n" + block + "\n-------------");
for (const [name, pass] of checks) console.log(`${pass ? "✔" : "✖"} ${name}`);
const failed = checks.filter(([, pass]) => !pass).length;
if (failed) {
  console.error(`\n${failed} checks failed`);
  process.exit(1);
}
console.log("\nAll Discord renderer checks passed.");
