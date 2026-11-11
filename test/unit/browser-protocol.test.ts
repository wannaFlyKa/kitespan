// The browser pane's wire (DESIGN-B1 3, 2.7.2): parseBrowserFrame takes exactly the frames of 3.3 with every field
// checked and capped, and refuses every other shape; the URL rule; the Fetch block's origin test; the binary frame;
// and the route table's browser views.
import { describe, expect, test } from "bun:test";
import {
  BROWSER_CLIENT_FRAME_TYPES,
  BROWSER_LIMITS,
  BROWSER_REQUEST_TYPES,
  browserMcpCommand,
  browserUrlProblem,
  decodeCastFrame,
  encodeCastFrame,
  isLoopbackHost,
  isOwnBrowserUrl,
  normalBrowserUrl,
  parseBrowserFrame,
  pickValueOk,
  type CastHeader,
} from "../../shared/browser";
import { BROWSER_TAB_ID, isBrowserDownloadId, isBrowserTabId, newBrowserDownloadId, newBrowserTabId } from "../../shared/ids";
import { PROTOCOL_VERSION, WIRE } from "../../shared/protocol";
import { href, isAppPath, pairAllowed, paneKindOf, paneRouteOf, parsePath, PANEL_ROUTES, ROUTE_BY_NAME, SETTINGS_SECTIONS } from "../../shared/route";

const TAB = "q2x4abk3m7";
const RID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const UP = "k3m7q2x4abk3m7q2";
const DL = "abcdefghijk23456";
const C = "k3m7q2x4abk3m7q2x4ab";

const parse = (o: unknown) => parseBrowserFrame(JSON.stringify(o));
// The clean copy, loosely typed: the tests compare it with plain objects.
const ok = (o: unknown): any => {
  const r = parse(o);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.frame;
};
const refused = (o: unknown) => parse(o).ok === false;

/** One good frame of each type, and the clean copy that parsing gives. */
const GOOD: Record<string, Record<string, unknown>> = {
  open: { t: "open", v: PROTOCOL_VERSION },
  view: { t: "view", tab: TAB, w: 390.5, h: 600, dpr: 2, q: 50, credit: 1 },
  unview: { t: "unview", tab: TAB },
  drawn: { t: "drawn", tab: TAB, n: 12 },
  tab_new: { t: "tab_new", rid: RID },
  tab_close: { t: "tab_close", rid: RID, tab: TAB },
  tab_size: { t: "tab_size", rid: RID, tab: TAB, kind: "desktop" },
  navigate: { t: "navigate", rid: RID, tab: TAB, url: "https://example.com/" },
  back: { t: "back", rid: RID, tab: TAB },
  forward: { t: "forward", rid: RID, tab: TAB },
  reload: { t: "reload", rid: RID, tab: TAB },
  stop: { t: "stop", rid: RID, tab: TAB },
  opener: { t: "opener", rid: RID, tab: TAB },
  mouse: { t: "mouse", tab: TAB, n: 3, type: "mousePressed", x: 10, y: 20, button: "left", clicks: 1 },
  touch: { t: "touch", tab: TAB, n: 3, type: "touchStart", points: [{ x: 1, y: 2, id: 0 }] },
  key: { t: "key", tab: TAB, n: 3, type: "keyDown", key: "a", code: "KeyA", vk: 65, text: "a" },
  text: { t: "text", tab: TAB, n: 3, text: "hello\nthere" },
  pick: { t: "pick", rid: RID, tab: TAB, id: 1, index: 2 },
  pick_cancel: { t: "pick_cancel", rid: RID, tab: TAB, id: 1 },
  dialog_answer: { t: "dialog_answer", rid: RID, tab: TAB, id: 1, accept: true },
  chooser_answer: { t: "chooser_answer", rid: RID, tab: TAB, id: 1, uploads: [UP] },
  chooser_cancel: { t: "chooser_cancel", rid: RID, tab: TAB, id: 1 },
  chooser_leave: { t: "chooser_leave", rid: RID, tab: TAB, id: 1 },
  download_cancel: { t: "download_cancel", rid: RID, id: DL },
  ping: { t: "ping", n: 0 },
};

