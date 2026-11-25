import { App, openBrowser } from "./app.ts";
import { isDiscordConfigured } from "./config.ts";
import { log } from "./log.ts";
import { startServer } from "./web/server.ts";
import pkg from "../package.json";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function isBridge(url: string): Promise<boolean> {
  const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(800) }).catch(() => null);
  return Boolean(response?.ok);
}

/**
 * Two bridges with the same bot token make Telegram answer 409 Conflict, so only
 * one instance may run. We look for an existing one on nearby ports and ask it
 * to shut down (older builds do not expose /api/shutdown — then the user must
 * close them manually).
 */
async function takeOverExisting(port: number): Promise<void> {
  for (let candidate = port; candidate < port + 8; candidate += 1) {
    const url = `http://127.0.0.1:${candidate}`;
    if (!(await isBridge(url))) continue;
    log.warn(`another bridge instance found at ${url} — asking it to stop`);
    await fetch(`${url}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(1500) }).catch(() => null);
    for (let i = 0; i < 20; i += 1) {
      await sleep(250);
      if (!(await isBridge(url))) return;
    }
    log.error(`instance at ${url} did not stop (probably started as administrator).`);
    log.error("Close it manually: Task Manager → OpenCode Telegram Bridge → End task.");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`OpenCode Bridge ${pkg.version}`);
    process.exit(0);
  }
  const noBrowser = args.includes("--no-browser") || args.includes("--tray");
  const forceUi = args.includes("--ui");

  const app = new App();
  await takeOverExisting(app.cfg.web.port);
  log.info(`OpenCode Bridge ${pkg.version}`);

  const server = startServer(app);
  app.setWebPort(server.port);
  const uiUrl = `http://127.0.0.1:${server.port}`;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down (${signal})`);
    await app.stopBot().catch(() => undefined);
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (app.cfg.telegram.token || isDiscordConfigured(app.cfg)) {
    await app.startBot().catch((error: Error) => log.error("autostart:", error.message));
    if (forceUi && !noBrowser) openBrowser(uiUrl);
  } else {
    log.info(`not configured yet — open ${uiUrl}`);
    if (!noBrowser) openBrowser(uiUrl);
  }

  log.info(`running. ui: ${uiUrl}`);
}

main().catch((error: Error) => {
  console.error(`\n✖ ${error.message}\n`);
  process.exit(1);
});
