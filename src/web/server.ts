import { readFileSync } from "node:fs";
import { App } from "../app.ts";
import { log } from "../log.ts";
import { PAGE } from "./ui.ts";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export function startServer(app: App): { port: number; stop(): void } {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let port = app.cfg.web.port || 7788;
  for (let attempt = 0; attempt < 10 && !server; attempt += 1) {
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => handle(app, request) });
    } catch (error) {
      log.warn(`web ui: port ${port} busy (${(error as Error).message})`);
      port += 1;
    }
  }
  if (!server) throw new Error("Не удалось занять порт для веб-интерфейса");
  const boundPort = server.port ?? port;
  log.info(`web ui: http://127.0.0.1:${boundPort}`);
  return { port: boundPort, stop: () => server?.stop(true) };
}

async function handle(app: App, request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      const snapshot = app.snapshot();
      snapshot.sessions = await app.sessions();
      return json(snapshot);
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      return json({ sessions: await app.sessions() });
    }

    if (request.method === "GET" && url.pathname === "/api/log") {
      const lines = Number(url.searchParams.get("lines") ?? 120);
      return json({ log: tailLog(app.paths.logFile, Number.isFinite(lines) ? lines : 120) });
    }

    if (request.method === "POST" && url.pathname === "/api/config") {
      const body = (await request.json()) as Record<string, unknown>;
      await app.updateConfig(body);
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/bot/start") {
      await app.startBot();
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/bot/stop") {
      await app.stopBot();
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/bot/restart") {
      await app.restartBot();
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/autostart") {
      const body = (await request.json()) as { enabled?: boolean };
      app.setAutostart(Boolean(body.enabled));
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/shutdown") {
      setTimeout(() => process.exit(0), 200);
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  } catch (error) {
    const message = (error as Error).message;
    log.warn(`web ${url.pathname}: ${message}`);
    return json({ error: message }, 400);
  }
}

function tailLog(file: string, lines: number): string {
  try {
    const text = readFileSync(file, "utf8");
    return text.split("\n").slice(-Math.min(lines, 1000)).join("\n");
  } catch {
    return "";
  }
}
