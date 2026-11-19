// Sanity checks for the Telegram HTML renderer. Run: bun run scripts/render-check.ts
import { markdownToHtml, splitHtml, stripHtml } from "../src/telegram/render.ts";

const sample = [
  "## Заголовок",
  "",
  "Текст с **жирным**, *курсивом*, `inline code` и ~~зачёркнутым~~.",
  "",
  "- пункт один",
  "- пункт два",
  "",
  "> цитата",
  "",
  "```ts",
  "const x = 1 < 2 && 3 > 2;",
  "console.log(`hi ${x}`);",
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "Ссылка: [пример](https://example.com)",
  "",
  "---",
].join("\n");

const html = markdownToHtml(sample);
console.log("--- html ---\n" + html + "\n-----------");

const checks: Array<[string, boolean]> = [
  ["bold", html.includes("<b>жирным</b>")],
  ["italic", html.includes("<i>курсивом</i>")],
  ["inline code", html.includes("<code>inline code</code>")],
  ["strike", html.includes("<s>зачёркнутым</s>")],
  ["heading", html.includes("<b>Заголовок</b>")],
  ["list bullet", html.includes("• пункт один")],
  ["quote", html.includes("▎ цитата")],
  ["code lang", html.includes('<code class="language-ts">')],
  ["escaped code", html.includes("1 &lt; 2 &amp;&amp; 3 &gt; 2")],
  ["table", html.includes("<pre>| a | b |")],
  ["link", html.includes('<a href="https://example.com">пример</a>')],
  ["hr", html.includes("──────────")],
];

const long = Array.from({ length: 400 }, (_, i) => `строка ${i} с текстом **важно**`).join("\n");
const longHtml = markdownToHtml(long) + "\n\n```ts\n" + "x".repeat(9000) + "\n```";
const chunks = splitHtml(longHtml, 3800);
const balanced = chunks.every((c) => (c.match(/<pre/g) ?? []).length === (c.match(/<\/pre>/g) ?? []).length);
const sizes = chunks.map((c) => c.length);

console.log(`\nchunks=${chunks.length} max=${Math.max(...sizes)} balancedPre=${balanced}`);
console.log(`stripHtml ok=${!stripHtml(html).includes("<b>")}`);

for (const [name, pass] of checks) console.log(`${pass ? "✔" : "✖"} ${name}`);
const failed = checks.filter(([, pass]) => !pass).length;
if (failed || !balanced || Math.max(...sizes) > 3800) {
  console.error(`\n${failed} checks failed`);
  process.exit(1);
}
console.log("\nAll renderer checks passed.");
