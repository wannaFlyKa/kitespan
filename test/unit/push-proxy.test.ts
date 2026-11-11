// R130 (FIX-R130 1: "It honours the user's proxy variables for that call ... with a deadline"; DESIGN-R130 2.4): the
// push call is a plain fetch with the server's own environment, so Bun's fetch takes the user's proxy variables. Each
// case runs the server's sender in a child process with a clean environment (only the case's variables), and every
// listener is on 127.0.0.1: a recording proxy, a raw listener that stands for a push service's TLS port, and the stub
// push service. No other host is ever named.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Socket, TCPSocketListener } from "bun";
import { startPushStub } from "../click/push-stub";

const ROOT = resolve(import.meta.dir, "..", "..");
const DIR = mkdtempSync(join(tmpdir(), "push-proxy-"));
const stub = startPushStub({ listen: true });
afterAll(() => {
  stub.stop();
  rmSync(DIR, { recursive: true, force: true });
});

const CHILD = join(DIR, "send.ts");
writeFileSync(
  CHILD,
  `import { makeVapidKeys } from ${JSON.stringify(join(ROOT, "server", "push", "crypto.ts"))};
import { PushSender } from ${JSON.stringify(join(ROOT, "server", "push", "send.ts"))};
const job = JSON.parse(await Bun.file(process.argv[2]).text());
const lines = [];
const sender = new PushSender({ timeoutMs: job.timeoutMs, log: (f) => lines.push(f) });
const payload = { v: 1, title: "Claude finished", body: "", tag: "c:k3m7q2x4abk3m7q2x4ab", url: "/c/k3m7q2x4abk3m7q2x4ab" };
const r = await sender.send(job.to, await makeVapidKeys(), payload, { urgent: false, topic: "k3m7q2x4abk3m7q2x4ab" });
console.log(JSON.stringify({ r, lines: lines.map(({ host, status, answer }) => ({ host, status, answer })) }));
`,
);

/** A raw TCP listener: the first bytes of each connection, and what it answers (nothing: it stalls). */
function listener(answer: ((first: string) => string | null) | null) {
  const firsts: string[] = [];
  const srv: TCPSocketListener<{ seen: boolean }> = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s: Socket<{ seen: boolean }>) {
        s.data = { seen: false };
      },
      data(s: Socket<{ seen: boolean }>, d: Buffer) {
        if (s.data.seen) return;
        s.data.seen = true;
        const first = d[0] === 0x16 ? "<TLS ClientHello>" : d.toString("latin1").split("\r\n")[0]!;
        firsts.push(first);
        const reply = answer?.(first);
        if (reply) {
          s.write(reply);
          s.end();
        } else if (answer) s.end();
      },
    },
  });
  return { port: srv.port, firsts, stop: () => srv.stop(true) };
}

const proxy = listener((first) => (first.startsWith("CONNECT ") ? "HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n" : "HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"));
const stalled = listener(null);
const tlsPort = listener(() => null);
afterAll(() => {
  proxy.stop();
  stalled.stop();
  tlsPort.stop();
});

let job = 0;
async function send(endpoint: string, env: Record<string, string>, timeoutMs = 5_000) {
  const sub = stub.subscribe(`p${++job}`);
  const file = join(DIR, `job-${job}.json`);
  writeFileSync(file, JSON.stringify({ to: { endpoint: endpoint.replace("{stub}", sub.endpoint), p256dh: sub.keys.p256dh, auth: sub.keys.auth }, timeoutMs }));
  const p = Bun.spawn([process.execPath, "--no-env-file", CHILD, file], { cwd: DIR, env: { PATH: "/usr/bin:/bin", HOME: DIR, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect(code).toBe(0);
  return JSON.parse(out.trim().split("\n").at(-1)!) as { r: { kind: string; status: number; answer?: string }; lines: { host: string; status: number; answer?: string }[] };
}

const P = `http://127.0.0.1:${proxy.port}`;
const HTTPS = `https://127.0.0.1:${tlsPort.port}/push/abc`;

describe("the push call and the user's proxy variables", () => {
  test("an https push service goes through HTTPS_PROXY (and https_proxy) as a CONNECT; the proxy's refusal is the status", async () => {
    for (const name of ["HTTPS_PROXY", "https_proxy"]) {
      const from = proxy.firsts.length;
      const got = await send(HTTPS, { [name]: P });
      expect(proxy.firsts.slice(from)).toEqual([`CONNECT 127.0.0.1:${tlsPort.port} HTTP/1.1`]);
      expect(got.r).toEqual({ kind: "failed", status: 502 });
      expect(got.lines).toEqual([{ host: "127.0.0.1", status: 502 }]);
    }
  }, 20_000);

  test("NO_PROXY names a host that goes direct", async () => {
    const from = proxy.firsts.length;
    const got = await send(HTTPS, { HTTPS_PROXY: P, NO_PROXY: "127.0.0.1" });
    expect(proxy.firsts.length).toBe(from);
    expect(tlsPort.firsts.at(-1)).toBe("<TLS ClientHello>");
    expect(got.r).toEqual({ kind: "failed", status: 0, answer: "network" });
  }, 20_000);

  test("the test's http stub: through HTTP_PROXY when it is set, direct with NO_PROXY=127.0.0.1 (where it gets one push)", async () => {
    const from = proxy.firsts.length;
    const n = stub.received.length;
    const via = await send("{stub}", { HTTP_PROXY: P });
    expect(proxy.firsts.slice(from)).toEqual([`POST ${stub.origin}/push/p${job} HTTP/1.1`]);
    expect(via.r).toEqual({ kind: "refused", status: 403 });
    expect(stub.received.length).toBe(n);
    const direct = await send("{stub}", { HTTP_PROXY: P, NO_PROXY: "127.0.0.1" });
    expect(direct.r).toEqual({ kind: "sent", status: 201 });
    expect(stub.received.length).toBe(n + 1);
    expect(stub.received.at(-1)!.vapid).toBe("ok");
    expect(JSON.parse(stub.received.at(-1)!.plain!).title).toBe("Claude finished");
  }, 20_000);

  test("the deadline ends a call through a proxy that never answers", async () => {
    const t0 = Date.now();
    const got = await send(HTTPS, { HTTPS_PROXY: `http://127.0.0.1:${stalled.port}` }, 600);
    expect(got.r).toEqual({ kind: "failed", status: 0, answer: "timeout" });
    expect(stalled.firsts.at(-1)).toBe(`CONNECT 127.0.0.1:${tlsPort.port} HTTP/1.1`);
    expect(Date.now() - t0).toBeLessThan(8_000);
  }, 20_000);
});
