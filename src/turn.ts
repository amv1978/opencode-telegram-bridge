import { formatUsd } from "./budget.ts";

/**
 * End-of-turn wording shared by Telegram and Discord.
 *
 * A turn that did not succeed must never look like a success: the reason is a
 * separate line above the stats, because the stats line stays last.
 */

export type TurnEvent = "succeeded" | "failed" | "interrupted" | string;

export interface StopDetail {
  kind: "user" | "budget" | "steps";
  amountUsd?: number;
  limitUsd?: number;
}

export interface TurnReasonInput {
  type: TurnEvent;
  data?: Record<string, unknown>;
  stop?: StopDetail;
}

/** Short, single-line reason from an arbitrary `execution.failed` payload. */
export function shortReason(value: unknown, limit = 120): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const nested = source.error as Record<string, unknown> | undefined;
    const candidates = [source.message, source.reason, nested?.message, source.name, nested?.name];
    text = candidates.find((item): item is string => typeof item === "string" && item.trim().length > 0) ?? "";
    if (!text) {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
  } else if (value !== undefined && value !== null) {
    text = String(value);
  }

  const line = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!line) return "неизвестная ошибка";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function eventText(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  const parts = [data.reason, data.code, data.message, data.error, data.name]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => shortReason(value, 400));
  return parts.join(" ");
}

/** A step/turn cap is reported by some OpenCode builds as a failed execution. */
export function isStepLimitReason(value: string): boolean {
  return /step[\s_-]*(?:limit|cap)|max(?:imum)?[\s_-]*steps?|too many steps|лимит шагов|максимум шагов/i.test(
    value,
  );
}

/**
 * `undefined` for a successful turn, otherwise the exact line shown in chat:
 * `⚠️ остановлено: /stop`, `⛔ бюджет: $0.42 из $1.00`, `⚠️ лимит шагов`,
 * `⚠️ ошибка: <short reason>`.
 */
export function turnReason(input: TurnReasonInput): string | undefined {
  if (input.type === "succeeded") return undefined;

  if (input.type === "interrupted") {
    if (input.stop?.kind === "budget") {
      const spent = input.stop.amountUsd ?? 0;
      const limit = input.stop.limitUsd ?? 0;
      return `⛔ бюджет: ${formatUsd(spent)} из ${formatUsd(limit)}`;
    }
    if (input.stop?.kind === "steps") return "⚠️ лимит шагов";
    if (input.stop?.kind === "user") return "⚠️ остановлено: /stop";
    return "⚠️ остановлено";
  }

  const text = eventText(input.data);
  if (input.stop?.kind === "steps" || isStepLimitReason(text)) return "⚠️ лимит шагов";
  if (input.stop?.kind === "budget") {
    const spent = input.stop.amountUsd ?? 0;
    const limit = input.stop.limitUsd ?? 0;
    return `⛔ бюджет: ${formatUsd(spent)} из ${formatUsd(limit)}`;
  }
  if (input.stop?.kind === "user") return "⚠️ остановлено: /stop";
  return `⚠️ ошибка: ${shortReason(text || "неизвестная ошибка")}`;
}

/** `1 инструмент`, `2 инструмента`, `5 инструментов`. */
export function toolsWord(count: number): string {
  const value = Math.abs(Math.trunc(count));
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return "инструмент";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "инструмента";
  return "инструментов";
}

/** `2 инструмента заблокировано` (singular uses `заблокирован`). */
export function blockedToolsText(count: number): string {
  const value = Math.max(0, Math.trunc(count));
  if (!value) return "";
  return `${value} ${toolsWord(value)} ${value === 1 ? "заблокирован" : "заблокировано"}`;
}

/** `42s`, `1m 23s` — the same shape as the live block. */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

export interface TurnFooterInput {
  reason?: string;
  blockedTools?: number;
  model?: string;
  durationMs?: number;
  tps?: number;
  contextTokens?: number;
}

/**
 * Reason line (if any) + stats line. The stats line is always last; the reason
 * and the blocked-tool counter precede it.
 */
export function composeTurnFooter(input: TurnFooterInput): string {
  const blocked = blockedToolsText(input.blockedTools ?? 0);
  const reason = input.reason
    ? blocked
      ? `${input.reason} · ${blocked}`
      : input.reason
    : blocked
      ? `⚠️ ${blocked}`
      : "";

  const stats: string[] = [];
  if (input.model) stats.push(input.model);
  if (input.durationMs !== undefined && input.durationMs > 0) stats.push(`⏱ ${formatDuration(input.durationMs)}`);
  if (input.tps) stats.push(`⚡ ${input.tps.toFixed(1)} tok/s`);
  if (input.contextTokens) stats.push(`🧠 ${formatTokens(input.contextTokens)}`);

  return [reason, stats.join(" · ")].filter(Boolean).join("\n");
}

/** Failed tool call whose error is a policy/permission denial, not a bug. */
export function isBlockedToolFailure(value: unknown): boolean {
  const text = shortReason(value, 500);
  return /permission|denied|declin|rejected|blocked|not allowed|forbidden|отклон|запрещ|заблок/i.test(text);
}
