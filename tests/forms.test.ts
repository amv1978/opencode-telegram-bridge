import { describe, expect, test } from "bun:test";
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
    { key: "later", type: "string", title: "Only with flag off", when: [{ key: "flag", op: "eq", value: false }] },
  ],
};

describe("form fields", () => {
  const defaults = defaultValues(form);
  const initial = activeFields(form, defaults);

  test("hidden and when-gated fields are excluded", () => {
    expect(initial.some((field) => field.key === "secret")).toBe(false);
    expect(initial.some((field) => field.key === "later")).toBe(false);
    expect(activeFields(form, { ...defaults, flag: false }).some((field) => field.key === "later")).toBe(true);
  });

  test("defaults prefill and navigation picks the first unanswered field", () => {
    expect(defaults.flag).toBe(true);
    expect(defaults.count).toBe(2);
    expect(nextField(initial, defaults, new Set())?.key).toBe("choice");
  });

  test("widgets and hints match the field type", () => {
    expect(fieldWidget(form.fields[0]!)).toBe("choice");
    expect(fieldWidget(form.fields[1]!)).toBe("multi");
    expect(fieldWidget(form.fields[2]!)).toBe("flag");
    expect(fieldHint(form.fields[1]!)).toContain("1");
  });
});

describe("answers", () => {
  const defaults = defaultValues(form);
  const initial = activeFields(form, defaults);

  test("required and minItems are enforced before the API call", () => {
    expect(buildAnswer(initial, defaults).answer).toBeUndefined();
    expect(buildAnswer(initial, { ...defaults, choice: "a", tags: [] }).answer).toBeUndefined();
  });

  test("typed values survive and labels appear in the summary", () => {
    const { answer } = buildAnswer(initial, { ...defaults, choice: "custom words", tags: ["x", "y"] });
    expect(answer).toEqual({ choice: "custom words", tags: ["x", "y"], flag: true, count: 2 });
    const rows = summarize(form, answer ?? {});
    expect(rows.some((row) => row.startsWith("Pick one: custom words"))).toBe(true);
  });

  test("text parsing validates numbers and trims strings", () => {
    expect(parseText(form.fields[3]!, "3").value).toBe(3);
    expect(parseText(form.fields[3]!, "2.5").error).toBeTruthy();
    expect(parseText(form.fields[3]!, "9").error).toBeTruthy();
    expect(parseText(form.fields[0]!, "  hi  ").value).toBe("hi");
  });

  test("TTL is 15 minutes and external-only forms are skipped", () => {
    expect(FORM_TTL_MS).toBe(15 * 60 * 1000);
    expect(isChatRenderable(form)).toBe(true);
    expect(
      isChatRenderable({
        id: "frm_x",
        sessionID: "ses_x",
        title: "OAuth",
        fields: [{ key: "oauth", type: "external", url: "https://example.com", title: "Connect" }],
      }),
    ).toBe(false);
  });
});
