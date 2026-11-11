// R130's server path on the real server, with no browser (FIX-R130 1): the main scene boots bin/kitespan with the fake
// claude and KITESPAN_PUSH_TEST_ORIGIN naming a stub push service on 127.0.0.1 (test/click/push-stub.ts), with
// NO_PROXY=127.0.0.1 so the call goes straight to it. A device turns on through the push routes with the stub's
// subscription; a turn of the example chat that ends while no page has it on screen sends exactly one encrypted push
// (the stub decrypts it and checks the VAPID token), through Bun's real fetch; a turn that ends with the chat on screen
// sends none; a 410 removes the device; the log line holds the push service's host and the status only. The main
// scene's own seeded device (at a host off the list) is never called. scripts/ui-check.ts's notify flow opens the same
// path in a browser. A stub page stands in for the built one; the port is KITESPAN_TEST_PORT or a free test port.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { LINUX_ONLY, PROCFS } from "../linux";
import { boot, pickTestPort, type Booted } from "./harness";
import { startPushStub } from "./push-stub";
import { WARM } from "./seed/fixture";
import { EX } from "./seed/ids";

const PORT = pickTestPort(7942);
const DIST = mkdtempSync(join(tmpdir(), "kitespan-click-stub-"));
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>stub page</body></html>");
const stub = startPushStub({ listen: true });
let h: Booted | null = null;
afterAll(async () => {
  if (h) await h.stop().catch(() => {});
  stub.stop();
  rmSync(DIST, { recursive: true, force: true });
});

type Frame = Record<string, any>;
const rid = () => crypto.randomUUID();

async function page(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
  const frames: Frame[] = [];
  ws.onmessage = (m) => {
    if (typeof m.data === "string") frames.push(JSON.parse(m.data) as Frame);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket did not open"));
  });
  const until = async (ok: () => boolean, what: string, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(20);
    }
  };
  const send = (f: Frame) => ws.send(JSON.stringify(f));
  send({ t: "hello", v: PROTOCOL_VERSION, tab: "push-seed" });
  await until(() => frames.some((f) => f.t === "chats" && "list" in f), "the chat list");
  send({ t: "attach", chat: EX.chat, since: 0, epoch: null });
  await until(() => frames.some((f) => f.t === "attached" && f.chat === EX.chat), "the attach");
  /** One message to the example chat and its turn's end. */
  const turn = async () => {
    const from = frames.length;
    const uuid = rid();
    send({ t: "send", rid: uuid, chat: EX.chat, uuid, text: WARM.main, draftRev: null, uploads: [] });
    await until(() => frames.slice(from).some((f) => f.t === "ev" && f.chat === EX.chat && f.e?.k === "turn_end"), "the turn's end");
  };
  return { frames, until, send, turn, close: () => ws.close() };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { origin: base, "x-kitespan": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test.skipIf(!PROCFS)(
  `a device turns on with the stub's subscription; one push when a turn ends unseen, none on screen; 410 removes the device ${LINUX_ONLY}`,
  async () => {
    h = await boot({ scene: "main", port: PORT, dist: DIST, env: { KITESPAN_PUSH_TEST_ORIGIN: stub.origin, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" } });
    const sub = stub.subscribe("laptop");
    const key = (await post(h.base, "/api/push/key", {})).body.key as string;
    const added = await post(h.base, "/api/push/devices", { subscription: sub, name: "Chrome" });
    expect(added.status).toBe(201);
    const p = await page(h.port);
    // The warm-up turn ended while the harness had the chat on screen: nothing was sent.
    expect(stub.received.length).toBe(0);
    await p.turn();
    const [got] = await stub.waitFor(1, 5_000);
    expect(got).toBeDefined();
    expect(got!.vapid).toBe("ok");
    expect(got!.k).toBe(key);
    expect(JSON.parse(got!.plain!)).toEqual({ v: 1, title: "Claude finished", body: "", tag: `c:${EX.chat}`, url: `/c/${EX.chat}` });
    expect(got!.headers).toMatchObject({ "content-encoding": "aes128gcm", ttl: "86400", urgency: "normal", topic: EX.chat });
    // A second end of the same kind, still unseen: no second push.
    await p.turn();
    await Bun.sleep(300);
    expect(stub.received.length).toBe(1);
    // On screen: seen, and an end then sends nothing.
    p.send({ t: "on_screen", chat: EX.chat, on: true });
    await Bun.sleep(100);
    await p.turn();
    await Bun.sleep(300);
    expect(stub.received.length).toBe(1);
    // Off screen, and the push service says the subscription is gone: the device goes; the seeded one stays.
    p.send({ t: "on_screen", chat: EX.chat, on: false });
    stub.answer("laptop", 410);
    await p.turn();
    await stub.waitFor(2, 5_000);
    await Bun.sleep(200);
    const after = (await (await fetch(`${h.base}/api/push`)).json()) as { devices: { id: string }[] };
    expect(after.devices.map((d) => d.id)).toEqual([EX.device]);
    p.close();
    // The log: the host and the status only, never the endpoint's path, a key or the payload.
    const logs = join(h.seed.state, "logs");
    const text = readdirSync(logs)
      .filter((n) => n.endsWith(".log"))
      .map((n) => readFileSync(join(logs, n), "utf8"))
      .join("");
    const pushes = text
      .split("\n")
      .filter((l) => l.includes('"ev":"push'))
      .map((l) => JSON.parse(l) as Frame);
    expect(pushes.filter((l) => l.ev === "push").map((l) => [l.host, l.status])).toEqual([
      ["127.0.0.1", 201],
      ["127.0.0.1", 410],
    ]);
    expect(pushes.filter((l) => l.ev === "push_gone").map((l) => [l.host, l.status])).toEqual([["127.0.0.1", 410]]);
    expect(pushes.filter((l) => l.ev === "push_device").map((l) => l.answer)).toEqual(["added"]);
    for (const secret of ["/push/laptop", sub.keys.p256dh, sub.keys.auth, key, "Claude finished", "Chrome", "seed-device"]) expect(text).not.toContain(secret);
  },
  60_000,
);
