// Unit-style check for the Telegram photo/document relay path.
// Run: bun run scripts/telegram-photo-check.ts
import { promptFilesFromMedia } from "../src/media/relay.ts";
import { telegramMediaItems } from "../src/telegram/bot.ts";

const photoMessage = { photo: [{ file_size: 1234 }], caption: "тест картинка из телеги" };
const documentMessage = { document: { mime_type: "application/pdf", file_name: "report.pdf" } };

const photoItems = telegramMediaItems(photoMessage, Buffer.from("fake-image-bytes"));
const documentItems = telegramMediaItems(documentMessage, Buffer.from("fake-pdf-bytes"));
const files = promptFilesFromMedia(photoItems);

const checks: Array<[string, boolean]> = [
  ["photo produces exactly one MediaItem", photoItems.length === 1],
  ["photo item has bytes, mime and name", Boolean(photoItems[0]?.buffer?.length) && Boolean(photoItems[0]?.mime) && Boolean(photoItems[0]?.name)],
  ["photo prompt payload has files[0].uri", (files[0]?.uri ?? "").startsWith("data:image/jpeg;base64,")],
  ["document goes through the same path", documentItems.length === 1],
  ["document keeps its name and mime", documentItems[0]?.name === "report.pdf" && documentItems[0]?.mime === "application/pdf"],
  ["document prompt uri is a data URI", (promptFilesFromMedia(documentItems)[0]?.uri ?? "").startsWith("data:application/pdf;base64,")],
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
console.log("\nAll Telegram photo relay checks passed.");
