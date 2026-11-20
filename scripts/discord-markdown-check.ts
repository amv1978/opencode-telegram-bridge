// Checks for Discord Markdown conversion. Run: bun run scripts/discord-markdown-check.ts
import { DISCORD_CHUNK, chunkText, toDiscordMarkdown } from "../src/discord/render.ts";

const cases: Array<{ name: string; input: string; expected: string }> = [
  {
    name: "simple table",
    input: ["| A | B |", "|---|---|", "| 1 | 22 |"].join("\n"),
    expected: ["```", "| A   | B   |", "| --- | --- |", "| 1   | 22  |", "```"].join("\n"),
  },
  {
    name: "table inside text",
    input: [
      "До:",
      "",
      "| Name | Value |",
      "|:-----|------:|",
      "| a | 42 |",
      "| bb | 7 |",
      "",
      "После.",
    ].join("\n"),
    expected: [
      "До:",
      "",
      "```",
      "| Name | Value |",
      "| ---- | ----- |",
      "| a    | 42    |",
      "| bb   | 7     |",
      "```",
      "",
      "После.",
    ].join("\n"),
  },
  {
    name: "code fence with pipes",
    input: ["```md", "| A | B |", "|---|---|", "| 1 | 2 |", "```", "After."].join("\n"),
    expected: ["```md", "| A | B |", "|---|---|", "| 1 | 2 |", "```", "After."].join("\n"),
  },
  {
    name: "headings 4-6",
    input: ["# One", "## Two", "### Three", "#### Four", "##### Five", "###### Six"].join("\n"),
    expected: ["# One", "## Two", "### Three", "**Four**", "**Five**", "**Six**"].join("\n"),
  },
  {
    name: "wide table becomes a list",
    input: ["| A | B | C | D | E |", "|---|---|---|---|---|", "| 1 | 2 | 3 | 4 | 5 |"].join("\n"),
    expected: ["**A · B · C · D · E**", "- A: 1 · B: 2 · C: 3 · D: 4 · E: 5"].join("\n"),
  },
  {
    name: "long table becomes a list",
    input: [
      "| Component | Owner | Description |",
      "|---|---|---|",
      "| media-relay-worker | platform-team | Handles every attachment relayed between bound chats |",
    ].join("\n"),
    expected: [
      "**Component · Owner · Description**",
      "- Component: media-relay-worker · Owner: platform-team · Description: Handles every attachment relayed between bound chats",
    ].join("\n"),
  },
];

let failed = 0;

for (const testCase of cases) {
  const actual = toDiscordMarkdown(testCase.input);
  const pass = actual === testCase.expected;
  if (!pass) {
    failed += 1;
    console.error(`✗ ${testCase.name}`);
    console.error(`  expected:\n${indent(testCase.expected)}`);
    console.error(`  actual:\n${indent(actual)}`);
  } else {
    console.log(`✓ ${testCase.name}`);
  }
}

// Chunker: a wrapped table must stay intact inside one chunk when it fits, and
// a long fenced block must never be split without closing/reopening the fence.
const table = toDiscordMarkdown(
  ["| Col A | Col B |", "|-------|-------|", ...Array.from({ length: 20 }, (_, i) => `| ${i} | value ${i} |`)].join(
    "\n",
  ),
);
const tableChunks = chunkText(table);
if (tableChunks.length !== 1) {
  failed += 1;
  console.error(`✗ table fits in one chunk (got ${tableChunks.length})`);
} else {
  console.log("✓ table fits in one chunk");
}

const longFence = ["```ts", ...Array.from({ length: 120 }, (_, i) => `const line${i} = "value ${i}";`), "```"].join("\n");
const fenceChunks = chunkText(longFence);
const fenceOk =
  fenceChunks.length > 1 &&
  fenceChunks.every((chunk) => chunk.length <= DISCORD_CHUNK && countFences(chunk) % 2 === 0);
if (!fenceOk) {
  failed += 1;
  console.error(`✗ long fence chunking (${fenceChunks.length} chunks):`);
  for (const chunk of fenceChunks) console.error(`  ${chunk.length} chars, fences=${countFences(chunk)}`);
} else {
  console.log(`✓ long fence chunking (${fenceChunks.length} chunks, ≤${DISCORD_CHUNK} chars each)`);
}

if (failed) {
  console.error(`\n${failed} checks failed`);
  process.exit(1);
}
console.log("\nAll Discord Markdown checks passed.");

function countFences(text: string): number {
  return text.split("\n").filter((line) => /^\s{0,3}(`{3,}|~{3,})/.test(line)).length;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
