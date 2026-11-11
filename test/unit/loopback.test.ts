// One HTTP/1.1 exchange with kitespan on 127.0.0.1 (server/update/loopback.ts; DESIGN.md 4.10, build checklist S7,
// S13): the restart's health gate and `bin/kitespan restart` go over a plain TCP socket, so the user's HTTP_PROXY or
// http_proxy never takes a request for 127.0.0.1 (Bun's fetch sends one through the proxy unless NO_PROXY names that
// host). The answer is read strictly, within a byte cap and a deadline. Every server here binds a port the system
// picks; a "dead" port is one the system gave and that was closed at once.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LOOPBACK_LIMITS, LoopbackError, loopback, parseAnswer, readHealth, type LoopbackRequest } from "../../server/update/loopback";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "bin", "kitespan");
const enc = (s: string) => new TextEncoder().encode(s);
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
function recorder(answer: (s: Seen) => Response = () => Response.json({ epoch: "e-1" })) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const s = { method: req.method, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() };
      seen.push(s);
      return answer(s);
    },
  });
  return { port: server.port!, seen, stop: () => void server.stop(true) };
}
/** A server that writes `parts` (each after `gapMs`), then closes, or stays silent when there are none. */
function rawServer(parts: string[], gapMs = 0, opts: { close?: boolean } = {}) {
  const conns: { end(): void }[] = [];
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        conns.push(s);
      },
      async data(s) {
        for (const p of parts) {
          if (gapMs) await Bun.sleep(gapMs);
          s.write(p);
        }
        if (parts.length && opts.close !== false) s.end();
      },
    },
  });
  return {
    port: listener.port,
    stop: () => {
      for (const c of conns) c.end();
      listener.stop(true);
    },
  };
}
const ok = (body: string, status = "200 OK", extra = "") => `HTTP/1.1 ${status}\r\nContent-Type: application/json; charset=utf-8\r\n${extra}Content-Length: ${enc(body).length}\r\n\r\n${body}`;

