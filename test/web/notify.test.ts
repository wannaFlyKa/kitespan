// Notifications on the page (owner rows 128 and 130; DESIGN-R130 sections 4.5 and 8): whether this browser can get them
// (tested in the design's order and never from the User-Agent: an insecure origin first, since Chrome reports it as
// denied; then the four parts a browser needs; then a blocked permission), the default device name (from the push
// service and the size class) and the device id (the server's, from the endpoint), the turn-on order with fakes (the
// permission prompt first with nothing awaited before it; then the worker's registration, the key from the read or the
// first POST, a fresh subscription, the device's POST) and its failures (each leaves no subscription and no
// registration), the turn-off order (unsubscribe, remove, unregister), the worker's `{open}` message (only a path the
// route decoder takes for a chat, a card or a background session), and the close of this device's notifications by tag,
// which the store does when the page's on_screen for the chat goes out.
import { afterAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, resetState } from "../../web/state/store";
import { ApiError, apiPattern } from "../../web/net/api";
import { cleanRead, type PushApi, type PushDevice } from "../../web/notify/api";
import { fromB64u, readThisDevice, turnOffThis, turnOn, type PushBrowser, type RegistrationLike, type SubscriptionLike } from "../../web/notify/device";
import { gateLine, gateOf, listsDevices, readEnv, type NotifyEnv } from "../../web/notify/gate";
import { readSection } from "../../web/notify/useNotify";
import { DEVICE_ID, cleanName, defaultName, deviceIdOf, pushServiceOf } from "../../web/notify/names";
import { closeShown, listenForOpen, notificationTag, openPathOf } from "../../web/notify/worker";
import { pushDeviceId } from "../../shared/push";
import { NOTIFY_WORDS } from "../../web/notify/words";

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const ENV: NotifyEnv = { secure: true, serviceWorker: true, pushManager: true, notification: true, showNotification: true, permission: "default" };

describe("whether this browser can get notifications (in this order, never the User-Agent)", () => {
  test("an insecure origin first, even though Chrome reports its permission as denied there", () => {
    expect(gateOf({ ...ENV, secure: false, serviceWorker: false, permission: "denied" })).toBe("insecure");
    expect(gateOf({ ...ENV, secure: false })).toBe("insecure");
  });
  test("then each of the four parts a browser needs; then a blocked permission; else it can", () => {
    for (const part of ["serviceWorker", "pushManager", "notification", "showNotification"] as const) expect(gateOf({ ...ENV, [part]: false, permission: "denied" })).toBe("unsupported");
    expect(gateOf({ ...ENV, permission: "denied" })).toBe("denied");
    expect(gateOf(ENV)).toBe("ok");
    expect(gateOf({ ...ENV, permission: "granted" })).toBe("ok");
  });
  test("reading the browser asks nothing: a missing global reads as missing", () => {
    expect(readEnv({})).toEqual({ secure: false, serviceWorker: false, pushManager: false, notification: false, showNotification: false, permission: null });
    class Reg {
      showNotification() {}
    }
    function PushManager() {}
    function Notification() {}
    Notification.permission = "granted";
    expect(readEnv({ isSecureContext: true, navigator: { serviceWorker: {} }, PushManager, Notification, ServiceWorkerRegistration: Reg })).toEqual({ ...ENV, permission: "granted" });
    // The phone's company browser: no Notification and no push.
    expect(gateOf(readEnv({ isSecureContext: true, navigator: {} }))).toBe("unsupported");
  });
  test("each state's one line, word for word", () => {
    expect(gateLine("insecure")).toBe("Notifications need kitespan on HTTPS, or at 127.0.0.1 or localhost.");
    expect(gateLine("unsupported")).toBe("This browser cannot get notifications. On an iPhone or iPad, add kitespan to the Home Screen from Safari and turn them on there.");
    expect(gateLine("denied")).toBe("Notifications from kitespan are blocked here. Allow them in this browser's or this device's settings.");
    expect(gateLine("ok")).toBe(null);
    expect(NOTIFY_WORDS.titlesLine).toBe("Encrypted end to end, so the push service cannot read them, but the lock screen shows them.");
    expect([NOTIFY_WORDS.unreached, NOTIFY_WORDS.offList, NOTIFY_WORDS.failing]).toEqual([
      "This browser could not reach its push service. Try again later.",
      "kitespan does not send to this browser's push service.",
      "The last notification did not go through.",
    ]);
  });
});

