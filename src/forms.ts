/**
 * OpenCode forms (`form.created`) shared by the Telegram and Discord adapters.
 *
 * Pending forms answer the same endpoint as Desktop/TUI:
 *   GET  /api/session/{id}/form          → Form.Info[]
 *   POST /api/session/{id}/form/{fid}/reply  body `{ answer: { [key]: value } }`
 *   DELETE /api/session/{id}/form/{fid}?message=…
 *
 * Answer values are typed per field: string, number, boolean or string[].
 */

export const FORM_TTL_MS = 15 * 60 * 1000;

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

export interface FormWhen {
  key: string;
  op: "eq" | "neq";
  value: string | number | boolean;
}

interface FormFieldBase {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: FormWhen[];
}

export interface FormStringField extends FormFieldBase {
  type: "string";
  options?: FormOption[];
  custom?: boolean;
  default?: string;
  format?: "email" | "uri" | "date" | "date-time";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
}

export interface FormNumberField extends FormFieldBase {
  type: "number" | "integer";
  minimum?: number;
  maximum?: number;
  default?: number;
}

export interface FormBooleanField extends FormFieldBase {
  type: "boolean";
  default?: boolean;
}

export interface FormMultiselectField extends FormFieldBase {
  type: "multiselect";
  options: FormOption[];
  minItems?: number;
  maxItems?: number;
  custom?: boolean;
  default?: string[];
}

export interface FormExternalField extends FormFieldBase {
  type: "external";
  url: string;
}

export type FormField =
  | FormStringField
  | FormNumberField
  | FormBooleanField
  | FormMultiselectField
  | FormExternalField;

export interface FormInfo {
  id: string;
  sessionID: string;
  title: string;
  metadata?: { kind?: string; message?: string } & Record<string, unknown>;
  fields: FormField[];
}

export type FormValue = string | number | boolean | string[];
export type FormAnswer = Record<string, FormValue>;
export type FormValues = Record<string, FormValue | undefined>;

/** Field flavour the chat UI needs to pick a widget. */
export type FieldWidget = "choice" | "multi" | "flag" | "text" | "number" | "external";

export function fieldWidget(field: FormField): FieldWidget {
  if (field.type === "multiselect") return "multi";
  if (field.type === "boolean") return "flag";
  if (field.type === "number" || field.type === "integer") return "number";
  if (field.type === "external") return "external";
  if (field.type === "string" && field.options?.length) return "choice";
  return "text";
}

export function fieldTitle(field: FormField): string {
  return (field.title ?? "").trim() || field.key;
}

function matchesWhen(when: FormWhen | undefined, values: FormValues): boolean {
  if (!when) return true;
  const current = values[when.key];
  const equal = Array.isArray(current)
    ? current.includes(String(when.value))
    : typeof current === typeof when.value
      ? current === when.value
      : String(current ?? "") === String(when.value);
  return when.op === "neq" ? !equal : equal;
}

/** Visible fields whose `when` conditions hold for the current draft. */
export function activeFields(form: FormInfo, values: FormValues): FormField[] {
  return (form.fields ?? []).filter(
    (field) => !field.hidden && (field.when ?? []).every((condition) => matchesWhen(condition, values)),
  );
}

/** Defaults declared by the form, used to pre-fill the draft. */
export function defaultValues(form: FormInfo): FormValues {
  const values: FormValues = {};
  for (const field of form.fields ?? []) {
    const fallback = (field as { default?: FormValue }).default;
    if (fallback !== undefined) values[field.key] = fallback;
  }
  return values;
}

/** `undefined` means "not answered yet"; empty arrays count as answered. */
export function isAnswered(value: FormValue | undefined): value is FormValue {
  return value !== undefined;
}

/** Next field without an answer, in form order. */
export function nextField(
  fields: FormField[],
  values: FormValues,
  done: ReadonlySet<string>,
): FormField | undefined {
  return fields.find((field) => !done.has(field.key) && !isAnswered(values[field.key]));
}

/** Human label for an option value; falls back to the raw value. */
export function optionLabel(field: FormField, value: string): string {
  const options = "options" in field && Array.isArray(field.options) ? field.options : [];
  return options.find((option) => option.value === value)?.label ?? value;
}

