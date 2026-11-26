// Fails when the client-side script inside the PAGE template is not valid JS.
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/web/ui.ts", import.meta.url), "utf8");
const match = source.match(/<script>([\s\S]*)<\/script>/);
if (!match) {
  console.error("no <script> block found");
  process.exit(1);
}
try {
  new Function(match[1]);
  console.log("ui client script: OK");
} catch (error) {
  console.error("ui client script: " + error.message);
  process.exit(1);
}