describe("the default name and the id", () => {
  const APPLE = "https://web.push.apple.com/QGuQyavXutnMH8Mq0dsw";
  const FCM = "https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM:APA91b";
  const WNS = "https://wns2-by3p.notify.windows.com/w/?token=BQYAAAB";
  const MOZ = "https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB";
  test("the push service from the endpoint's host", () => {
    expect([APPLE, FCM, WNS, MOZ, "http://127.0.0.1:40001/push/a", "not a url", "https://fcm.googleapis.com.evil.test/x", "http://fcm.googleapis.com/x"].map(pushServiceOf)).toEqual(["apple", "fcm", "windows", "mozilla", null, null, null, null]);
  });
  test("the size class picks the word: the phone, a touch device that is not a phone, a laptop", () => {
    expect([defaultName(APPLE, "phone", true, []), defaultName(APPLE, "medium", true, []), defaultName(APPLE, "laptop", true, []), defaultName(APPLE, "laptop", false, [])]).toEqual(["iPhone", "iPad", "iPad", "Mac"]);
    expect([defaultName(FCM, "phone", true, []), defaultName(FCM, "medium", true, []), defaultName(FCM, "laptop", false, [])]).toEqual(["Android phone", "Android tablet", "Chrome"]);
    expect([defaultName(WNS, "laptop", false, []), defaultName(MOZ, "phone", true, []), defaultName("http://127.0.0.1:40001/push/a", "laptop", false, [])]).toEqual(["Edge", "Firefox", "Browser"]);
  });
  test("a name another device has gets \" 2\", \" 3\" and so on", () => {
    expect(defaultName(FCM, "laptop", false, ["Chrome"])).toBe("Chrome 2");
    expect(defaultName(FCM, "laptop", false, ["chrome", "Chrome 2", "iPhone"])).toBe("Chrome 3");
  });
  test("a name holds at most 40 characters and no control character", () => {
    expect(cleanName("  Personal\tiPhone\u0007 ")).toBe("Personal iPhone");
    expect(cleanName("x".repeat(50))).toBe("x".repeat(40));
  });
  test("the id is the server's own (shared/push.ts): 16 symbols of kitespan's id alphabet from the endpoint's hash", async () => {
    expect(deviceIdOf).toBe(pushDeviceId);
    const a = await deviceIdOf(FCM);
    expect(a).toMatch(DEVICE_ID);
    expect(await deviceIdOf(FCM)).toBe(a);
    expect(await deviceIdOf(APPLE)).not.toBe(a);
  });
});

// ---- the turn-on and turn-off orders, with fakes

const KEY = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const SUB_JSON = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BNcR", auth: "tBHI" } };
const DEVICE: PushDevice = { id: "aaaabbbbccccdddd", name: "Chrome", titles: false, at: "2026-11-05T10:00:00.000Z", failing: false };

function fakes(over: { permission?: "granted" | "denied" | "default"; subscribe?: "ok" | "fail"; add?: "ok" | "push_service" | "bad"; key?: "ok" | "fail"; old?: boolean } = {}) {
  const log: string[] = [];
  const sub = (endpoint: string): SubscriptionLike => ({
    endpoint,
    toJSON: () => ({ ...SUB_JSON, endpoint }),
    unsubscribe: async () => {
      log.push(`unsubscribe ${endpoint.slice(-3)}`);
      return true;
    },
  });
  let current: SubscriptionLike | null = over.old ? sub("https://fcm.googleapis.com/fcm/send/old") : null;
  let registered = false;
  const reg: RegistrationLike = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async (o) => {
        log.push(`subscribe ${o.userVisibleOnly} ${o.applicationServerKey.length}`);
        if (over.subscribe === "fail") throw new DOMException("no", "AbortError");
        current = sub(SUB_JSON.endpoint);
        return current;
      },
    },
    unregister: async () => {
      log.push("unregister");
      registered = false;
      return true;
    },
  };
  const browser: PushBrowser = {
    requestPermission: () => {
      log.push("requestPermission");
      return Promise.resolve(over.permission ?? "granted");
    },
    registration: async () => (registered ? reg : null),
    register: async () => {
      log.push("register");
      registered = true;
      return reg;
    },
  };
  const api: PushApi = {
    read: async () => ({ key: null, devices: [] }),
    makeKey: async () => {
      log.push("POST key");
      if (over.key === "fail") throw new ApiError(500, "failed", "That did not work.");
      return KEY;
    },
    add: async (s, name) => {
      log.push(`POST device ${s.endpoint.slice(-3)} ${name}`);
      if (over.add === "push_service") throw new ApiError(400, "push_service", "That push service is not on the list.");
      if (over.add === "bad") throw new ApiError(400, "bad_request", "That request was not valid.");
      return DEVICE;
    },
    change: async () => DEVICE,
    remove: async (id) => {
      log.push(`POST remove ${id}`);
    },
  };
  return { log, browser, api, reg, isRegistered: () => registered, current: () => current };
}

