// Diagnostics: verifies the OpenCode side of the bridge without touching Telegram.
// Usage: bun run src/doctor.ts
import { loadConfig, resolvePaths } from "./config.ts";
import { discover, OcClient } from "./opencode/client.ts";
import { resolveModelLabel } from "./model.ts";
import { setupTelegramNetwork } from "./telegram/net.ts";

const ok = (label: string, value: string) => console.log(`  ✔ ${label}: ${value}`);
const warn = (label: string, value: string) => console.log(`  ! ${label}: ${value}`);

async function main(): Promise<void> {
  const paths = resolvePaths();
  console.log(`config: ${paths.configFile}`);

  let cfg;
  try {
    cfg = loadConfig(paths);
    ok("telegram token", `${cfg.telegram.token.slice(0, 8)}…`);
    ok("allowed users", cfg.telegram.allowedUsers.map((u) => `${u.id}(${u.role ?? "user"})`).join(", "));
  } catch (error) {
    warn("config", (error as Error).message);
    cfg = undefined;
  }

  const endpoint = await discover(cfg?.opencode ?? {});
  ok("opencode", `${endpoint.baseUrl} via ${endpoint.source}`);

  const client = new OcClient(endpoint.baseUrl, endpoint.password);
  const info = await client.info();
  ok("version", info.version);

  const sessions = await client.listSessions({ limit: 10 });
  ok("sessions", `${sessions.length} (latest: ${sessions[0]?.title?.slice(0, 40) ?? "—"})`);

  const agents = await client.listAgents();
  ok("agents", agents.map((a) => a.id).join(", "));

  // Prefer the newest top-level session that actually has history; the absolute
  // newest one is often a just-created or subagent session.
  let session = sessions.find((s) => !s.parentID);
  let messages = session ? await client.messages(session.id) : [];
  if (!messages.length) {
    for (const candidate of sessions) {
      if (candidate.parentID) continue;
      const history = await client.messages(candidate.id);
      if (history.length) {
        session = candidate;
        messages = history;
        break;
      }
    }
  }
  if (session) {
    ok("history", `${messages.length} messages in ${session.id.slice(0, 16)}…`);
    ok("model", await resolveModelLabel(client, session.id));
    const active = await client.activeSessions();
    ok("active sessions", Object.keys(active).length ? Object.keys(active).map((id) => id.slice(0, 16)).join(", ") : "none");
    const queued = await client.inbox(session.id);
    ok("inbox", String(queued.length));
    const pending = await client.pendingPermissions(session.id);
    ok("pending permissions", String(pending.length));
    if (pending.length) warn("permission", "a request is waiting for a Telegram button");

    // Doctor: a streamed assistant message with no `completed` after 30 s means
    // the turn is stuck (usually a busy session or a lost SSE end event).
    const last = messages[messages.length - 1];
    const age = last?.time?.streamed ? Date.now() - last.time.streamed : 0;
    if (last?.type === "assistant" && last.time?.streamed && !last.time.completed && age > 30_000) {
      warn(
        "stuck turn",
        `${Math.round(age / 1000)}s without completion in ${session.id.slice(0, 16)}… — send /stop, then retry`,
      );
    } else {
      ok("stuck turn", "no stalled assistant message");
    }
  }

  let streamEvents = 0;
  const stop = client.subscribe(["session.text.delta"], () => {
    streamEvents += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  stop();
  ok("event stream", streamEvents > 0 ? `receiving (${streamEvents} deltas)` : "connected, no deltas (idle)");

  if (cfg) {
    const { Bot } = await import("grammy");
    // The doctor must use the same pinned IP/proxy as the daemon: direct access
    // to api.telegram.org is blocked on some networks.
    const net = await setupTelegramNetwork(cfg.telegram, async (fetchImpl) => {
      try {
        const response = await fetchImpl(`https://api.telegram.org/bot${cfg!.telegram.token}/getMe`, {
          signal: AbortSignal.timeout(10_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    });
    try {
      const bot = new Bot(cfg.telegram.token, { client: { fetch: net.fetch } });
      const me = await bot.api.getMe();
      ok("telegram", `@${me.username} (${net.mode})`);
    } finally {
      net.stop();
    }
  }

  console.log("\nAll good. Start the bridge with: bun run src/index.ts");
}

main().catch((error: Error) => {
  console.error(`\n✖ ${error.message}\n`);
  process.exit(1);
});