export function valueLabel(field: FormField, value: FormValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => optionLabel(field, item)).join(", ") || "—";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "string" && "options" in field && field.options?.length) return optionLabel(field, value);
  return String(value);
}

/** Short constraint line for the question header. */
export function fieldHint(field: FormField): string {
  const parts: string[] = [];
  if (field.type === "multiselect") {
    const min = field.minItems ?? 0;
    const max = field.maxItems;
    if (min && max) parts.push(`от ${min} до ${max}`);
    else if (min > 1) parts.push(`не меньше ${min}`);
    else if (max) parts.push(`не больше ${max}`);
    else parts.push("можно несколько");
  }
  if (field.type === "number" || field.type === "integer") {
    if (field.minimum !== undefined && field.maximum !== undefined) parts.push(`${field.minimum}…${field.maximum}`);
    else if (field.minimum !== undefined) parts.push(`≥ ${field.minimum}`);
    else if (field.maximum !== undefined) parts.push(`≤ ${field.maximum}`);
    if (field.type === "integer") parts.push("целое число");
  }
  if (field.type === "string" && field.format) parts.push(field.format);
  if (field.required) parts.push("обязательно");
  return parts.join(" · ");
}

/** Parses typed text for text/number fields; returns an error for bad input. */
export function parseText(field: FormField, text: string): { value?: FormValue; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    if (field.required) return { error: "Нужен ответ — это поле обязательное." };
    return { value: undefined };
  }
  if (field.type === "number" || field.type === "integer") {
    const number = Number(trimmed.replace(",", "."));
    if (!Number.isFinite(number)) return { error: "Нужно число." };
    if (field.type === "integer" && !Number.isInteger(number)) return { error: "Нужно целое число." };
    if (field.minimum !== undefined && number < field.minimum) return { error: `Минимум ${field.minimum}.` };
    if (field.maximum !== undefined && number > field.maximum) return { error: `Максимум ${field.maximum}.` };
    return { value: number };
  }
  if (field.type === "string") {
    if (field.maxLength && trimmed.length > field.maxLength) return { error: `Не длиннее ${field.maxLength} символов.` };
    if (field.minLength && trimmed.length < field.minLength) return { error: `Не короче ${field.minLength} символов.` };
    if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(trimmed)) return { error: "Ответ не подходит под формат поля." };
      } catch {
        /* malformed pattern: let the server decide */
      }
    }
  }
  return { value: trimmed };
}

/**
 * Builds the reply body. Returns an error string when a required field or a
 * minItems rule is not satisfied, so the chat can ask again instead of
 * surfacing a raw 400 from OpenCode.
 */
export function buildAnswer(fields: FormField[], values: FormValues): { answer?: FormAnswer; error?: string } {
  const answer: FormAnswer = {};
  for (const field of fields) {
    if (field.type === "external") continue;
    const value = values[field.key];
    if (!isAnswered(value)) {
      if (field.required) return { error: `Ответьте на «${fieldTitle(field)}».` };
      continue;
    }
    if (Array.isArray(value)) {
      if (field.type === "multiselect") {
        if (!value.length) {
          const min = field.minItems ?? 0;
          if (min > 0) return { error: `В «${fieldTitle(field)}» нужно не меньше ${min}.` };
          if (field.required) return { error: `Выберите хотя бы один вариант в «${fieldTitle(field)}».` };
          continue;
        }
        const min = field.minItems ?? 0;
        if (min && value.length < min) return { error: `В «${fieldTitle(field)}» нужно не меньше ${min}.` };
        if (field.maxItems && value.length > field.maxItems) {
          return { error: `В «${fieldTitle(field)}» можно не больше ${field.maxItems}.` };
        }
      }
      answer[field.key] = value;
      continue;
    }
    answer[field.key] = value;
  }
  return { answer };
}

/** `Field: answer` lines for the final message. */
export function summarize(form: FormInfo, answer: FormAnswer): string[] {
  const fields = form.fields ?? [];
  return fields
    .filter((field) => answer[field.key] !== undefined)
    .map((field) => `${fieldTitle(field)}: ${valueLabel(field, answer[field.key])}`);
}

/** True when at least one field needs a widget the chat can render. */
export function isChatRenderable(form: FormInfo): boolean {
  const fields = form.fields ?? [];
  return fields.length > 0 && fields.some((field) => field.type !== "external");
}