describe("turning on, from the user's own tap", () => {
  test("the permission prompt comes first, with nothing awaited before it", () => {
    const f = fakes();
    void turnOn({ browser: f.browser, api: f.api, key: null, name: () => "Chrome" });
    // Synchronously, inside the tap's handler.
    expect(f.log).toEqual(["requestPermission"]);
  });

  test("then the worker, the key (the first POST makes it), a subscription with the key, the device's POST", async () => {
    const f = fakes();
    const r = await turnOn({ browser: f.browser, api: f.api, key: null, name: (e) => (e.endsWith("abc") ? "Chrome" : "?") });
    expect(r).toEqual({ ok: true, device: DEVICE, key: KEY });
    expect(f.log).toEqual(["requestPermission", "register", "POST key", "subscribe true 65", "POST device abc Chrome"]);
  });

  test("a key the read had: no POST for it; an older subscription of this browser goes first", async () => {
    const f = fakes({ old: true });
    await turnOn({ browser: f.browser, api: f.api, key: KEY, name: () => "Chrome" });
    expect(f.log).toEqual(["requestPermission", "register", "unsubscribe old", "subscribe true 65", "POST device abc Chrome"]);
  });

  test("denied: the denied line; dismissed: no line; neither registers anything", async () => {
    const d = fakes({ permission: "denied" });
    expect(await turnOn({ browser: d.browser, api: d.api, key: null, name: () => "x" })).toEqual({ ok: false, why: "denied", line: NOTIFY_WORDS.denied });
    expect(d.log).toEqual(["requestPermission"]);
    const n = fakes({ permission: "default" });
    expect(await turnOn({ browser: n.browser, api: n.api, key: null, name: () => "x" })).toEqual({ ok: false, why: "dismissed", line: null });
    expect(n.log).toEqual(["requestPermission"]);
  });

  test("a subscription that fails gives the push service's line and leaves no registration", async () => {
    const f = fakes({ subscribe: "fail" });
    expect(await turnOn({ browser: f.browser, api: f.api, key: KEY, name: () => "x" })).toEqual({ ok: false, why: "unreached", line: NOTIFY_WORDS.unreached });
    expect(f.log.at(-1)).toBe("unregister");
    expect(f.isRegistered()).toBe(false);
  });

  test("the server's refusal: a push service off its list has its own line; each leaves no subscription and no registration", async () => {
    const off = fakes({ add: "push_service" });
    expect(await turnOn({ browser: off.browser, api: off.api, key: KEY, name: () => "x" })).toEqual({ ok: false, why: "off_list", line: NOTIFY_WORDS.offList });
    expect(off.log.slice(-2)).toEqual(["unsubscribe abc", "unregister"]);
    const bad = fakes({ add: "bad" });
    expect(await turnOn({ browser: bad.browser, api: bad.api, key: KEY, name: () => "x" })).toEqual({ ok: false, why: "server", line: "That request was not valid." });
    const key = fakes({ key: "fail" });
    expect(await turnOn({ browser: key.browser, api: key.api, key: null, name: () => "x" })).toEqual({ ok: false, why: "server", line: "That did not work." });
    expect(key.isRegistered()).toBe(false);
  });
});

describe("this device's state and turning it off", () => {
  test("no registration: no subscription and no id, and nothing is registered by the read", async () => {
    const f = fakes();
    expect(await readThisDevice(f.browser)).toEqual({ id: null, endpoint: null });
    expect(f.log).toEqual([]);
  });

  test("a subscription: its id is the server's id of its endpoint", async () => {
    const f = fakes();
    await turnOn({ browser: f.browser, api: f.api, key: KEY, name: () => "x" });
    expect(await readThisDevice(f.browser)).toEqual({ id: await deviceIdOf(SUB_JSON.endpoint), endpoint: SUB_JSON.endpoint });
  });

  test("off: unsubscribe, then the server's remove, then unregister, so nothing of kitespan stays in the browser", async () => {
    const f = fakes();
    await turnOn({ browser: f.browser, api: f.api, key: KEY, name: () => "x" });
    f.log.length = 0;
    expect(await turnOffThis({ browser: f.browser, api: f.api, id: "aaaabbbbccccdddd" })).toBe(null);
    expect(f.log).toEqual(["unsubscribe abc", "POST remove aaaabbbbccccdddd", "unregister"]);
    expect(f.isRegistered()).toBe(false);
  });

  test("off when the server no longer has the device (a 404 from its remove, after a 410 took it): off, with no line", async () => {
    const f = fakes();
    await turnOn({ browser: f.browser, api: f.api, key: KEY, name: () => "x" });
    f.api.remove = async () => {
      throw new ApiError(404, "not_found", "That device is not here.");
    };
    expect(await turnOffThis({ browser: f.browser, api: f.api, id: "aaaabbbbccccdddd" })).toBe(null);
    expect(f.isRegistered()).toBe(false);
    // Any other refusal still gives the server's line.
    await turnOn({ browser: f.browser, api: f.api, key: KEY, name: () => "x" });
    f.api.remove = async () => {
      throw new ApiError(500, "failed", "That did not work.");
    };
    expect(await turnOffThis({ browser: f.browser, api: f.api, id: "aaaabbbbccccdddd" })).toBe("That did not work.");
  });
});

