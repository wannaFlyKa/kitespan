// The slow-network proxy of the click-through (scripts/net-proxy.ts; DESIGN.md 9.4 done check 9, build checklist L2):
// the delay in each direction, the throughput cap, the bytes intact and in order under backpressure, the cut and its
// gap, and the ports it never touches. An echo server and the proxy each take a port the system picks.
import { afterEach, expect, test } from "bun:test";
import { startProxy, type NetProxy } from "../../scripts/net-proxy";

type Echo = { port: number; stop(): void };

function echoServer(): Echo {
  const srv = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(s, d) {
        s.write(d);
      },
    },
  });
  return { port: srv.port, stop: () => srv.stop(true) };
}

/** A client through the proxy: what it got, when, and whether the link closed it. */
async function client(port: number) {
  const got: { at: number; n: number }[] = [];
  const chunks: Uint8Array[] = [];
  let closed = false;
  const s = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, d) {
        got.push({ at: performance.now(), n: d.length });
        chunks.push(new Uint8Array(d));
      },
      close() {
        closed = true;
      },
      error() {
        closed = true;
      },
    },
  });
  const bytes = () => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let i = 0;
    for (const c of chunks) {
      out.set(c, i);
      i += c.length;
    }
    return out;
  };
  return { s, got, bytes, closed: () => closed, total: () => got.reduce((n, g) => n + g.n, 0) };
}

async function until(ok: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) return false;
    await Bun.sleep(10);
  }
  return true;
}

const open: { proxy?: NetProxy; echo?: Echo }[] = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.proxy?.stop();
    o.echo?.stop();
  }
});

function setup(delayMs: number, kbit: number) {
  const echo = echoServer();
  const proxy = startProxy({ to: echo.port, delayMs, kbit });
  open.push({ proxy, echo });
  return { echo, proxy };
}

test("each direction is late by the delay: a round trip takes about twice it", async () => {
  const { proxy } = setup(120, 100_000);
  const c = await client(proxy.port);
  const t0 = performance.now();
  c.s.write("ping");
  expect(await until(() => c.total() >= 4, 3000)).toBe(true);
  const rtt = c.got[0]!.at - t0;
  expect(rtt).toBeGreaterThanOrEqual(235);
  expect(rtt).toBeLessThan(600);
  c.s.end();
});

test("the throughput is capped: 64 KiB at 512 kbit/s takes about a second each way", async () => {
  const { proxy } = setup(0, 512);
  const c = await client(proxy.port);
  const t0 = performance.now();
  c.s.write(new Uint8Array(64 * 1024).fill(7));
  expect(await until(() => c.total() >= 64 * 1024, 6000)).toBe(true);
  const ms = c.got.at(-1)!.at - t0;
  // 64 KiB is 524,288 bits: about 1 s up and 1 s down, which overlap but for the first slice.
  expect(ms).toBeGreaterThanOrEqual(950);
  expect(ms).toBeLessThan(3500);
  c.s.end();
});

test("the bytes come through intact and in order under backpressure", async () => {
  const { proxy } = setup(5, 200_000);
  const c = await client(proxy.port);
  const data = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 9)) & 0xff;
  let off = 0;
  const writer = setInterval(() => {
    if (off >= data.length) return clearInterval(writer);
    const n = c.s.write(data.subarray(off, Math.min(data.length, off + 256 * 1024)));
    if (n > 0) off += n;
  }, 2);
  expect(await until(() => c.total() >= data.length, 15000)).toBe(true);
  clearInterval(writer);
  const back = c.bytes();
  expect(back.length).toBe(data.length);
  expect(Buffer.compare(Buffer.from(back), Buffer.from(data))).toBe(0);
  expect(proxy.stats().bytesUp).toBe(data.length);
  expect(proxy.stats().bytesDown).toBe(data.length);
  c.s.end();
});

test("a cut resets every connection at once, refuses new ones for the gap, and the link is back after it", async () => {
  const { proxy } = setup(20, 100_000);
  const a = await client(proxy.port);
  a.s.write("before");
  expect(await until(() => a.total() >= 6, 2000)).toBe(true);
  const gap = proxy.cut(600);
  expect(proxy.down).toBe(true);
  expect(await until(() => a.closed(), 1000)).toBe(true);
  // A connection made during the gap is reset at once and carries nothing.
  const b = await client(proxy.port).catch(() => null);
  if (b) {
    b.s.write("during");
    expect(await until(() => b.closed(), 1000)).toBe(true);
    expect(b.total()).toBe(0);
  }
  await gap;
  expect(proxy.down).toBe(false);
  const c = await client(proxy.port);
  c.s.write("after");
  expect(await until(() => c.total() >= 5, 2000)).toBe(true);
  expect(new TextDecoder().decode(c.bytes())).toBe("after");
  const st = proxy.stats();
  expect(st.cuts).toBe(1);
  expect(st.reset).toBeGreaterThanOrEqual(1);
  c.s.end();
});

test("a connection that a side ends is gone from the proxy, so a later cut resets nothing", async () => {
  const { proxy } = setup(30, 100_000);
  const a = await client(proxy.port);
  a.s.write("bye");
  expect(await until(() => a.total() >= 3, 2000)).toBe(true);
  expect(proxy.stats().open).toBe(1);
  a.s.end();
  expect(await until(() => proxy.stats().open === 0, 2000)).toBe(true);
  await proxy.cut(50);
  expect(proxy.stats().reset).toBe(0);
});

test("bytes on their way when the link is cut are lost, never delivered after the gap", async () => {
  const { proxy } = setup(300, 100_000);
  const a = await client(proxy.port);
  a.s.write("lost on the way");
  await Bun.sleep(50);
  await proxy.cut(400);
  await Bun.sleep(400);
  expect(a.total()).toBe(0);
  expect(a.closed()).toBe(true);
});

test("the proxy never forwards to or listens on another app's port", () => {
  for (const port of [7681, 7936, 7937, 7940]) {
    expect(() => startProxy({ to: port })).toThrow(/another app/);
    expect(() => startProxy({ to: 7946, listen: port })).toThrow(/another app/);
  }
  expect(() => startProxy({ to: 0 })).toThrow();
});