describe("the exchange", () => {
  test("GET: the request line, Host 127.0.0.1:<port>, Connection: close; the status and the JSON body", async () => {
    const r = recorder();
    try {
      expect(await loopback({ port: r.port, method: "GET", path: "/api/health", timeoutMs: 2_000 })).toEqual({ status: 200, json: { epoch: "e-1" } });
      expect(r.seen.map((s) => [s.method, s.path, s.headers.host, s.headers.connection, s.body])).toEqual([["GET", "/api/health", `127.0.0.1:${r.port}`, "close", ""]]);
      expect(await readHealth(r.port, 2_000)).toBe("e-1");
    } finally {
      r.stop();
    }
  });

  test("POST: the caller's headers, Content-Length and the body; a refusal's JSON", async () => {
    const r = recorder(() => Response.json({ error: { code: "preflight", message: "No." } }, { status: 409 }));
    try {
      const body = JSON.stringify({ when: "now" });
      const a = await loopback({ port: r.port, method: "POST", path: "/api/restart", headers: { "x-kitespan": "1", "content-type": "application/json" }, body, timeoutMs: 2_000 });
      expect(a).toEqual({ status: 409, json: { error: { code: "preflight", message: "No." } } });
      const s = r.seen[0]!;
      expect([s.method, s.path, s.headers["x-kitespan"], s.headers["content-type"], s.headers["content-length"], s.body]).toEqual(["POST", "/api/restart", "1", "application/json", String(body.length), body]);
    } finally {
      r.stop();
    }
  });

  test("an answer that comes in pieces is read whole", async () => {
    const whole = ok(JSON.stringify({ epoch: "slow" }));
    const s = rawServer([whole.slice(0, 7), whole.slice(7, 40), whole.slice(40)], 30);
    try {
      expect(await readHealth(s.port, 2_000)).toBe("slow");
    } finally {
      s.stop();
    }
  });

  test("nothing listens: an error at once; a peer that never answers: an error at the deadline", async () => {
    const dead = freePort();
    await expect(loopback({ port: dead, method: "GET", path: "/api/health", timeoutMs: 2_000 })).rejects.toBeInstanceOf(LoopbackError);
    expect(await readHealth(dead, 2_000)).toBeNull();
    const silent = rawServer([]);
    try {
      const t0 = Date.now();
      await expect(loopback({ port: silent.port, method: "GET", path: "/api/health", timeoutMs: 300 })).rejects.toBeInstanceOf(LoopbackError);
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      silent.stop();
    }
  });

  test("a peer that closes before the whole body, or sends more than the cap: an error", async () => {
    const cut = rawServer([ok(JSON.stringify({ epoch: "e" })).slice(0, -3)]);
    const big = rawServer([`HTTP/1.1 200 OK\r\nX-Pad: ${"a".repeat(LOOPBACK_LIMITS.maxBytes)}\r\nContent-Length: 2\r\n\r\n{}`]);
    try {
      await expect(loopback({ port: cut.port, method: "GET", path: "/api/health", timeoutMs: 2_000 })).rejects.toBeInstanceOf(LoopbackError);
      await expect(loopback({ port: big.port, method: "GET", path: "/api/health", timeoutMs: 2_000 })).rejects.toBeInstanceOf(LoopbackError);
    } finally {
      cut.stop();
      big.stop();
    }
  });

  test("the health read: only a 200 with a string epoch counts", async () => {
    for (const answer of [ok(JSON.stringify({ epoch: 7 })), ok(JSON.stringify({ epoch: "e" }), "503 Service Unavailable"), ok("not json"), ok("")]) {
      const s = rawServer([answer]);
      try {
        expect(await readHealth(s.port, 2_000)).toBeNull();
      } finally {
        s.stop();
      }
    }
  });

  test("a request it would not send: a path, a header name or a value with a line break; nothing reaches the server", async () => {
    const r = recorder();
    try {
      const refused: Partial<LoopbackRequest>[] = [{ path: "api/health" }, { path: "/a b" }, { headers: { "bad name": "1" } }, { headers: { x: "a\r\nInjected: 1" } }, { headers: { Host: "elsewhere" } }];
      for (const bad of refused) {
        await expect(loopback({ port: r.port, method: "GET", path: "/api/health", timeoutMs: 1_000, ...bad })).rejects.toBeInstanceOf(LoopbackError);
      }
      await Bun.sleep(50);
      expect(r.seen).toEqual([]);
    } finally {
      r.stop();
    }
  });
});