describe("the section's read, by what this browser can do", () => {
  const PHONE: PushDevice = { ...DEVICE, id: "eeeeffffgggghhhh", name: "iPhone" };
  const counting = () => {
    const f = fakes();
    let reads = 0;
    let looks = 0;
    const api: PushApi = { ...f.api, read: async () => (reads++, { key: KEY, devices: [PHONE] }) };
    const browser: PushBrowser = { ...f.browser, registration: async () => (looks++, f.browser.registration()) };
    return { api, browser, reads: () => reads, looks: () => looks };
  };

  test("the list wherever the section shows it: this browser can get them, its permission is blocked, or the origin is not secure", () => {
    expect((["ok", "denied", "insecure", "unsupported"] as const).map(listsDevices)).toEqual([true, true, true, false]);
  });

  test("ok: the server's list and this browser's own subscription", async () => {
    const c = counting();
    expect(await readSection("ok", c.api, () => c.browser)).toEqual({ key: KEY, devices: [PHONE], mine: null });
    expect([c.reads(), c.looks()]).toEqual([1, 1]);
  });

  test("blocked or insecure: the server's list only, so another device can be turned off from here; this browser is never read", async () => {
    for (const gate of ["denied", "insecure"] as const) {
      const c = counting();
      expect(await readSection(gate, c.api, () => c.browser)).toEqual({ key: KEY, devices: [PHONE], mine: null });
      expect([c.reads(), c.looks()]).toEqual([1, 0]);
    }
  });

  test("a browser with no push (the phone's company browser): its line and nothing more, so nothing is read", async () => {
    const c = counting();
    expect(await readSection("unsupported", c.api, () => c.browser)).toBeNull();
    expect([c.reads(), c.looks()]).toEqual([0, 0]);
  });
});

describe("the server's answers as the page reads them", () => {
  test("a push device's path is recorded with :device, never its id", () => {
    expect(apiPattern("/api/push/devices/k3m7q2x4abk3m7q2")).toBe("/api/push/devices/:device");
    expect(apiPattern("/api/push/devices/k3m7q2x4abk3m7q2/remove")).toBe("/api/push/devices/:device/remove");
    expect(apiPattern("/api/push/devices")).toBe("/api/push/devices");
    expect(apiPattern("/api/uploads/k3m7q2x4abk3m7q2")).toBe("/api/uploads/:upload");
  });
  test("a read keeps the fields it knows and drops what it does not; it never holds an endpoint", () => {
    expect(cleanRead({ key: KEY, devices: [{ ...DEVICE, endpoint: "https://x" }, { id: 1 }, null] })).toEqual({ key: KEY, devices: [DEVICE] });
    expect(cleanRead({ key: null })).toEqual({ key: null, devices: [] });
    expect(cleanRead("nonsense")).toEqual({ key: null, devices: [] });
  });
  test("the key's base64url turns into its 65 octets", () => {
    expect(fromB64u(KEY)?.length).toBe(65);
    expect(fromB64u("not base64url!")).toBe(null);
  });
});

