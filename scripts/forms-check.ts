// Sanity checks for chat form rendering helpers. Run: bun run scripts/forms-check.ts
import {
  activeFields,
  buildAnswer,
  defaultValues,
  fieldHint,
  fieldWidget,
  FORM_TTL_MS,
  isChatRenderable,
  nextField,
  parseText,
  summarize,
  type FormInfo,
} from "../src/forms.ts";

const form: FormInfo = {
  id: "frm_test",
  sessionID: "ses_test",
  title: "Which approach?",
  metadata: { kind: "question", message: "Pick one and add tags" },
  fields: [
    {
      key: "choice",
      type: "string",
      title: "Pick one",
      required: true,
      custom: true,
      options: [
        { value: "a", label: "Option A", description: "first" },
        { value: "b", label: "Option B" },
      ],
    },
    {
      key: "tags",
      type: "multiselect",
      title: "Tags",
      options: [
        { value: "x", label: "X" },
        { value: "y", label: "Y" },
      ],
      minItems: 1,
      maxItems: 2,
    },
    { key: "flag", type: "boolean", title: "Enable it", default: true },
    { key: "count", type: "integer", title: "Count", minimum: 1, maximum: 5, default: 2 },
    { key: "secret", type: "string", title: "Hidden", hidden: true },
    {
      key: "later",
      type: "string",
      title: "Only with flag off",
      when: [{ key: "flag", op: "eq", value: false }],
    },
  ],
};

const checks: Array<[string, boolean]> = [];
const defaults = defaultValues(form);
const initial = activeFields(form, defaults);
checks.push(["hidden excluded", !initial.some((field) => field.key === "secret")]);
checks.push(["when excluded", !initial.some((field) => field.key === "later")]);
checks.push(["defaults prefilled", defaults.flag === true && defaults.count === 2]);
checks.push(["first unanswered", nextField(initial, defaults, new Set())?.key === "choice"]);
checks.push(["widgets", fieldWidget(form.fields[0]!) === "choice" && fieldWidget(form.fields[1]!) === "multi"]);
checks.push(["hint", fieldHint(form.fields[1]!).includes("1")]);

const missing = buildAnswer(initial, defaults);
checks.push(["required enforced", !missing.answer && Boolean(missing.error)]);

const invalid = buildAnswer(initial, { ...defaults, choice: "a", tags: [] });
checks.push(["minItems enforced", !invalid.answer && Boolean(invalid.error)]);

const accepted = buildAnswer(initial, { ...defaults, choice: "custom words", tags: ["x", "y"] });
checks.push([
  "typed answer",
  accepted.answer?.choice === "custom words" &&
    Array.isArray(accepted.answer?.tags) &&
    accepted.answer?.flag === true &&
    accepted.answer?.count === 2,
]);

const rows = summarize(form, accepted.answer ?? {});
checks.push(["labels in summary", rows.some((row) => row.startsWith("Pick one: custom words"))]);

checks.push(["integer parse", parseText(form.fields[3]!, "3").value === 3]);
checks.push(["integer rejects fraction", Boolean(parseText(form.fields[3]!, "2.5").error)]);
checks.push(["integer range", Boolean(parseText(form.fields[3]!, "9").error)]);
checks.push(["text trim", parseText(form.fields[0]!, "  hi  ").value === "hi"]);
checks.push(["ttl 15 min", FORM_TTL_MS === 15 * 60 * 1000]);
checks.push(["renderable", isChatRenderable(form)]);
checks.push(["external-only not renderable", !isChatRenderable({
  id: "frm_x",
  sessionID: "ses_x",
  title: "OAuth",
  fields: [{ key: "oauth", type: "external", url: "https://example.com", title: "Connect" }],
})]);

const flagged = activeFields(form, { ...defaults, flag: false });
checks.push(["when enabled", flagged.some((field) => field.key === "later")]);

for (const [name, pass] of checks) console.log(`${pass ? "✔" : "✖"} ${name}`);
const failed = checks.filter(([, pass]) => !pass).length;
if (failed) {
  console.error(`\n${failed} checks failed`);
  process.exit(1);
}
console.log("\nAll form checks passed.");
