// R130 (DESIGN-R130 4.1, 4.3): one push to a device's push service, and the notify rule's marks. A stub push service
// (test/click/push-stub.ts) stands in for the browser's: it decrypts with node:crypto and checks the VAPID token, and
// the sender reaches it through an in-process stand-in for fetch, so nothing leaves this process. The server's key is
// a fresh one per test and never printed.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUSH_CONTACT, pushPayload, type PushMomentInput, type PushPayload } from "../../shared/push";
import { makeVapidKeys } from "../../server/push/crypto";
import { PushNotifier } from "../../server/push/notify";
import { PushSender, type PushLogFields } from "../../server/push/send";
import { PushStore } from "../../server/push/store";
import { ownUid } from "../../server/store/files";
import { startPushStub, type PushStub } from "../click/push-stub";

const ROOT = mkdtempSync(join(tmpdir(), "push-send-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const PAYLOAD: PushPayload = { v: 1, title: "Claude finished", body: "", tag: `c:${CHAT}`, url: `/c/${CHAT}` };

function target(stub: PushStub, id = "s1") {
  const s = stub.subscribe(id);
  return { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth };
}

describe("the push request", () => {
  test("one POST: aes128gcm to the subscription, padded to 256, the VAPID token for the service's origin, TTL, Urgency, Topic", async () => {
    const stub = startPushStub();
    const keys = await makeVapidKeys();
    const lines: PushLogFields[] = [];
    const sender = new PushSender({ fetch: stub.fetch, log: (f) => lines.push(f) });
    const r = await sender.send(target(stub), keys, PAYLOAD, { urgent: false, topic: CHAT });
    expect(r).toEqual({ kind: "sent", status: 201 });
    const [got] = stub.received;
    expect(got!.vapid).toBe("ok");
    expect(got!.k).toBe(keys.publicKey);
    expect(got!.claims!.aud).toBe(stub.origin);
    expect(got!.claims!.sub).toBe(PUSH_CONTACT);
    const left = (got!.claims!.exp as number) - Date.now() / 1000;
    expect(left).toBeGreaterThan(11.9 * 3600);
    expect(left).toBeLessThanOrEqual(12 * 3600);
    expect(JSON.parse(got!.plain!)).toEqual(PAYLOAD);
    expect(got!.padded).toBe(256);
    expect(got!.bytes).toBe(86 + 256 + 16);
    expect(got!.headers).toMatchObject({ "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "normal", topic: CHAT });
    expect(got!.headers.authorization).toBe("vapid t=eyJ0...");
    // The log line: the push service's host and the status, and the time; never the path, a key or the payload.
    expect(lines.length).toBe(1);
    expect(Object.keys(lines[0]!).sort()).toEqual(["host", "ms", "status"]);
    expect(lines[0]).toMatchObject({ host: "127.0.0.1", status: 201 });
    expect(JSON.stringify(lines)).not.toContain("/push/");
  });

  test("Urgency high while Claude waits; a longer payload pads to the next step", async () => {
    const stub = startPushStub();
    const sender = new PushSender({ fetch: stub.fetch });
    const long = { ...PAYLOAD, title: "x".repeat(120), body: "y".repeat(160) };
    await sender.send(target(stub), await makeVapidKeys(), long, { urgent: true, topic: CHAT });
    expect(stub.received[0]!.headers.urgency).toBe("high");
    expect(stub.received[0]!.padded).toBe(512);
  });

  test("redirect is an error and the deadline is a signal: the call never follows the push service elsewhere", async () => {
    const seen: RequestInit[] = [];
    const sender = new PushSender({
      fetch: async (_url, init) => {
        seen.push(init);
        return new Response(null, { status: 201 });
      },
    });
    const stub = startPushStub();
    await sender.send(target(stub), await makeVapidKeys(), PAYLOAD, { urgent: false, topic: CHAT });
    expect(seen[0]!.redirect).toBe("error");
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.method).toBe("POST");
    // Bun's verbose fetch would print the endpoint (its path is a capability) and the token (guard 5).
    expect((seen[0] as RequestInit & { verbose?: unknown }).verbose).toBe(false);
  });

  test("BUN_CONFIG_VERBOSE_FETCH set: a real send with Bun's fetch prints neither the endpoint's path nor the token", async () => {
    // A child Bun with the variable set sends one push to the stub on 127.0.0.1 (a port the system picks) and prints
    // only the result; whatever else reaches its stdout or stderr is Bun's verbose output.
    const root = join(import.meta.dir, "..", "..");
    const code = `
      const { PushSender } = await import(${JSON.stringify(join(root, "server/push/send.ts"))});
      const { makeVapidKeys } = await import(${JSON.stringify(join(root, "server/push/crypto.ts"))});
      const { startPushStub } = await import(${JSON.stringify(join(root, "test/click/push-stub.ts"))});
      const stub = startPushStub({ listen: true });
      const s = stub.subscribe("capability-path-of-the-test");
      const r = await new PushSender().send({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth }, await makeVapidKeys(), ${JSON.stringify(PAYLOAD)}, { urgent: false, topic: "t" });
      stub.stop();
      console.log("result " + r.kind + " " + r.status);
    `;
    const child = Bun.spawn([process.execPath, "-e", code], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", BUN_CONFIG_VERBOSE_FETCH: "1", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const all = out + err;
    expect(out.trim().split("\n").pop()).toBe("result sent 201");
    // Booleans, so that a failing run prints none of it.
    expect(all.includes("capability-path-of-the-test")).toBe(false);
    expect(all.toLowerCase().includes("vapid t=")).toBe(false);
    expect(all.includes("/push/")).toBe(false);
  });

  test("one JWT per origin, used again while it has more than an hour left, then a new one", async () => {
    let now = Date.UTC(2026, 10, 5, 9, 0, 0);
    const tokens: string[] = [];
    const sender = new PushSender({
      now: () => now,
      fetch: async (_url, init) => {
        tokens.push(String((init.headers as Record<string, string>).authorization));
        return new Response(null, { status: 201 });
      },
    });
    const stub = startPushStub();
    const keys = await makeVapidKeys();
    const t = target(stub);
    await sender.send(t, keys, PAYLOAD, { urgent: false, topic: CHAT });
    now += 10 * 3600_000;
    await sender.send(t, keys, PAYLOAD, { urgent: false, topic: CHAT });
    expect(tokens[1]).toBe(tokens[0]!);
    now += 1.5 * 3600_000;
    await sender.send(t, keys, PAYLOAD, { urgent: false, topic: CHAT });
    expect(tokens[2]).not.toBe(tokens[0]!);
    const other = await makeVapidKeys();
    await sender.send(t, other, PAYLOAD, { urgent: false, topic: CHAT });
    expect(tokens[3]).toContain(`k=${other.publicKey}`);
  });

  test("the answers: 2xx sent; 404 and 410 gone; 401 and 403 refused; 413, 429 and 5xx failed", async () => {
    const stub = startPushStub();
    const sender = new PushSender({ fetch: stub.fetch });
    const keys = await makeVapidKeys();
    const t = target(stub);
    const kinds: Record<number, string> = {};
    for (const status of [201, 202, 404, 410, 401, 403, 413, 429, 500, 503]) {
      stub.answer("s1", status);
      kinds[status] = (await sender.send(t, keys, PAYLOAD, { urgent: false, topic: CHAT })).kind;
    }
    expect(kinds).toEqual({ 201: "sent", 202: "sent", 404: "gone", 410: "gone", 401: "refused", 403: "refused", 413: "failed", 429: "failed", 500: "failed", 503: "failed" });
  });

  test("no answer: a network error, and the deadline (status 0, with which in the log line)", async () => {
    const lines: PushLogFields[] = [];
    const broken = new PushSender({ fetch: async () => Promise.reject(new TypeError("connection refused")), log: (f) => lines.push(f) });
    const stub = startPushStub();
    const keys = await makeVapidKeys();
    expect(await broken.send(target(stub), keys, PAYLOAD, { urgent: false, topic: CHAT })).toEqual({ kind: "failed", status: 0, answer: "network" });
    stub.hold();
    const slow = new PushSender({ fetch: stub.fetch, timeoutMs: 60, log: (f) => lines.push(f) });
    const t0 = Date.now();
    expect(await slow.send(target(stub, "s2"), keys, PAYLOAD, { urgent: false, topic: CHAT })).toEqual({ kind: "failed", status: 0, answer: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    stub.release();
    expect(lines.map((l) => [l.host, l.status, l.answer])).toEqual([
      ["127.0.0.1", 0, "network"],
      ["127.0.0.1", 0, "timeout"],
    ]);
  });

  test("at most 4 at once", async () => {
    const stub = startPushStub();
    let open = 0;
    let most = 0;
    const sender = new PushSender({
      fetch: async (url, init) => {
        most = Math.max(most, ++open);
        await Bun.sleep(20);
        open--;
        return stub.fetch(url, init);
      },
    });
    const keys = await makeVapidKeys();
    const t = target(stub);
    await Promise.all(Array.from({ length: 10 }, () => sender.send(t, keys, PAYLOAD, { urgent: false, topic: CHAT })));
    expect(most).toBe(4);
    expect(stub.received.length).toBe(10);
  });
});

describe("the notify rule's marks and the devices' answers", () => {
  async function world(devices = 1) {
    const stub = startPushStub();
    const store = new PushStore({ dir: mkdtempSync(join(ROOT, "n-")), uid: ownUid() });
    const gone: { host: string; status: number }[] = [];
    const lines: PushLogFields[] = [];
    const notifier = new PushNotifier({ store, sender: new PushSender({ fetch: stub.fetch, log: (f) => lines.push(f) }), testOrigin: stub.origin, logGone: (f) => gone.push(f) });
    await store.makeKey();
    const ids: string[] = [];
    for (let i = 1; i <= devices; i++) ids.push((await store.add({ ...target(stub, `s${i}`) }, `Device ${i}`))!.device.id);
    return { stub, store, notifier, gone, lines, ids };
  }
  const done: PushMomentInput = { chat: CHAT, moment: "done", title: "Fix the flaky upload test" };
  const plainOf = (stub: PushStub, i: number) => JSON.parse(stub.received[i]!.plain!) as PushPayload;

  test("no device on: nothing is sent and no mark is set", async () => {
    const stub = startPushStub();
    const store = new PushStore({ dir: mkdtempSync(join(ROOT, "n-")), uid: ownUid() });
    let calls = 0;
    const notifier = new PushNotifier({ store, sender: new PushSender({ fetch: async () => (calls++, new Response(null, { status: 201 })) }), testOrigin: stub.origin });
    notifier.moment(done);
    await notifier.idle();
    expect(calls).toBe(0);
    expect(notifier.markOf(CHAT)).toBeUndefined();
  });

  test("one per chat until seen; another kind replaces it through the tag; seen clears the mark", async () => {
    const { stub, notifier } = await world();
    notifier.moment(done);
    notifier.moment(done);
    await notifier.idle();
    expect(stub.received.length).toBe(1);
    notifier.moment({ ...done, moment: "permission", card: { kind: "permission", id: "toolu_01AbCdEf" } });
    notifier.moment({ ...done, moment: "input", card: { kind: "question", id: "toolu_01Other" } });
    await notifier.idle();
    expect(stub.received.length).toBe(2);
    expect(plainOf(stub, 1)).toEqual({ v: 1, title: "Claude needs your permission", body: "", tag: `c:${CHAT}`, url: `/c/${CHAT}/permission/toolu_01AbCdEf` });
    expect(stub.received[1]!.headers.urgency).toBe("high");
    notifier.seen(CHAT);
    notifier.moment(done);
    await notifier.idle();
    expect(stub.received.length).toBe(3);
    expect(plainOf(stub, 2).tag).toBe(`c:${CHAT}`);
  });

  test("a background session has its own mark and tag; seenBg and forget clear them", async () => {
    const { stub, notifier } = await world();
    const bg: PushMomentInput = { chat: CHAT, moment: "bg_needs", title: "Investigate", bg: { id: "7e682626", name: "investigate" } };
    notifier.moment(done);
    notifier.moment(bg);
    notifier.moment(bg);
    await notifier.idle();
    // The two pushes go out at the same time (up to 4 sends at once), so they reach the stub in either order.
    expect(stub.received.map((r) => JSON.parse(r.plain!).tag).sort()).toEqual([`c:${CHAT}`, `c:${CHAT}:bg:7e682626`]);
    const at = stub.received.findIndex((r) => JSON.parse(r.plain!).tag === `c:${CHAT}:bg:7e682626`);
    expect(stub.received[at]!.headers.topic).toBe(`${CHAT}7e682626`);
    expect(plainOf(stub, at).url).toBe(`/c/${CHAT}/background/7e682626`);
    notifier.seen(CHAT);
    notifier.moment(bg);
    await notifier.idle();
    expect(stub.received.length).toBe(2);
    notifier.seenBg(CHAT, "7e682626");
    notifier.moment(bg);
    await notifier.idle();
    expect(stub.received.length).toBe(3);
    notifier.forget(CHAT);
    expect(notifier.markOf(`${CHAT}:bg:7e682626`)).toBeUndefined();
    notifier.moment(done);
    await notifier.idle();
    expect(stub.received.length).toBe(4);
  });

  test("each device gets its own payload: Show chat titles adds the title", async () => {
    const { stub, store, notifier, ids } = await world(2);
    await store.update(ids[1]!, { titles: true });
    notifier.moment(done);
    await notifier.idle();
    const by = new Map(stub.received.map((r) => [r.id, JSON.parse(r.plain!) as PushPayload]));
    expect(by.get("s1")).toEqual({ v: 1, title: "Claude finished", body: "", tag: `c:${CHAT}`, url: `/c/${CHAT}` });
    expect(by.get("s2")).toEqual({ v: 1, title: "Fix the flaky upload test", body: "Claude finished", tag: `c:${CHAT}`, url: `/c/${CHAT}` });
  });

  test("410 removes the device (push_gone: the host and the status); 404 too", async () => {
    const { stub, store, notifier, gone } = await world(2);
    stub.answer("s1", 410);
    stub.answer("s2", 404);
    notifier.moment(done);
    await notifier.idle();
    expect(await store.devices()).toEqual([]);
    expect(gone.sort((a, b) => a.status - b.status)).toEqual([
      { host: "127.0.0.1", status: 404 },
      { host: "127.0.0.1", status: 410 },
    ]);
  });

  test("403 marks the device failing at once; other failures at the third in a row; a push that goes through clears it", async () => {
    const { stub, store, notifier } = await world(2);
    stub.answer("s1", 403);
    stub.answer("s2", 500);
    const kinds = ["done", "failed", "done"] as const;
    for (const [i, moment] of kinds.entries()) {
      notifier.moment({ ...done, moment });
      await notifier.idle();
      const [a, b] = await store.devices();
      expect([a!.failing, b!.failing]).toEqual([true, i === 2]);
    }
    stub.answer("s1", 201);
    stub.answer("s2", 201);
    notifier.moment({ ...done, moment: "failed" });
    await notifier.idle();
    expect((await store.devices()).map((d) => d.failing)).toEqual([false, false]);
  });

  test("a device whose endpoint is no longer one kitespan sends to is never called", async () => {
    const stub = startPushStub();
    const store = new PushStore({ dir: mkdtempSync(join(ROOT, "n-")), uid: ownUid() });
    await store.makeKey();
    await store.add({ ...target(stub) }, "Stub");
    let calls = 0;
    // The server restarted without the test origin: the stub's http endpoint is not taken any more.
    const notifier = new PushNotifier({ store, sender: new PushSender({ fetch: async () => (calls++, new Response(null, { status: 201 })) }), testOrigin: null });
    notifier.moment(done);
    await notifier.idle();
    expect(calls).toBe(0);
    expect(notifier.markOf(CHAT)).toBeUndefined();
  });
});

describe("the payload's words", () => {
  test("titles off: the moment's words only, never the chat's title; titles on: the title, then the words", () => {
    const m = (moment: PushMomentInput["moment"], extra: Partial<PushMomentInput> = {}): PushMomentInput => ({ chat: CHAT, moment, title: "Fix the flaky upload test", ...extra });
    expect(pushPayload(m("permission", { card: { kind: "permission", id: "toolu_1" } }), false).title).toBe("Claude needs your permission");
    expect(pushPayload(m("input", { card: { kind: "plan", id: "toolu_1" } }), false)).toEqual({ v: 1, title: "Claude needs your input", body: "", tag: `c:${CHAT}`, url: `/c/${CHAT}/plan/toolu_1` });
    expect(pushPayload(m("failed"), false).title).toBe("Claude did not finish");
    expect(pushPayload(m("bg_done", { bg: { id: "8a56ad66", name: "investigate" } }), false)).toEqual({ v: 1, title: "A background session finished", body: "", tag: `c:${CHAT}:bg:8a56ad66`, url: `/c/${CHAT}/background/8a56ad66` });
    expect(pushPayload(m("bg_failed", { bg: { id: "8a56ad66", name: "investigate" } }), true)).toMatchObject({ title: "Fix the flaky upload test", body: "investigate failed" });
    expect(pushPayload(m("bg_needs", { bg: { id: "8a56ad66", name: null } }), true).body).toBe("A background session needs your input");
    // No title known yet: the words, as with titles off.
    expect(pushPayload(m("done", { title: null }), true)).toMatchObject({ title: "Claude finished", body: "" });
    // A card id that a path cannot hold opens the chat.
    expect(pushPayload(m("input", { card: { kind: "dialog", id: "a/b" } }), false).url).toBe(`/c/${CHAT}`);
    expect(pushPayload(m("done", { title: `${"t".repeat(130)}` }), true).title.length).toBe(120);
  });
});