describe("the worker's messages and this device's shown notifications", () => {
  test("{open} opens a chat, a card's own path, a background session's view or Home, and nothing else", () => {
    expect(openPathOf({ open: `/c/${CHAT}` })).toBe(`/c/${CHAT}`);
    expect(openPathOf({ open: "/" })).toBe("/");
    expect(openPathOf({ open: `/c/${CHAT}/permission/toolu_01AbCdEf` })).toBe(`/c/${CHAT}/permission/toolu_01AbCdEf`);
    for (const k of ["question", "plan", "elicitation", "dialog"]) expect(openPathOf({ open: `/c/${CHAT}/${k}/req_01` })).toBe(`/c/${CHAT}/${k}/req_01`);
    expect(openPathOf({ open: `/c/${CHAT}/background/3f9a1c2e` })).toBe(`/c/${CHAT}/background/3f9a1c2e`);
    for (const bad of [`/c/${CHAT}/send?text=hi`, `/c/${CHAT}/delete`, `/c/${CHAT}/archive`, "/settings", "https://example.com/", "//example.com", `/c/nope`, `/c/${CHAT}/permission/a b`, 42, null])
      expect(openPathOf({ open: bad })).toBe(null);
    expect(openPathOf(`/c/${CHAT}`)).toBe(null);
  });

  test("the page navigates on a good message only, and says it listens", () => {
    const went: string[] = [];
    let fn: ((e: { data: unknown; origin?: string }) => void) | null = null;
    let started = false;
    listenForOpen((p) => went.push(p), {
      addEventListener: (_t, f) => (fn = f),
      startMessages: () => (started = true),
      getRegistration: async () => undefined,
    });
    expect(started).toBe(true);
    fn!({ data: { open: `/c/${CHAT}` } });
    fn!({ data: { open: `/c/${CHAT}/delete` } });
    expect(went).toEqual([`/c/${CHAT}`]);
  });

  test("the tags, and a close of the shown ones with a tag; with no registration nothing happens", async () => {
    expect([notificationTag(CHAT), notificationTag(CHAT, "3f9a1c2e")]).toEqual([`c:${CHAT}`, `c:${CHAT}:bg:3f9a1c2e`]);
    const closed: string[] = [];
    const asked: (string | undefined)[] = [];
    const sw = {
      addEventListener() {},
      getRegistration: async () => ({
        getNotifications: async (o?: { tag?: string }) => {
          asked.push(o?.tag);
          return [{ close: () => closed.push("a") }, { close: () => closed.push("b") }];
        },
      }),
    };
    expect(await closeShown(`c:${CHAT}`, sw)).toBe(2);
    expect([asked, closed]).toEqual([[`c:${CHAT}`], ["a", "b"]]);
    expect(await closeShown(`c:${CHAT}`, { addEventListener() {}, getRegistration: async () => undefined })).toBe(0);
    expect(await closeShown(`c:${CHAT}`, null)).toBe(0);
  });
});

// ---- the store: an `on` that goes out closes this device's notifications of that chat

class NtSocket implements SocketLike {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {}
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

describe("once seen on this device", () => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(nav, "serviceWorker");
  afterAll(() => {
    if (had) Object.defineProperty(nav, "serviceWorker", had);
    else delete nav.serviceWorker;
    connectWith(null);
    resetState();
  });

  test("the chat's on_screen closes its shown notifications (tag c:<chat>); an off closes none", async () => {
    const asked: (string | undefined)[] = [];
    const closed: string[] = [];
    Object.defineProperty(nav, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener() {},
        getRegistration: async () => ({
          getNotifications: async (o?: { tag?: string }) => {
            asked.push(o?.tag);
            return [{ close: () => closed.push(o?.tag ?? "") }];
          },
        }),
      },
    });
    resetState();
    const sock = new NtSocket();
    const conn = new Connection({ url: "ws://127.0.0.1:7945/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
    connectWith(conn);
    conn.start();
    sock.onopen?.({});
    sock.receive({ t: "welcome", epoch: "lz2k3m-abcdefghijkl", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.318", drift: null }, update: { available: false }, auth: "none" });
    sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Fix the upload", project: "k3m7q2x4ab", state: "idle", needsYou: false, lastActivity: "2026-11-05T10:00:00.000Z", archived: false }] });
    act.open(CHAT);
    sock.receive({ t: "attached", chat: CHAT, epoch: "lz2k3m-abcdefghijkl", state: "idle", seq: 3, cards: [], picks: { model: null, effort: null, mode: null }, title: { text: "Fix the upload", from: "renamed" }, draft: { rev: 1, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-11-05T10:00:00.000Z" }, archived: false, replay: "snapshot" });
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    act.onScreen(CHAT, true);
    await Bun.sleep(10);
    expect(sock.sent.filter((f) => f.t === "on_screen") as unknown[]).toEqual([{ t: "on_screen", chat: CHAT, on: true }]);
    expect([asked, closed]).toEqual([[`c:${CHAT}`], [`c:${CHAT}`]]);
    act.onScreen(CHAT, false);
    await Bun.sleep(10);
    expect(asked).toHaveLength(1);
  });
});
