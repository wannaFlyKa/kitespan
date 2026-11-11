// R130 (DESIGN-R130 4.4): the push files in the state folder (push-key.json, push-devices.json): 0600 through the
// store's atomic writer, the key made only at the first opt-in and never by a read, the devices (the same endpoint
// again, the cap of 20, a rename, Show chat titles, Turn off), a bad file set aside, and which subscriptions are taken.
// Every receiver key is a fresh one of the stub push service; the endpoints are the push services' public hosts with
// made-up paths, and nothing is sent anywhere.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUSH_LIMITS, pushDeviceId, pushDeviceName, pushHostOf } from "../../shared/push";
import { ownUid } from "../../server/store/files";
import { PUSH_FILES, PushStore, endpointProblem, pushTestOrigin, subscriptionOf } from "../../server/push/store";
import { startPushStub } from "../click/push-stub";

const ROOT = mkdtempSync(join(tmpdir(), "push-store-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const folder = () => mkdtempSync(join(ROOT, `s${++n}-`));
const stub = startPushStub();
const keysOf = () => stub.subscribe().keys;
const mode = (p: string) => statSync(p).mode & 0o777;

describe("the key file", () => {
  test("a read makes nothing; the first makeKey writes push-key.json 0600; the next one and a new store read the same key", async () => {
    const dir = folder();
    const s = new PushStore({ dir, uid: ownUid() });
    expect(await s.key()).toBeNull();
    expect(existsSync(join(dir, PUSH_FILES.key))).toBe(false);
    const made = await s.makeKey();
    const file = join(dir, PUSH_FILES.key);
    expect(mode(file)).toBe(0o600);
    const kept = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(kept).sort()).toEqual(["privateKey", "publicKey", "v"]);
    expect(kept.publicKey).toBe(made.publicKey);
    expect(await s.makeKey()).toEqual(made);
    expect(await new PushStore({ dir, uid: ownUid() }).key()).toEqual(made);
  });

  test("two first opt-ins at once make one key", async () => {
    const s = new PushStore({ dir: folder(), uid: ownUid() });
    const [a, b] = await Promise.all([s.makeKey(), s.makeKey()]);
    expect(a.publicKey).toBe(b.publicKey);
  });

  test("a bad key file is set aside; the new key starts an empty device list, since every subscription named the old one", async () => {
    const dir = folder();
    const s = new PushStore({ dir, uid: ownUid() });
    await s.makeKey();
    await s.add({ endpoint: "https://fcm.googleapis.com/fcm/send/aaa", ...keysOf() }, "Chrome");
    writeFileSync(join(dir, PUSH_FILES.key), JSON.stringify({ v: 1, publicKey: "x", privateKey: {} }), { mode: 0o600 });
    let setAside = 0;
    const t = new PushStore({ dir, uid: ownUid(), onSetAside: () => setAside++ });
    expect(await t.key()).toBeNull();
    expect(setAside).toBe(1);
    expect(existsSync(join(dir, `${PUSH_FILES.key}.bad`))).toBe(true);
    expect((await t.devices()).length).toBe(1);
    await t.makeKey();
    expect(await t.devices()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, PUSH_FILES.devices), "utf8"))).toEqual({ v: 1, devices: [] });
  });

  test("a key file that another user may read is set aside", async () => {
    const dir = folder();
    await new PushStore({ dir, uid: ownUid() }).makeKey();
    const file = join(dir, PUSH_FILES.key);
    writeFileSync(file, readFileSync(file), { mode: 0o644 });
    Bun.spawnSync(["chmod", "644", file]);
    expect(await new PushStore({ dir, uid: ownUid() }).key()).toBeNull();
  });
});

