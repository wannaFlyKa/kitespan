// The browser pane's state on the page (web/browser/store.ts) over a fake /ws/browser: the frames folded into one
// state, the chip's 1.5 s hold, the lines at the stage's foot (a dialog or a chooser answered elsewhere: DESIGN-B1 4.6
// and 4.7, F15, F19; a stale press; a field that is gone), this page's own answers with no line, the selection that Copy
// writes, a follow, and a cast frame with no stage acked at once so the cast never stalls.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodeCastFrame, type BrowserServerFrame, type BrowserTabView } from "../../shared/browser";
import type { BrowserLinkDeps, BrowserSocketLike } from "../../web/net/browserSocket";
import { addNote, answerDialog, answeredLine, configureBrowser, copyHold, getBrowser, holdLink, onCast, receive, resetBrowser, setTouchWords, STALE_LINES, viewTab, whenOpened } from "../../web/browser/store";

const TAB = "q2x4abk3m7";
const CHAT = "k3m7q2x4abk3m7q2x4ab";

class FakeSocket implements BrowserSocketLike {
  readyState = 0;
  binaryType = "blob";
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string | ArrayBufferView) {
    this.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  frame(f: BrowserServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

let socket: FakeSocket;
let now = 0;
const deps = (): BrowserLinkDeps => ({
  url: "ws://x/ws/browser",
  open: () => (socket = new FakeSocket()),
  setTimer: () => 0,
  clearTimer: () => {},
  random: () => 0.5,
  now: () => now,
  uuid: () => "00000000-0000-4000-8000-000000000001",
});
const tab = (id: string): BrowserTabView => ({ id, url: "http://localhost:3000/book", title: "Book", loading: false, canBack: false, canForward: false, by: "user", opener: null, crashed: false, hidden: false, dialog: null, chooser: null, size: { kind: "desktop", w: 1280, h: 800, by: "user" }, claudeLast: null });

let release: () => void;
beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {} };
  configureBrowser(deps, () => now);
  release = holdLink();
  socket.readyState = 1;
  socket.onopen?.({});
  socket.frame({ t: "opened", host: { state: "running", port: 9340 }, tabs: [tab(TAB)], acting: [], downloads: [] });
});
afterEach(() => {
  release();
  resetBrowser();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the frames", () => {
  test("opened: the host and the tabs; a tabs frame drops the closed tabs' dialogs and pickers", () => {
    expect(getBrowser().opened).toBe(true);
    expect(getBrowser().tabs.map((t) => t.id)).toEqual([TAB]);
    receive({ t: "dialog", tab: TAB, id: 1, type: "confirm", message: "Book?", defaultPrompt: "", host: "localhost:3000", embedded: false });
    expect(getBrowser().dialogs[TAB]?.id).toBe(1);
    receive({ t: "tabs", list: [] });
    expect(getBrowser().dialogs).toEqual({});
  });
  test("acting: the chip holds 1.5 s after the last call ends", async () => {
    const call = { chat: CHAT, tool: "browser_click", tab: TAB, since: "2026-11-09T10:00:00.000Z" };
    receive({ t: "acting", list: [call] });
    expect(getBrowser().held).toEqual([call]);
    receive({ t: "acting", list: [] });
    expect(getBrowser().acting).toEqual([]);
    expect(getBrowser().held).toEqual([call]);
    await Bun.sleep(1600);
    expect(getBrowser().held).toEqual([]);
  });
  test("follow: this page's tap opened a tab", () => {
    receive({ t: "follow", tab: "m7q2x4abk3", from: TAB });
    expect(getBrowser().follow).toMatchObject({ tab: "m7q2x4abk3", from: TAB });
  });
  test("selection: Copy writes the newest answer", () => {
    const sq = copyHold(TAB).next();
    receive({ t: "selection", tab: TAB, sq, text: "Ridge Loop", cut: false });
    expect(copyHold(TAB).copy()).toEqual({ text: "Ridge Loop", pending: false });
  });
  test("a frame of the tab's next document (its nav went up) leaves nothing to copy; a frame of the same one keeps it", () => {
    const h = { tab: TAB, n: 1, w: 10, h: 10, dw: 1280, dh: 800, psf: 1, top: 0, sx: 0, sy: 0, nav: 4 };
    socket.onmessage?.({ data: encodeCastFrame(h, new Uint8Array([1])).buffer });
    receive({ t: "selection", tab: TAB, sq: copyHold(TAB).next(), text: "Ridge Loop", cut: false });
    socket.onmessage?.({ data: encodeCastFrame({ ...h, n: 2, sy: 300 }, new Uint8Array([1])).buffer });
    expect(copyHold(TAB).copy().text).toBe("Ridge Loop");
    socket.onmessage?.({ data: encodeCastFrame({ ...h, n: 3, nav: 5 }, new Uint8Array([1])).buffer });
    expect(copyHold(TAB).copy()).toEqual({ text: "", pending: false });
  });
  test("whenOpened: at once once the socket's opened came; else when it comes, or null after the wait", async () => {
    expect((await whenOpened(10))?.opened).toBe(true);
    configureBrowser(deps, () => now);
    const r = holdLink();
    const waits = whenOpened(5_000);
    socket.readyState = 1;
    socket.onopen?.({});
    socket.frame({ t: "opened", host: { state: "running", port: 9340 }, tabs: [tab(TAB)], acting: [], downloads: [] });
    expect((await waits)?.host?.state).toBe("running");
    r();
    configureBrowser(deps, () => now);
    const r2 = holdLink();
    expect(await whenOpened(20)).toBeNull();
    r2();
  });
  test("a cast frame with no stage is acked at once; with one, the stage gets it", () => {
    const h = { tab: TAB, n: 3, w: 10, h: 10, dw: 1280, dh: 800, psf: 1, top: 0, sx: 0, sy: 0, nav: 1 };
    socket.onmessage?.({ data: encodeCastFrame(h, new Uint8Array([1])).buffer });
    expect(socket.sent.at(-1)).toEqual({ t: "drawn", tab: TAB, n: 3 });
    const got: number[] = [];
    const off = onCast(TAB, (x) => got.push(x.n));
    socket.onmessage?.({ data: encodeCastFrame({ ...h, n: 4 }, new Uint8Array([1])).buffer });
    expect(got).toEqual([4]);
    expect(socket.sent.at(-1)).toEqual({ t: "drawn", tab: TAB, n: 3 });
    off();
  });
});

