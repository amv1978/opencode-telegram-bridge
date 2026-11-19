import { log } from "../log.ts";

/**
 * The Bot API host is blocked on some networks while other Telegram IPs stay
 * reachable. We try several transports and keep the first one that really
 * answers `getMe` (verified by the caller).
 */

const KNOWN_API_IPS = [
  "149.154.167.220",
  "149.154.167.197",
  "149.154.167.198",
  "149.154.175.50",
  "149.154.164.250",
  "149.154.167.99",
];

export interface TelegramNet {
  mode: string;
  fetch: typeof globalThis.fetch;
  /** IP to remember when this transport required pinning. */
  pinnedIp?: string;
  stop(): void;
}

export type VerifyTelegram = (fetchImpl: typeof globalThis.fetch) => Promise<boolean>;

export async function setupTelegramNetwork(
  cfg: { proxy?: string; apiIp?: string },
  verify: VerifyTelegram,
): Promise<TelegramNet> {
  const attempts: Array<() => TelegramNet> = [];

  if (cfg.proxy) {
    attempts.push(() => ({ mode: `proxy ${cfg.proxy}`, fetch: proxyFetch(cfg.proxy!), stop: () => undefined }));
  }

  const ips = [...new Set([...(cfg.apiIp ? [cfg.apiIp] : []), ...KNOWN_API_IPS])];
  for (const ip of ips) {
    attempts.push(() => {
      const proxy = startPinnedProxy(ip);
      return {
        mode: `pinned ${ip}`,
        fetch: proxyFetch(proxy.url),
        pinnedIp: ip,
        stop: proxy.stop,
      };
    });
  }

  attempts.push(() => ({ mode: "direct", fetch: globalThis.fetch, stop: () => undefined }));

  for (const attempt of attempts) {
    const net = attempt();
    let ok = false;
    let lastError = "";
    for (let tries = 0; tries < 3 && !ok; tries += 1) {
      try {
        ok = await verify(net.fetch);
        if (!ok) lastError = "no answer";
      } catch (error) {
        lastError = (error as Error).message;
      }
      if (!ok) await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (ok) {
      log.info(`telegram: ${net.mode}`);
      return net;
    }
    log.warn(`telegram: ${net.mode} — ${lastError}`);
    net.stop();
  }

  throw new Error(
    "Не удалось связаться с Telegram Bot API.\n" +
      "Проверьте интернет или укажите прокси в настройках → «Сеть (прокси / IP)»:\n" +
      "  socks5://127.0.0.1:1080  или  http://127.0.0.1:8080",
  );
}

function proxyFetch(proxyUrl: string): typeof globalThis.fetch {
  return ((input: any, init: any = {}) =>
    (globalThis.fetch as any)(input, { ...init, proxy: proxyUrl })) as typeof globalThis.fetch;
}

interface Conn {
  client: any;
  upstream?: any;
  buffer: Buffer;
  ready: boolean;
}

function startPinnedProxy(pinnedIp: string): { url: string; stop(): void } {
  const connections = new WeakMap<object, Conn>();
  const server = Bun.listen<any>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        connections.set(socket, { client: socket, buffer: Buffer.alloc(0), ready: false });
      },
      async data(socket, chunk) {
        const conn = connections.get(socket);
        if (!conn) return;
        if (conn.ready) {
          conn.upstream?.write(chunk);
          conn.upstream?.flush?.();
          return;
        }
        conn.buffer = Buffer.concat([conn.buffer, Buffer.from(chunk)]);
        const headerEnd = conn.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = conn.buffer.subarray(0, headerEnd).toString("utf8");
        const rest = conn.buffer.subarray(headerEnd + 4);
        const requestLine = header.split("\r\n")[0] ?? "";
        const [, authority = "api.telegram.org:443"] = requestLine.split(" ");
        const [host = "api.telegram.org", portText] = authority.split(":");
        const port = Number(portText ?? 443);
        const target = host === "api.telegram.org" ? pinnedIp : host;

        try {
          const upstream = await Bun.connect({
            hostname: target,
            port,
            socket: {
              data(up, data) {
                conn.client.write(data);
                conn.client.flush?.();
              },
              close() {
                conn.client.end();
              },
              error(_up, error) {
                log.warn("telegram proxy upstream:", error.message);
                conn.client.end();
              },
            },
          });
          conn.upstream = upstream;
          conn.ready = true;
          conn.client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          conn.client.flush?.();
          if (rest.length) {
            upstream.write(rest);
            upstream.flush?.();
          }
        } catch (error) {
          log.warn("telegram proxy connect failed:", (error as Error).message);
          conn.client.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          conn.client.end();
        }
      },
      close(socket) {
        connections.get(socket)?.upstream?.end();
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}