describe("the devices", () => {
  test("a device turns on: its id is its endpoint's hash, the file is 0600, titles start off", async () => {
    const dir = folder();
    const s = new PushStore({ dir, uid: ownUid(), now: () => new Date("2026-11-05T10:00:00.000Z") });
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
    const r = (await s.add({ endpoint, ...keysOf() }, "Chrome"))!;
    expect(r.added).toBe(true);
    expect(r.device).toMatchObject({ id: await pushDeviceId(endpoint), name: "Chrome", titles: false, at: "2026-11-05T10:00:00.000Z", failing: false });
    expect(r.device.id).toMatch(/^[a-z2-7]{16}$/);
    expect(mode(join(dir, PUSH_FILES.devices))).toBe(0o600);
    expect((await new PushStore({ dir, uid: ownUid() }).devices()).map((d) => d.endpoint)).toEqual([endpoint]);
  });

  test("the same endpoint again takes the new keys and keeps its name, titles and place", async () => {
    const s = new PushStore({ dir: folder(), uid: ownUid() });
    const a = "https://fcm.googleapis.com/fcm/send/one";
    await s.add({ endpoint: a, ...keysOf() }, "Chrome");
    await s.add({ endpoint: "https://web.push.apple.com/two", ...keysOf() }, "iPhone");
    const first = (await s.devices())[0]!;
    await s.update(first.id, { titles: true, name: "Laptop" });
    await s.markFailing(first.id, a, true);
    const fresh = keysOf();
    const again = (await s.add({ endpoint: a, ...fresh }, "Chrome 2"))!;
    expect(again.added).toBe(false);
    expect(again.device).toMatchObject({ name: "Laptop", titles: true, p256dh: fresh.p256dh, auth: fresh.auth, failing: false });
    expect((await s.devices()).map((d) => d.name)).toEqual(["Laptop", "iPhone"]);
  });

  test("at most 20; rename, titles and remove; an unknown id is null", async () => {
    const s = new PushStore({ dir: folder(), uid: ownUid() });
    for (let i = 0; i < PUSH_LIMITS.devices; i++) expect(await s.add({ endpoint: `https://fcm.googleapis.com/fcm/send/d${i}`, ...keysOf() }, `Device ${i}`)).not.toBeNull();
    expect(await s.add({ endpoint: "https://fcm.googleapis.com/fcm/send/over", ...keysOf() }, "Over")).toBeNull();
    const [d0] = await s.devices();
    expect((await s.update(d0!.id, { name: "Work laptop" }))!.name).toBe("Work laptop");
    expect((await s.update(d0!.id, { titles: true }))!.titles).toBe(true);
    expect(await s.update("aaaaaaaaaaaaaaaa", { titles: true })).toBeNull();
    expect((await s.remove(d0!.id))!.id).toBe(d0!.id);
    expect(await s.remove(d0!.id)).toBeNull();
    expect((await s.devices()).length).toBe(PUSH_LIMITS.devices - 1);
  });

  test("failing is marked only for the device of that endpoint", async () => {
    const s = new PushStore({ dir: folder(), uid: ownUid() });
    const endpoint = "https://updates.push.services.mozilla.com/wpush/v2/abc";
    const { device } = (await s.add({ endpoint, ...keysOf() }, "Firefox"))!;
    await s.markFailing(device.id, "https://updates.push.services.mozilla.com/wpush/v2/other", true);
    expect((await s.devices())[0]!.failing).toBe(false);
    await s.markFailing(device.id, endpoint, true);
    expect((await s.devices())[0]!.failing).toBe(true);
  });

  test("a devices file that fails its check is set aside, and the list starts empty", async () => {
    const dir = folder();
    writeFileSync(join(dir, PUSH_FILES.devices), JSON.stringify({ v: 1, devices: [{ id: "nope" }] }), { mode: 0o600 });
    let setAside = 0;
    const s = new PushStore({ dir, uid: ownUid(), onSetAside: () => setAside++ });
    expect(await s.devices()).toEqual([]);
    expect(setAside).toBe(1);
    expect(existsSync(join(dir, `${PUSH_FILES.devices}.bad`))).toBe(true);
  });
});

