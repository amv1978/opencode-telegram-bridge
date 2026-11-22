/** Pure helpers behind `/recent`: newest sessions with an unread marker. */

export interface RecentSessionLike {
  id: string;
  title?: string;
  parentID?: string | null;
  time?: {
    created?: number;
    updated?: number;
    busy?: number;
    idle?: number;
    viewed?: number;
    archived?: number;
  };
  location?: { directory?: string };
}

export interface RecentEntry {
  id: string;
  title: string;
  directory: string;
  unread: boolean;
  updatedAt: number;
  ago: string;
}

export function isArchived(session: RecentSessionLike): boolean {
  return session.time?.archived !== undefined;
}

/**
 * OpenCode marks a session unread when it produced a turn (`time.idle`) that
 * was never viewed afterwards. A running session (`busy > idle`) is unread too.
 */
export function isUnread(session: RecentSessionLike): boolean {
  const time = session.time;
  if (!time) return false;
  const idle = Number(time.idle ?? 0);
  if (!idle) return Number(time.busy ?? 0) > 0;
  const viewed = Number(time.viewed ?? 0);
  return viewed === 0 || idle > viewed;
}

export function sessionTimestamp(session: RecentSessionLike): number {
  const time = session.time;
  return Number(time?.updated ?? time?.idle ?? time?.created ?? 0);
}

export function formatAgo(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "сейчас";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}м`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}ч`;
  const days = Math.floor(hours / 24);
  return `${days}д`;
}

export function shortDirectory(directory?: string): string {
  const value = String(directory ?? "").replace(/[\\/]+$/, "");
  if (!value) return "";
  const parts = value.split(/[\\/]+/);
  return parts[parts.length - 1] ?? value;
}

/** Root, non-archived sessions, newest first. */
export function recentEntries(list: RecentSessionLike[], limit = 10, now = Date.now()): RecentEntry[] {
  return list
    .filter((session) => session?.id && !session.parentID && !isArchived(session))
    .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left))
    .slice(0, Math.max(1, limit))
    .map((session) => ({
      id: session.id,
      title: (session.title ?? "").trim() || session.id.slice(0, 12),
      directory: shortDirectory(session.location?.directory),
      unread: isUnread(session),
      updatedAt: sessionTimestamp(session),
      ago: formatAgo(sessionTimestamp(session), now),
    }));
}

/** One chat line: `1. 🔔 title · dir · 5м`. */
export function recentLine(entry: RecentEntry, index: number): string {
  const bell = entry.unread ? "🔔 " : "";
  const meta = [entry.directory, entry.ago].filter(Boolean).join(" · ");
  return `${index + 1}. ${bell}${entry.title}${meta ? ` · ${meta}` : ""}`;
}