describe("the ids and the socket path", () => {
  test("a tab id is 10 of [a-z2-7]; a download id 16", () => {
    expect(BROWSER_TAB_ID.test(newBrowserTabId())).toBe(true);
    expect(isBrowserDownloadId(newBrowserDownloadId())).toBe(true);
    for (const bad of ["t_1", "Q2X4ABK3M7", "q2x4abk3m", "q2x4abk3m78", "q2x4abk3m1", 7, null]) expect(isBrowserTabId(bad)).toBe(false);
    expect(WIRE.browserPath).toBe("/ws/browser");
  });
});

describe("parseBrowserFrame: the frames of DESIGN-B1 3.3", () => {
  test("every type parses to exactly its known fields; unknown fields are dropped", () => {
    expect(Object.keys(GOOD).sort()).toEqual([...BROWSER_CLIENT_FRAME_TYPES].sort());
    for (const [t, f] of Object.entries(GOOD)) {
      expect([t, ok({ ...f, method: "Runtime.evaluate", expression: "1", sessionId: "x", targetId: "y", commands: ["selectAll"] })]).toEqual([t, f]);
    }
  });
  test("requests carry a rid; the rest carry none", () => {
    for (const t of BROWSER_REQUEST_TYPES) {
      expect([t, "rid" in GOOD[t]!]).toEqual([t, true]);
      const { rid: _, ...without } = GOOD[t]!;
      expect([t, refused(without)]).toEqual([t, true]);
      const r = parse({ ...without, rid: "not-a-uuid" });
      expect(r.ok).toBe(false);
    }
    // A refusal names the rid when it had a valid one, so the server can answer bad_request to it.
    const r = parse({ ...GOOD.navigate, url: "x".repeat(BROWSER_LIMITS.url + 1) });
    expect(r).toEqual({ ok: false, rid: RID, reason: "url: not a URL" });
  });
  test("refused shapes: not text, too large, not JSON, not an object, an unknown t", () => {
    expect(parseBrowserFrame(new Uint8Array([1, 2]))).toEqual({ ok: false, rid: null, reason: "frame: not text" });
    expect(parseBrowserFrame({ t: "ping", n: 1 })).toEqual({ ok: false, rid: null, reason: "frame: not text" });
    expect(parseBrowserFrame(JSON.stringify({ t: "text", tab: TAB, n: 1, text: "a" }).padEnd(BROWSER_LIMITS.frameChars + 1, " ")).ok).toBe(false);
    expect(parseBrowserFrame("{").ok).toBe(false);
    for (const raw of ["[]", "null", "1", '"x"']) expect(parseBrowserFrame(raw).ok).toBe(false);
    for (const t of ["hello", "attach", "evaluate", "Runtime.evaluate", "cdp", "send", "screenshot", "cookies", "", 1, null]) expect(refused({ t })).toBe(true);
  });
  test("tab ids, rids, counts", () => {
    for (const tab of ["t_1", "Q2X4ABK3M7", "q2x4abk3m", "../etc", "", 1, null]) expect(refused({ ...GOOD.unview, tab })).toBe(true);
    for (const n of [-1, 1.5, 2 ** 31, "1", null, Number.NaN]) expect(refused({ ...GOOD.drawn, n })).toBe(true);
    expect(ok({ ...GOOD.drawn, n: 2 ** 31 - 1 })).toEqual({ ...GOOD.drawn, n: 2 ** 31 - 1 });
    for (const v of [-1, 1.5, "5", null]) expect(refused({ t: "open", v })).toBe(true);
  });
  test("view: the box, the ratio, the quality, the credit and the rate", () => {
    const good = GOOD.view!;
    for (const [k, bad] of [["w", 0], ["w", 4097], ["h", 0.5], ["h", 5000], ["dpr", 0.5], ["dpr", 3.5], ["q", 29], ["q", 86], ["q", 50.5], ["credit", 0], ["credit", 4], ["credit", 1.5], ["w", "1"], ["dpr", Infinity]] as const) {
      expect([k, bad, refused({ ...good, [k]: bad })]).toEqual([k, bad, true]);
    }
    expect(ok({ ...good, fps: 30 })).toEqual({ ...good, fps: 30 });
    for (const fps of [0, 61, 1.5, "30"]) expect(refused({ ...good, fps })).toBe(true);
    for (const k of ["tab", "w", "h", "dpr", "q", "credit"]) {
      const { [k]: _, ...without } = good;
      expect([k, refused(without)]).toEqual([k, true]);
    }
  });
  test("tab_new: a URL of the rule's cap and no control character, and the Phone size", () => {
    expect(ok({ ...GOOD.tab_new, url: "https://example.com/a?b=c" })).toEqual({ ...GOOD.tab_new, url: "https://example.com/a?b=c" });
    expect(ok({ ...GOOD.tab_new, size: { kind: "phone", w: 390, h: 844, extra: 1 } })).toEqual({ ...GOOD.tab_new, size: { kind: "phone", w: 390, h: 844 } });
    for (const url of ["", "x".repeat(8193), "https://a/\u0000", "https://a/\u202e", "https://a/\n", 5, null]) expect(refused({ ...GOOD.tab_new, url })).toBe(true);
    for (const size of [{ kind: "desktop", w: 1280, h: 800 }, { kind: "phone", w: 319, h: 844 }, { kind: "phone", w: 481, h: 844 }, { kind: "phone", w: 390, h: 479 }, { kind: "phone", w: 390, h: 1001 }, { kind: "phone" }, "phone", null]) {
      expect(refused({ ...GOOD.tab_new, size })).toBe(true);
    }
  });
  test("tab_close and tab_size: force is a boolean; Desktop takes no size, Phone takes one in range", () => {
    expect(ok({ ...GOOD.tab_close, force: true })).toEqual({ ...GOOD.tab_close, force: true });
    for (const force of [1, "true", null]) expect(refused({ ...GOOD.tab_close, force })).toBe(true);
    expect(ok({ ...GOOD.tab_size, kind: "phone" })).toEqual({ ...GOOD.tab_size, kind: "phone" });
    expect(ok({ ...GOOD.tab_size, kind: "phone", w: 480, h: 1000, force: false })).toEqual({ ...GOOD.tab_size, kind: "phone", w: 480, h: 1000, force: false });
    for (const f of [{ kind: "desktop", w: 1280, h: 800 }, { kind: "other" }, { kind: "phone", w: 300, h: 800 }, { kind: "phone", w: 390, h: 1200 }, { kind: "phone", w: 390 }]) {
      expect(refused({ ...GOOD.tab_size, ...f })).toBe(true);
    }
  });
  test("reload: nocache is a boolean, and nothing else rides along (no script on load)", () => {
    expect(ok({ ...GOOD.reload, nocache: true, scriptToEvaluateOnLoad: "alert(1)" })).toEqual({ ...GOOD.reload, nocache: true });
    expect(refused({ ...GOOD.reload, nocache: "yes" })).toBe(true);
  });
  test("mouse: types, buttons, clicks, modifiers, coordinates and deltas", () => {
    const good = GOOD.mouse!;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]) expect(ok({ ...good, type }).t).toBe("mouse");
    for (const [k, bad] of [["type", "mouseDragged"], ["type", "dragEnter"], ["button", "back"], ["button", "forward"], ["clicks", 4], ["clicks", -1], ["mods", 16], ["mods", 1.5], ["x", -2], ["x", 10001], ["y", Number.MAX_VALUE], ["dx", 10001], ["dy", -10001], ["sq", -1], ["x", "1"]] as const) {
      expect([k, bad, refused({ ...good, [k]: bad })]).toEqual([k, bad, true]);
    }
    expect(ok({ ...good, type: "mouseWheel", dx: -10000, dy: 10000, mods: 15, sq: 4 })).toEqual({ ...good, type: "mouseWheel", dx: -10000, dy: 10000, mods: 15, sq: 4 });
  });
  test("touch: at most two points, unique ids 0 to 9; touchStart and touchMove need one", () => {
    const good = GOOD.touch!;
    const p = (id: number, x = 1, y = 1) => ({ x, y, id });
    expect(ok({ ...good, points: [p(0), p(9)] })).toEqual({ ...good, points: [p(0), p(9)] });
    expect(ok({ ...good, type: "touchEnd", points: [] })).toEqual({ ...good, type: "touchEnd", points: [] });
    expect(ok({ ...good, type: "touchCancel", points: [] }).t).toBe("touch");
    for (const points of [[], [p(0), p(1), p(2)], [p(0), p(0)], [p(10)], [{ x: 1, y: 1 }], [p(0, -2)], [p(0, 1, 10001)], "x", null]) {
      expect(refused({ ...good, points })).toBe(true);
    }
    expect(ok({ ...good, points: [{ ...p(1), force: 1, radiusX: 3 }] })).toEqual({ ...good, points: [p(1)] });
    expect(refused({ ...good, type: "touchForce" })).toBe(true);
  });
  test("key: printable ASCII names, a virtual key code, a short text, never the commands field", () => {
    const good = GOOD.key!;
    expect(ok({ ...good, commands: ["selectAll", "deleteBackward"] })).toEqual(good);
    expect(ok({ ...good, key: "Enter", code: "Enter", vk: 13, text: "\r" })).toEqual({ ...good, key: "Enter", code: "Enter", vk: 13, text: "\r" });
    expect(ok({ ...good, type: "rawKeyDown", key: "Process", code: "", vk: 229 }).t).toBe("key");
    for (const [k, bad] of [["type", "char"], ["key", ""], ["key", "x".repeat(33)], ["key", "é"], ["code", "Key\u0000"], ["vk", 256], ["vk", -1], ["text", ""], ["text", "abcde"], ["text", "\u0000"], ["text", "\u001b"], ["mods", 16]] as const) {
      expect([k, bad, refused({ ...good, [k]: bad })]).toEqual([k, bad, true]);
    }
  });
  test("text: up to 65,536 units, tab and line feed only among the controls", () => {
    expect(ok({ ...GOOD.text, text: "a\tb\nc" })).toEqual({ ...GOOD.text, text: "a\tb\nc" });
    expect(ok({ ...GOOD.text, text: "x".repeat(BROWSER_LIMITS.text) }).t).toBe("text");
    for (const text of ["", "x".repeat(BROWSER_LIMITS.text + 1), "a\u0000", "a\u001b[2J", "a\r", "a\u007f", 1]) expect(refused({ ...GOOD.text, text })).toBe(true);
  });
  test("text: its sq, as a key's (typed text can replace the selection, D-15)", () => {
    expect(ok({ ...GOOD.text, sq: 7 })).toEqual({ ...GOOD.text, sq: 7 });
    for (const sq of [-1, 1.5, "7", 2 ** 31]) expect([sq, refused({ ...GOOD.text, sq })]).toEqual([sq, true]);
  });
  test("pick: an index or a value of one of the kinds' forms, never both and never neither", () => {
    expect(ok(GOOD.pick)).toEqual(GOOD.pick!);
    const { index: _, ...base } = GOOD.pick!;
    for (const value of ["2026-11-09", "13:45", "13:45:10.250", "2026-11-09T13:45", "2026-11", "2026-W45", "#00ff7f", ""]) expect(ok({ ...base, value })).toEqual({ ...base, value });
    for (const value of ["#00FF7F", "#0f0", "red", "2026-11-09 13:45", "tomorrow", "x".repeat(65), "javascript:alert(1)", 5]) expect([value, refused({ ...base, value })]).toEqual([value, true]);
    expect(refused({ ...base, index: 1, value: "2026-11-09" })).toBe(true);
    expect(refused(base)).toBe(true);
    for (const index of [-1, 500, 1.5, "1"]) expect(refused({ ...base, index })).toBe(true);
  });
  test("pickValueOk checks one kind's form", () => {
    expect(pickValueOk("date", "2026-11-09")).toBe(true);
    expect(pickValueOk("time", "2026-11-09")).toBe(false);
    expect(pickValueOk("color", "")).toBe(false);
    expect(pickValueOk("date", "")).toBe(true);
    expect(pickValueOk("select", "1")).toBe(false);
  });
  test("dialog_answer: accept is a boolean; a prompt's answer is one line of at most 2,000 units", () => {
    expect(ok({ ...GOOD.dialog_answer, text: "my answer\twith a tab" })).toEqual({ ...GOOD.dialog_answer, text: "my answer\twith a tab" });
    expect(ok({ ...GOOD.dialog_answer, text: "" }).t).toBe("dialog_answer");
    for (const [k, bad] of [["accept", 1], ["accept", "true"], ["text", "x".repeat(2001)], ["text", "a\nb"], ["text", "\u0000"], ["id", -1]] as const) {
      expect([k, refused({ ...GOOD.dialog_answer, [k]: bad })]).toEqual([k, true]);
    }
  });
  test("chooser_answer: 1 to 20 upload ids, repeats dropped, never a path", () => {
    expect(ok({ ...GOOD.chooser_answer, uploads: [UP, UP] })).toEqual(GOOD.chooser_answer!);
    const many = Array.from({ length: 21 }, (_, i) => `k3m7q2x4abk3m7${"abcdefghijklmnopqrstuvwxyz234567"[i]}a`);
    expect(ok({ ...GOOD.chooser_answer, uploads: many.slice(0, 20) }).t).toBe("chooser_answer");
    for (const uploads of [[], many, ["/etc/passwd"], ["../x"], [UP.toUpperCase()], "x", null, [{ path: "/etc/passwd" }]]) expect(refused({ ...GOOD.chooser_answer, uploads })).toBe(true);
    expect(ok({ ...GOOD.chooser_answer, files: ["/etc/passwd"], backendNodeId: 3 })).toEqual(GOOD.chooser_answer!);
  });
  test("download_cancel names a download id, never Chrome's guid", () => {
    for (const id of ["0f0e2c8c-1f4a-4c41-a3c6-6b2c1a7f0d12", "abc", DL.toUpperCase(), 5]) expect(refused({ ...GOOD.download_cancel, id })).toBe(true);
  });
});

