// Diagnostics: verifies the OpenCode side of the bridge without touching Telegram.
// Usage: bun run src/doctor.ts
import { loadConfig, resolvePaths } from "./config.ts";
import { discover, OcClient } from "./opencode/client.ts";

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

  const sessions = await client.listSessions({ limit: 5 });
  ok("sessions", `${sessions.length} (latest: ${sessions[0]?.title?.slice(0, 40) ?? "—"})`);

  const agents = await client.listAgents();
  ok("agents", agents.map((a) => a.id).join(", "));

  const session = sessions.find((s) => !s.parentID);
  if (session) {
    const messages = await client.messages(session.id);
    ok("history", `${messages.length} messages in ${session.id.slice(0, 16)}…`);
    const pending = await client.pendingPermissions(session.id);
    ok("pending permissions", String(pending.length));
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
    const bot = new Bot(cfg.telegram.token);
    const me = await bot.api.getMe();
    ok("telegram", `@${me.username}`);
  }

  console.log("\nAll good. Start the bridge with: bun run src/index.ts");
}

main().catch((error: Error) => {
  console.error(`\n✖ ${error.message}\n`);
  process.exit(1);
});
