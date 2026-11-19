import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transcribeAudio } from "../src/audio/transcribe.ts";
const file = join(process.env.TEMP ?? ".", "test-voice.ogg");
const result = await transcribeAudio(readFileSync(file), "ogg");
console.log(JSON.stringify(result));