describe("the URL rule (browserUrlProblem)", () => {
  const R = { origins: ["http://127.0.0.1:7945", "http://localhost:7945", "http://[::1]:7945", "https://box.example.net"], loopbackPorts: [7945, 9345] };
  test("http, https with a host, and exactly about:blank pass", () => {
    for (const u of ["https://example.com/", "http://example.com:8080/a?b=c#d", "https://user:pw@example.com/", "http://127.0.0.1:3000/", "http://localhost:5173/", "about:blank", "https://xn--bcher-kva.example/"]) {
      expect([u, browserUrlProblem(u, R)]).toEqual([u, null]);
    }
  });
  test("every other scheme is refused", () => {
    for (const u of ["file:///etc/passwd", "data:text/html,<script>1</script>", "javascript:alert(1)", "blob:https://a/1", "filesystem:https://a/x", "view-source:https://a/", "chrome://settings/passwords", "chrome-untrusted://x", "chrome-extension://abc/x", "devtools://devtools/x", "intent://x", "ftp://a/", "ws://a/", "about:config", "about:blank#x", "about:srcdoc"]) {
      expect([u, browserUrlProblem(u, R)]).toEqual([u, "scheme"]);
    }
  });
  test("kitespan's own origins, in every spelling, and the debugging port on every loopback name", () => {
    for (const u of ["http://127.0.0.1:7945/", "http://127.0.0.1:7945/c/x", "http://LOCALHOST:7945/", "http://u@127.0.0.1:7945/", "http://[::1]:7945/", "https://box.example.net/", "https://BOX.example.net:443/c", "https://u:p@box.example.net/"]) {
      expect([u, browserUrlProblem(u, R)]).toEqual([u, "own"]);
    }
    for (const u of ["http://127.0.0.2:7945/", "http://0.0.0.0:7945/", "http://localhost.:7945/", "http://app.localhost:7945/", "http://2130706433:7945/", "http://127.1:7945/", "http://[::ffff:127.0.0.1]:7945/"]) {
      expect([u, browserUrlProblem(u, R)]).toEqual([u, "own"]);
    }
    for (const u of ["http://127.0.0.1:9345/json/list", "http://localhost:9345/json/version", "http://[::1]:9345/", "https://127.0.0.1:9345/", "http://0.0.0.0:9345/"]) {
      expect([u, browserUrlProblem(u, R)]).toEqual([u, "browser_port"]);
    }
    // The ports on another name are another host's.
    expect(browserUrlProblem("http://example.com:9345/", R)).toBeNull();
    expect(browserUrlProblem("http://box.example.net:7945/", R)).toBeNull();
  });
  test("caps, controls, and what does not parse", () => {
    expect(browserUrlProblem(`https://a/${"x".repeat(8192)}`, R)).toBe("too_long");
    for (const u of ["https://a/\u0000", "https://a/\u001f", "https://a/\u202e", "https://a/\u2028"]) expect(browserUrlProblem(u, R)).toBe("control");
    for (const u of ["example.com", "https://", "http://[::1", "", "//example.com/"]) expect([u, browserUrlProblem(u, R)]).toEqual([u, "unparsable"]);
  });
  test("normalBrowserUrl gives the parser's own spelling", () => {
    expect(normalBrowserUrl("HTTPS://Example.COM")).toBe("https://example.com/");
    expect(normalBrowserUrl("about:blank")).toBe("about:blank");
  });
  test("isLoopbackHost", () => {
    for (const h of ["localhost", "LOCALHOST", "localhost.", "a.localhost", "127.0.0.1", "127.255.0.9", "0.0.0.0", "[::1]", "[::]", "[::ffff:7f00:1]", "[::ffff:0:0]"]) expect([h, isLoopbackHost(h)]).toEqual([h, true]);
    for (const h of ["example.com", "localhost.example.com", "128.0.0.1", "10.0.0.1", "[::2]", "[::ffff:a00:1]", "localhostx"]) expect([h, isLoopbackHost(h)]).toEqual([h, false]);
  });
});

