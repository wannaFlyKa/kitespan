// The spike's SC-6, ported (build checklist A9; DESIGN.md 4.9 guard 2, D52): a server on the test port answers raw
// HTTP upgrade requests. Six foreign origins get 403 on /ws and on /ws/shell, kitespan's own origin and an adapter
// origin get 101, a DNS-rebinding style Host gets 403 whatever its Origin, and the log names the route but never the
// refused Origin. A raw request is used because it sets the Origin and Host headers exactly.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGate } from "../../server/gate/guards";
import { createApp, HTTP_LOG_ROUTES, plainSocketRoute, type SocketHandlers } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { createLogger, type Logger } from "../../server/log";
import { freePort } from "./free-port";

const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;
const ADAPTER = "https://forward.example.com";
const FOREIGN = ["https://evil.example", `http://localhost:${PORT + 1}`, `${ADAPTER}.evil.example`, `http://127.0.0.1:${PORT + 1}`, "null", null] as const;

const dir = mkdtempSync(join(tmpdir(), "kitespan-upgrade-"));
let server: ReturnType<typeof Bun.serve> | null = null;
let logger: Logger;
const opened: string[] = [];

beforeAll(() => {
  logger = createLogger({ dir: join(dir, "logs"), routes: HTTP_LOG_ROUTES });
  const gate = createGate(PORT, [ADAPTER]);
  const site = loadSite(join(dir, "dist"), gate.origins);
  const echo: SocketHandlers = {
    open(ws) {
      opened.push(ws.data.route);
      ws.send(`open ${ws.data.route}`);
    },
    message() {},
    close() {},
  };
  const app = createApp({ gate, site, api: { handle: async () => new Response("api") }, sockets: { "/ws": plainSocketRoute("/ws", echo), "/ws/shell": plainSocketRoute("/ws/shell", echo) }, logger });
  server = Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: (req, srv) => app.fetch(req, srv), websocket: app.websocket });
});

afterAll(() => {
  server?.stop(true);
  logger.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One raw request; resolves with the status line and whatever else came before the socket was ended. */
function raw(request: string): Promise<{ status: number; rest: string }> {
  return new Promise((resolve) => {
    let out = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1] ?? 0);
      resolve({ status, rest: out });
    };
    Bun.connect({
      hostname: "127.0.0.1",
      port: PORT,
      socket: {
        open(s) {
          s.write(request);
          timer = setTimeout(() => s.end(), 1500);
        },
        data(s, d) {
          out += Buffer.from(d).toString("latin1");
          // A refusal ends at its body; an upgrade is done once the first frame (the open line) is in.
          if (/^HTTP\/1\.1 101/.test(out) ? out.includes("open ") : out.includes("\r\n\r\n")) s.end();
        },
        close: done,
        error: done,
      },
    });
  });
}

function upgrade(path: string, origin: string | null, host = `127.0.0.1:${PORT}`): string {
  return (
    `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
    (origin === null ? "" : `Origin: ${origin}\r\n`) +
    "\r\n"
  );
}

describe.each(["/ws", "/ws/shell"])("the upgrade at %s", (path) => {
  test.each(FOREIGN.map((o) => [o ?? "(no Origin)", o] as const))("a foreign origin %s gets 403", async (_label, origin) => {
    const r = await raw(upgrade(path, origin));
    expect(r.status).toBe(403);
    expect(r.rest).not.toContain("Upgrade: websocket");
  });

  test.each([OWN, ADAPTER])("an allowed origin %s gets 101 and reaches the path's handlers", async (origin) => {
    const before = opened.length;
    const r = await raw(upgrade(path, origin));
    expect(r.status).toBe(101);
    expect(r.rest).toContain(`open ${path}`);
    expect(opened.slice(before)).toEqual([path]);
  });

  test("a DNS-rebinding style Host gets 403, with its own Origin or with kitespan's", async () => {
    expect((await raw(upgrade(path, `http://rebind.example:${PORT}`, `rebind.example:${PORT}`))).status).toBe(403);
    expect((await raw(upgrade(path, OWN, `rebind.example:${PORT}`))).status).toBe(403);
    expect((await raw(upgrade(path, OWN, `rebind.localhost:${PORT}`))).status).toBe(403);
  });

  test("a plain GET with an allowed origin is not an upgrade (426); a POST is refused (405)", async () => {
    expect((await raw(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nOrigin: ${OWN}\r\nConnection: close\r\n\r\n`)).status).toBe(426);
    expect((await raw(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nOrigin: ${OWN}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)).status).toBe(405);
  });
});

test("a request with no Host at all is refused", async () => {
  expect([400, 403]).toContain((await raw("GET / HTTP/1.0\r\n\r\n")).status);
});

test("the log names the route of each refusal and never an Origin or a Host", () => {
  const files = readdirSync(join(dir, "logs"));
  const text = files.map((f) => readFileSync(join(dir, "logs", f), "utf8")).join("");
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  const refused = lines.filter((l) => l.ev === "origin_refused");
  expect(refused.filter((l) => l.route === "/ws").length).toBeGreaterThanOrEqual(FOREIGN.length + 3);
  expect(refused.filter((l) => l.route === "/ws/shell").length).toBeGreaterThanOrEqual(FOREIGN.length + 3);
  for (const bad of ["evil", "localhost", "rebind", '"null"', "forward", "127.0.0.1", "origin\":"]) expect(text).not.toContain(bad);
});
