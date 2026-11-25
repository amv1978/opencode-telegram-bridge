import { App, openBrowser } from "./app.ts";
import { isDiscordConfigured } from "./config.ts";
import { log } from "./log.ts";
import { startServer } from "./web/server.ts";
import { portFilePath, removePortFile, writePortFile } from "./web/portfile.ts";
import pkg from "../package.json";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `--port 7790` / `--port=7790`: one-run override used by the Electron shell. */
function portArg(args: string[]): number | undefined {
  const inline = args.find((arg) => arg.startsWith("--port="));
  const value = inline ? inline.slice("--port=".length) : args.includes("--port") ? args[args.indexOf("--port") + 1] : undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

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
  const requestedPort = portArg(args);
  if (requestedPort) app.cfg.web.port = requestedPort;
  await takeOverExisting(app.cfg.web.port);
  log.info(`OpenCode Bridge ${pkg.version}`);

  const server = startServer(app);
  app.setWebPort(server.port);
  const uiUrl = `http://127.0.0.1:${server.port}`;
  const portFile = portFilePath(app.paths.configFile);
  writePortFile(portFile, { port: server.port, pid: process.pid, version: pkg.version, startedAt: Date.now() });
  log.info(`port file: ${portFile} (${server.port})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down (${signal})`);
    removePortFile(portFile);
    await app.stopBot().catch(() => undefined);
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // `/api/shutdown` and crashes bypass `shutdown`; a stale port.json would send
  // the shell to a dead port (it probes, but let's not leave the file behind).
  process.on("exit", () => removePortFile(portFile));

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