describe("the Fetch block's test (isOwnBrowserUrl, DESIGN-B1 2.16 point 22)", () => {
  const R = { origins: ["http://127.0.0.1:7945", "http://localhost:7945", "http://[::1]:7945", "https://kite.test:7949"], loopbackPorts: [7945, 9345] };
  test("a user part, upper case and a default port all name kitespan's origin", () => {
    for (const u of ["http://127.0.0.1:7945/", "http://u@127.0.0.1:7945/app", "http://u:p@LOCALHOST:7945/c", "https://KITE.test:7949/", "https://u@kite.test:7949/app", "http://127.0.0.2:7945/", "http://localhost.:7945/", "http://127.0.0.1:9345/json"]) {
      expect([u, isOwnBrowserUrl(u, R)]).toEqual([u, true]);
    }
  });
  test("another port, another scheme or another host is not", () => {
    for (const u of ["https://kite.test:7948/", "http://kite.test:7949/", "https://evil.kite.test:7949/", "https://kite.test.evil:7949/", "http://127.0.0.1:7944/", "https://example.com/", "about:blank", "data:text/html,x", "not a url"]) {
      expect([u, isOwnBrowserUrl(u, R)]).toEqual([u, false]);
    }
  });
});

describe("the binary frame (DESIGN-B1 3.5)", () => {
  const header: CastHeader = { tab: TAB, n: 7, w: 780, h: 488, dw: 1280, dh: 800, psf: 1, top: 0, sx: 0, sy: 120.5, nav: 2 };
  test("kind 1, the header's length big-endian, the JSON header, then the JPEG", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const bytes = encodeCastFrame(header, jpeg);
    expect(bytes[0]).toBe(1);
    const len = new DataView(bytes.buffer).getUint32(1, false);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(5, 5 + len)))).toEqual(header);
    const back = decodeCastFrame(bytes)!;
    expect(back.header).toEqual(header);
    expect([...back.jpeg]).toEqual([...jpeg]);
  });
  test("anything else decodes to null", () => {
    const good = encodeCastFrame(header, new Uint8Array([1]));
    const other = good.slice();
    other[0] = 2;
    expect(decodeCastFrame(other)).toBeNull();
    expect(decodeCastFrame(new Uint8Array([1, 0, 0, 0]))).toBeNull();
    expect(decodeCastFrame(good.subarray(0, 10))).toBeNull();
    expect(decodeCastFrame(encodeCastFrame({ ...header, tab: "bad" }, new Uint8Array([1])))).toBeNull();
    expect(decodeCastFrame(encodeCastFrame({ ...header, n: Number.NaN }, new Uint8Array([1])))).toBeNull();
  });
});

