// The slow-network proxy's black hole (scripts/net-proxy.ts silence(); DESIGN.md 9.4 done check 9): a plane's Wi-Fi
// that goes quiet without closing anything, which only the page's heartbeat can notice. No byte moves either way and
// no connection closes; a connection that opens meanwhile reaches nothing; when the link is back, what each side sent
// arrives in order, its end last, and a late retransmit (lateMs) holds the older connections' bytes longer. Also the
// link's profile changed at run time (a longer round trip). A server and the proxy each take a port the system picks.
import { afterEach, expect, test } from "bun:test";
import { startProxy, type NetProxy } from "../../scripts/net-proxy";

/** A server that echoes, and records each connection's bytes and whether it closed. */
function echoServer() {
  const conns: { got: string; closed: boolean }[] = [];
  const srv = Bun.listen<{ i: number }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { i: conns.push({ got: "", closed: false }) - 1 };
      },
      data(s, d) {
        conns[s.data.i]!.got += new TextDecoder().decode(d);
        s.write(d);
      },
      close(s) {
        conns[s.data.i]!.closed = true;
      },
    },
  });
  return { port: srv.port, conns, stop: () => srv.stop(true) };
}

async function client(port: number) {
  let got = "";
  let closed = false;
  const s = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, d) {
        got += new TextDecoder().decode(d);
      },
      close() {
        closed = true;
      },
      error() {
        closed = true;
      },
    },
  });
  return { s, got: () => got, closed: () => closed };
}

async function until(ok: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) return false;
    await Bun.sleep(10);
  }
  return true;
}

const open: { proxy: NetProxy; stop(): void }[] = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.proxy.stop();
    o.stop();
  }
});

function setup(delayMs = 10) {
  const echo = echoServer();
  const proxy = startProxy({ to: echo.port, delayMs, kbit: 100_000 });
  open.push({ proxy, stop: echo.stop });
  return { echo, proxy };
}

test("a silence moves no byte either way and closes nothing; when it ends, what was sent arrives in order", async () => {
  const { echo, proxy } = setup();
  const a = await client(proxy.port);
  a.s.write("before ");
  expect(await until(() => a.got() === "before ", 2000)).toBe(true);
  const quiet = proxy.silence(600);
  expect(proxy.silent).toBe(true);
  a.s.write("during-1 ");
  a.s.write("during-2");
  await Bun.sleep(400);
  // Nothing reached the server, nothing came back, and neither side was closed.
  expect(echo.conns[0]!.got).toBe("before ");
  expect(a.got()).toBe("before ");
  expect(a.closed()).toBe(false);
  expect(echo.conns[0]!.closed).toBe(false);
  expect(proxy.stats().open).toBe(1);
  await quiet;
  expect(proxy.silent).toBe(false);
  expect(await until(() => a.got() === "before during-1 during-2", 2000)).toBe(true);
  expect(echo.conns[0]!.got).toBe("before during-1 during-2");
  expect(proxy.stats().silences).toBe(1);
  expect(proxy.stats().reset).toBe(0);
  a.s.end();
});

test("an end sent into the silence arrives after the bytes before it, once the link is back", async () => {
  const { echo, proxy } = setup();
  const a = await client(proxy.port);
  a.s.write("x");
  expect(await until(() => echo.conns[0]?.got === "x", 2000)).toBe(true);
  const quiet = proxy.silence(400);
  a.s.write("last words");
  a.s.end();
  await Bun.sleep(250);
  expect(echo.conns[0]!.got).toBe("x");
  expect(echo.conns[0]!.closed).toBe(false);
  await quiet;
  expect(await until(() => echo.conns[0]!.closed, 2000)).toBe(true);
  expect(echo.conns[0]!.got).toBe("xlast words");
});

test("a connection made during a silence reaches nothing until it ends; one its client gave up never reaches the server", async () => {
  const { echo, proxy } = setup();
  const quiet = proxy.silence(500);
  const kept = await client(proxy.port);
  kept.s.write("hello");
  const gaveUp = await client(proxy.port);
  gaveUp.s.write("a dial that timed out");
  await Bun.sleep(150);
  gaveUp.s.end();
  await Bun.sleep(150);
  expect(echo.conns.length).toBe(0);
  expect(kept.got()).toBe("");
  expect(kept.closed()).toBe(false);
  await quiet;
  expect(await until(() => kept.got() === "hello", 2000)).toBe(true);
  await Bun.sleep(150);
  // Only the dial that waited for the link got through.
  expect(echo.conns.map((c) => c.got)).toEqual(["hello"]);
  kept.s.end();
});

test("with lateMs the WebSockets open before the silence get their bytes that much later; the rest go at once", async () => {
  const { echo, proxy } = setup();
  const upgrade = "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
  const old = await client(proxy.port);
  old.s.write(upgrade);
  expect(await until(() => old.got() === upgrade, 2000)).toBe(true);
  // An HTTP connection kept alive from before the silence is not a socket: it is not late.
  const keptAlive = await client(proxy.port);
  keptAlive.s.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  expect(await until(() => keptAlive.got().length > 0, 2000)).toBe(true);
  const quiet = proxy.silence(300, { lateMs: 700 });
  old.s.write("frame");
  keptAlive.s.write("again");
  await quiet;
  const back = performance.now();
  const fresh = await client(proxy.port);
  fresh.s.write("new");
  expect(await until(() => fresh.got() === "new", 1000)).toBe(true);
  expect(await until(() => keptAlive.got().endsWith("again"), 1000)).toBe(true);
  // The new connection and the HTTP one went through while the socket's bytes still wait for their late retransmit.
  expect(echo.conns[0]!.got).toBe(upgrade);
  expect(await until(() => old.got() === upgrade + "frame", 2000)).toBe(true);
  expect(performance.now() - back).toBeGreaterThanOrEqual(650);
  for (const c of [old, keptAlive, fresh]) c.s.end();
});

test("setLink changes the round trip of what is sent from then on", async () => {
  const { proxy } = setup(10);
  const a = await client(proxy.port);
  let t0 = performance.now();
  a.s.write("1");
  expect(await until(() => a.got() === "1", 2000)).toBe(true);
  expect(performance.now() - t0).toBeLessThan(200);
  proxy.setLink({ delayMs: 300 });
  expect(proxy.profile.delayMs).toBe(300);
  t0 = performance.now();
  a.s.write("2");
  expect(await until(() => a.got() === "12", 3000)).toBe(true);
  expect(performance.now() - t0).toBeGreaterThanOrEqual(580);
  a.s.end();
});