describe("the lines (F19, F15)", () => {
  const dialog = (type: "alert" | "confirm" | "prompt" | "beforeunload", id = 2): BrowserServerFrame => ({ t: "dialog", tab: TAB, id, type, message: "m", defaultPrompt: "", host: "localhost:3000", embedded: false });
  test("answered by Claude, by another kitespan window, elsewhere", () => {
    expect(answeredLine("claude", "confirm", true)).toBe("Claude answered: OK.");
    expect(answeredLine("pane", "confirm", false)).toBe("Answered in another kitespan window: Cancel.");
    expect(answeredLine("elsewhere", "beforeunload", true)).toBe("Answered elsewhere: Leave.");
    expect(answeredLine("elsewhere", "alert", false)).toBe("Answered elsewhere: OK.");
  });
  test("a dialog closed by another: its line shows; this page's own answer shows none", async () => {
    receive(dialog("confirm"));
    receive({ t: "dialog_closed", tab: TAB, id: 2, result: true, by: "claude" });
    expect(getBrowser().notes.map((n) => n.text)).toEqual(["Claude answered: OK."]);
    receive(dialog("confirm", 3));
    const answer = answerDialog(getBrowser().dialogs[TAB]!, false);
    const sent = socket.sent.at(-1)!;
    expect(sent).toMatchObject({ t: "dialog_answer", tab: TAB, id: 3, accept: false });
    expect("text" in sent).toBe(false);
    socket.frame({ t: "ack", rid: sent.rid as string, ok: true });
    await answer;
    receive({ t: "dialog_closed", tab: TAB, id: 3, result: false, by: "pane" });
    expect(getBrowser().notes.map((n) => n.text)).toEqual(["Claude answered: OK."]);
  });
  test("a chooser that Claude answered: Claude chose the file; replaced: Claude replaced the file", () => {
    receive({ t: "chooser", tab: TAB, id: 5, mode: "selectSingle", accept: [], multiple: false, label: "Signed waiver", host: "localhost:3000", by: "other" });
    receive({ t: "chooser_closed", tab: TAB, id: 5, by: "claude" });
    expect(getBrowser().notes.at(-1)?.text).toBe("Claude chose the file.");
    receive({ t: "chooser_closed", tab: TAB, id: 6, by: "claude", replaced: true });
    expect(getBrowser().notes.at(-1)?.text).toBe("Claude replaced the file.");
  });
  test("a stale press: the line in the words of the pointer", () => {
    setTouchWords(true);
    viewTab(TAB, { w: 504, h: 315, dpr: 1, q: 70, credit: 3 });
    receive({ t: "error", code: "stale_frame", message: "The page changed. Tap again." });
    expect(getBrowser().notes.at(-1)).toMatchObject({ tab: TAB, text: STALE_LINES.touch, kind: "stale" });
    setTouchWords(false);
    receive({ t: "error", code: "stale_frame", message: "The page changed. Tap again." });
    expect(getBrowser().notes.filter((n) => n.kind === "stale").map((n) => n.text)).toEqual([STALE_LINES.mouse]);
    expect(STALE_LINES.mouse).toBe("The page changed. Click again.");
  });
  test("too many viewers marks the viewed tab", () => {
    viewTab(TAB, { w: 504, h: 315, dpr: 1, q: 70, credit: 3 });
    receive({ t: "error", code: "viewers_full", message: "" });
    expect(getBrowser().full).toBe(TAB);
  });
  test("a picker whose control is gone: That field is gone.", () => {
    receive({ t: "picker", tab: TAB, id: 1, kind: "select", open: true, box: { x: 0, y: 0, w: 10, h: 10 }, label: "Walk", selected: 0, items: [] });
    receive({ t: "picker_closed", tab: TAB, id: 1, why: "gone" });
    expect(getBrowser().pickers).toEqual({});
    expect(getBrowser().notes.at(-1)?.text).toBe("That field is gone.");
  });
  test("at most four lines, the newest kept", () => {
    for (let i = 0; i < 6; i++) addNote(TAB, `line ${i}`, null);
    expect(getBrowser().notes.map((n) => n.text)).toEqual(["line 2", "line 3", "line 4", "line 5"]);
  });
});