describe("the route table's browser views (DESIGN-B1 4.1)", () => {
  test("the chat's Browser is the side panel's seventh kind, with a url pre-fill and a tab", () => {
    const a = parsePath(`/c/${C}/browser?url=${encodeURIComponent("https://example.com/")}&below=shell`);
    expect([a.name, a.query, a.dropped]).toEqual(["chatBrowser", { url: "https://example.com/", below: "shell" }, undefined]);
    const b = parsePath(`/c/${C}/browser/${TAB}?above=details`);
    expect([b.name, b.params.tab, b.query]).toEqual(["chatBrowserTab", TAB, { above: "details" }]);
    expect(PANEL_ROUTES.has("chatBrowser") && PANEL_ROUTES.has("chatBrowserTab")).toBe(true);
    expect([paneKindOf("chatBrowser"), paneKindOf("chatBrowserTab"), paneKindOf("browser"), paneKindOf("browserTab")]).toEqual(["browser", "browser", null, null]);
    expect(paneRouteOf(C, `browser/${TAB}`)?.name).toBe("chatBrowserTab");
    expect(pairAllowed("chatBrowser", "below", "shell")).toBe(true);
    expect(pairAllowed("chatBrowser", "above", `browser/${TAB}`)).toBe(false);
    expect(pairAllowed("details", "above", "browser")).toBe(true);
    expect(href("chatBrowserTab", { chat: C, tab: TAB }, { below: "shell" })).toBe(`/c/${C}/browser/${TAB}?below=shell`);
  });
  test("a tab id that is not the browser's falls back to the pane; the url key holds at most 5,000 characters", () => {
    const r = parsePath(`/browser/t_1`);
    expect([r.name, r.fallbackFrom]).toEqual(["browser", "/browser/t_1"]);
    const c = parsePath(`/c/${C}/browser/T_1`);
    expect([c.name, c.fallbackFrom]).toEqual(["chatBrowser", `/c/${C}/browser/T_1`]);
    expect(parsePath(`/browser/${TAB}`).name).toBe("browserTab");
    const long = parsePath(`/browser?url=${"x".repeat(5001)}`);
    expect([long.name, long.query, long.dropped]).toEqual(["browser", {}, true]);
    expect(isAppPath(`/c/${C}/browser`)).toBe(true);
  });
  test("Settings > Browser comes after Notifications", () => {
    expect(SETTINGS_SECTIONS.indexOf("browser")).toBe(SETTINGS_SECTIONS.indexOf("notifications") + 1);
    expect(parsePath("/settings/browser").name).toBe("settingsSection");
    expect(ROUTE_BY_NAME.chatBrowser!.kind).toBe("view");
  });
});

describe("the owner's command (DESIGN-B1 5)", () => {
  test("pinned, user scope, named playwright, the port in it", () => {
    expect(browserMcpCommand(9340)).toBe("claude mcp add -s user playwright -- npx @playwright/mcp@0.0.84 --cdp-endpoint http://127.0.0.1:9340 --no-webmcp --output-dir ~/.cache/playwright-mcp-output");
  });
});