describe("which subscriptions kitespan takes", () => {
  const sub = (endpoint: string, keys = keysOf()) => ({ endpoint, keys, expirationTime: null });

  test("the push services of the list, at their default port over https", async () => {
    for (const e of [
      "https://fcm.googleapis.com/fcm/send/abc:APA91b",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGuQyavXutnMnaU5",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
    ])
      expect(await subscriptionOf(sub(e), null)).toMatchObject({ endpoint: e });
  });

  test("a host off the list is push_service; every other shape is bad", async () => {
    expect(await subscriptionOf(sub("https://push.example.net/abc"), null)).toBe("service");
    expect(await subscriptionOf(sub("https://fcm.googleapis.com:8443/fcm/send/abc"), null)).toBe("service");
    expect(await subscriptionOf(sub("https://evil.com/.push.apple.com"), null)).toBe("service");
    expect(await subscriptionOf(sub("https://push.apple.com.evil.com/abc"), null)).toBe("service");
    for (const e of ["http://fcm.googleapis.com/fcm/send/abc", ["https://user:pw", "fcm.googleapis.com/fcm/send/abc"].join("@"), "https://fcm.googleapis.com/fcm/send/abc#x", `https://fcm.googleapis.com/${"a".repeat(2048)}`, "fcm.googleapis.com/x", ""])
      expect(await subscriptionOf(sub(e), null)).toBe("bad");
    const keys = keysOf();
    const off = Buffer.from(keys.p256dh, "base64url");
    off[30] = off[30]! ^ 1;
    expect(await subscriptionOf(sub("https://fcm.googleapis.com/fcm/send/a", { ...keys, p256dh: off.toString("base64url") }), null)).toBe("bad");
    expect(await subscriptionOf(sub("https://fcm.googleapis.com/fcm/send/a", { ...keys, auth: Buffer.alloc(15).toString("base64url") }), null)).toBe("bad");
    expect(await subscriptionOf({ endpoint: "https://fcm.googleapis.com/fcm/send/a" }, null)).toBe("bad");
    expect(await subscriptionOf(null, null)).toBe("bad");
  });

  test("the test origin: only the exact loopback origin a test names, and only while it is named", async () => {
    expect(pushTestOrigin("http://127.0.0.1:4567")).toBe("http://127.0.0.1:4567");
    for (const v of [undefined, "", "http://localhost:4567", "https://127.0.0.1:4567", "http://127.0.0.1", "http://127.0.0.1:99999", "http://127.0.0.1:4567/", "http://10.0.0.1:4567"]) expect(pushTestOrigin(v)).toBeNull();
    const o = "http://127.0.0.1:4567";
    expect(endpointProblem(`${o}/push/s1`, o)).toBeNull();
    expect(endpointProblem(`${o}/push/s1`, null)).toBe("bad");
    expect(endpointProblem("http://127.0.0.1:4568/push/s1", o)).toBe("bad");
  });

  test("a device's id is the first 80 bits of its endpoint's SHA-256 in kitespan's base32", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
    const digest = new Bun.CryptoHasher("sha256").update(endpoint).digest();
    const bits = [...digest.subarray(0, 10)].map((b) => b.toString(2).padStart(8, "0")).join("");
    const want = bits.match(/.{5}/g)!.map((g) => "abcdefghijklmnopqrstuvwxyz234567"[parseInt(g, 2)]).join("");
    expect(await pushDeviceId(endpoint)).toBe(want);
    expect(want).toMatch(/^[a-z2-7]{16}$/);
  });

  test("the hosts and the names", () => {
    expect(pushHostOf("fcm.googleapis.com")).toBe("fcm");
    expect(pushHostOf("web.push.apple.com")).toBe("apple");
    expect(pushHostOf("push.apple.com")).toBeNull();
    expect(pushHostOf("db5p.notify.windows.com")).toBe("windows");
    expect(pushHostOf("updates.push.services.mozilla.com")).toBe("mozilla");
    expect(pushHostOf("googleapis.com")).toBeNull();
    expect(pushDeviceName("  Work\tlaptop\n ")).toBe("Work laptop");
    expect(pushDeviceName("x".repeat(40))).toBe("x".repeat(40));
    expect(pushDeviceName("x".repeat(41))).toBeNull();
    expect(pushDeviceName("\u0000\u0007")).toBeNull();
    expect(pushDeviceName(7)).toBeNull();
  });
});