describe("the strict read of an answer", () => {
  const max = LOOPBACK_LIMITS.maxBytes;
  const parse = (s: string, eof = true) => parseAnswer(enc(s), max, eof);
  const bad = (s: string) => expect(() => parse(s)).toThrow(LoopbackError);

  test("a good answer, with or without a reason phrase; a body that is not JSON reads as none", () => {
    expect(parse(ok('{"epoch":"e"}'))).toEqual({ status: 200, json: { epoch: "e" } });
    expect(parse('HTTP/1.1 202\r\nContent-Length: 2\r\n\r\n{}')).toEqual({ status: 202, json: {} });
    expect(parse('HTTP/1.0 404 \r\nContent-Length: 0\r\n\r\n')).toEqual({ status: 404, json: undefined });
    expect(parse(ok("Forbidden\n", "403 Forbidden"))).toEqual({ status: 403, json: undefined });
  });

  test("not whole yet: more to read; whole only at the peer's end: an error", () => {
    const whole = ok('{"epoch":"e"}');
    expect(parse(whole.slice(0, 10), false)).toBeNull();
    expect(parse(whole.slice(0, -2), false)).toBeNull();
    bad(whole.slice(0, 10));
    bad(whole.slice(0, -2));
  });

  test("the status line: HTTP/1.x, three digits from 200 to 599, one space between", () => {
    for (const line of ["HTTP/2 200 OK", "http/1.1 200 OK", "HTTP/1.1 200OK", "HTTP/1.1  200 OK", "HTTP/1.1 20 OK", "HTTP/1.1 100 Continue", "HTTP/1.1 600 x", "ICY 200 OK", "HTTP/1.1 200 O\u0001K"]) bad(`${line}\r\nContent-Length: 2\r\n\r\n{}`);
  });

  test("the header lines: CRLF only, a token name, no folded line, no control byte", () => {
    bad("HTTP/1.1 200 OK\nContent-Length: 2\n\n{}");
    bad("HTTP/1.1 200 OK\r\nX: a\nb\r\nContent-Length: 2\r\n\r\n{}");
    bad("HTTP/1.1 200 OK\r\nX: a\r\n folded\r\nContent-Length: 2\r\n\r\n{}");
    bad("HTTP/1.1 200 OK\r\nX Y: 1\r\nContent-Length: 2\r\n\r\n{}");
    bad("HTTP/1.1 200 OK\r\n: 1\r\nContent-Length: 2\r\n\r\n{}");
    bad("HTTP/1.1 200 OK\r\nX: a\u0000b\r\nContent-Length: 2\r\n\r\n{}");
    bad(`HTTP/1.1 200 OK\r\n${"X: 1\r\n".repeat(LOOPBACK_LIMITS.maxHeaders + 1)}Content-Length: 2\r\n\r\n{}`);
  });

  test("the length: one Content-Length of digits, no Transfer-Encoding, and nothing after the body", () => {
    bad("HTTP/1.1 200 OK\r\n\r\n{}");
    bad("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}");
    bad("HTTP/1.1 200 OK\r\nContent-Length: +2\r\n\r\n{}");
    bad("HTTP/1.1 200 OK\r\nContent-Length: 2x\r\n\r\n{}");
    bad("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n");
    bad("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}");
    bad("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}HTTP/1.1 200 OK");
  });

  test("the cap: an answer, or a length, past it is an error at once", () => {
    expect(() => parseAnswer(enc(ok("{}")), 20, false)).toThrow(LoopbackError);
    expect(() => parseAnswer(enc(`HTTP/1.1 200 OK\r\nContent-Length: ${max}\r\n\r\n`), max, false)).toThrow(LoopbackError);
    expect(() => parseAnswer(enc(`HTTP/1.1 200 OK\r\nX: ${"a".repeat(max)}`), max, false)).toThrow(LoopbackError);
  });
});

// The user's proxy variables stay in bin/kitespan's environment (they are the user's, for Claude Code). A proxy at a
// port where nothing listens fails every request that goes through it, so a request that arrives went around it.
describe("bin/kitespan restart with HTTP_PROXY and http_proxy set (S7)", () => {
  test("the request reaches the kitespan on 127.0.0.1:<port>, never the proxy", async () => {
    const r = recorder((s) => Response.json({ when: JSON.parse(s.body).when }, { status: 202 }));
    const dir = mkdtempSync(join(tmpdir(), "kitespan-loopback-"));
    scratch.push(dir);
    mkdirSync(join(dir, "home"));
    const proxy = `http://127.0.0.1:${freePort()}`;
    try {
      const p = Bun.spawn(["sh", SCRIPT, "restart", "--port", String(r.port)], {
        cwd: dir,
        env: { PATH: `${resolve(process.execPath, "..")}:/usr/bin:/bin`, HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"), HTTP_PROXY: proxy, http_proxy: proxy },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect({ code, out, err }).toEqual({ code: 0, out: "kitespan restarts when the running turns end.\n", err: "" });
      expect(r.seen.map((s) => [s.method, s.path, s.headers.host, s.headers.origin, s.headers["x-kitespan"], s.body])).toEqual([
        ["POST", "/api/restart", `127.0.0.1:${r.port}`, `http://127.0.0.1:${r.port}`, "1", JSON.stringify({ when: "finish" })],
      ]);
    } finally {
      r.stop();
    }
  }, 20_000);
});
