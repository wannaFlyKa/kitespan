// The restart on the page (DESIGN.md 4.10, 6.8, D51; build checklist S3, S4, S14, L14, L15, L17, L18): About's
// rows (Update available with Update, row 108; the diverged line; Restart to apply; the update that did not finish;
// Restart), the restart dialog's lists and its one clause, its two buttons or its one, Cancel restart while it waits
// and the result; and the store's side: the Restarting line between `bye` and the new `welcome`, origin's line from
// `welcome`, the drain notice that offers Cancel restart until it goes, and the restart asked from this page through
// to its end (react-dom/server, a fake socket, a fake fetch).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import type { RestartReply, UpdateReply } from "../../server/http/api-types";
import { Connection, type SocketLike } from "../../web/net/socket";
import { resetUpdateState, setUpdateState } from "../../web/update/state";
import { act, connectWith, getState, listNotice, resetState, restartingNow, type RestartAsk } from "../../web/state/store";
import type { Chat } from "../../web/state/types";
import { SectionBody } from "../../web/screens/Settings";
import { useConnection } from "../../web/screens/common";
import { ABOUT_WORDS } from "../../web/settings/about";
import { setRestartFacts } from "../../web/settings/facts";
import { RestartBody, restartPhase } from "../../web/settings/RestartDialog";
import { acted, doublePress, handlerOf, inRender } from "./presses";
import { DrainLine } from "../../web/settings/DrainLine";
import { restartClause, restartLists, RESTART_WORDS } from "../../web/settings/restart";
import { scripted } from "./fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);

let n = 0;
function chat(p: Partial<Chat> = {}): Chat {
  const id = `k3m7q2x4abk3m7q2x4${String(++n).padStart(2, "a").slice(-2).replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)}`;
  return {
    ...scripted({
      id,
      projectId: "k3m7q2x4ab",
      title: `Chat ${n}`,
      titleSource: "first-prompt",
      state: "idle",
      updatedAt: "2026-11-02T08:00:00.000Z",
      sessionId: "",
      model: "default",
      effort: "default",
      mode: "default",
      items: [],
      pending: [],
      context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] },
      connectors: [],
      outputs: [],
    }),
    ...p,
  };
}

const LAPTOP = { touch: false, laptop: true, phone: false, narrow: false };
const about = () => renderToStaticMarkup(createElement(SectionBody, { id: "about", ctx: LAPTOP }));

const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown; fetch: typeof fetch };
const own = { mm: !gm.matchMedia, win: !gm.window, fetch: gm.fetch };
beforeAll(() => {
  gm.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  gm.window ??= { innerWidth: 1100, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  gm.fetch = own.fetch;
  connectWith(null);
  setRestartFacts(null);
  resetUpdateState();
  resetState();
});
beforeEach(() => {
  resetState({ ready: true });
  setRestartFacts(null);
  resetUpdateState();
});

describe("About's rows (S3, S4, S14, L17, L18; row 108)", () => {
  const facts = (p: Partial<UpdateReply>): UpdateReply => ({ update: "none", build: "none", check: { at: null, ok: true, why: null, running: false }, job: { state: "idle" }, can: true, kind: "checkout", latest: null, next: null, ...p });
  const setFacts = (p: Partial<UpdateReply>) => setUpdateState({ facts: facts(p) });

  test("with nothing new: Version, Licence and Restart, a row that opens the dialog; no Update", () => {
    const html = about();
    expect(ids(html)).toContain("setting-restart");
    expect(html).toContain('href="/settings/about/restart"');
    expect(ids(html)).not.toContain("setting-update");
    expect(ids(html)).not.toContain("setting-restart-to-apply");
    expect(ids(html)).not.toContain("update-open");
  });

  test("Update available with Update, which opens /settings/about/update (the confirm acts, not the row); from welcome until About's own read", () => {
    resetState({ ready: true, update: "available" });
    const html = about();
    expect(text(html)).toContain(`${ABOUT_WORDS.available} ${ABOUT_WORDS.update}`);
    expect(html).toMatch(/<a href="\/settings\/about\/update" class="btn" data-testid="update-open">Update<\/a>/);
    expect(text(html)).not.toContain("bin/update.sh");
    setFacts({ update: "none" });
    expect(ids(about())).not.toContain("setting-update");
    setFacts({ update: "available" });
    expect(ids(about())).toContain("update-open");
    // Dev mode serves web/ itself: no Update.
    setFacts({ update: "available", can: false });
    expect(ids(about())).toContain("setting-update");
    expect(ids(about())).not.toContain("update-open");
  });

  test("diverged: one line, no Update; Restart to apply; and the update that did not finish, with Update again", () => {
    setFacts({ update: "diverged", build: "apply" });
    let t = text(about());
    expect(t).toContain("This checkout and origin have diverged; kitespan cannot fast-forward it.");
    expect(t).toContain("Restart to apply");
    expect(ids(about())).not.toContain("update-open");
    setFacts({ build: "unfinished" });
    t = text(about());
    expect(t).toContain("Restart to apply The update did not finish. Update");
    expect(ids(about())).toContain("update-open");
  });

  test("while an update runs: its step line alone, no Update and no build line; one that did not finish: its line with Update again", () => {
    setFacts({ update: "available", build: "unfinished", job: { state: "running", step: "install" } });
    let html = about();
    expect(text(html)).toContain("Updating kitespan: step 2 of 3, install.");
    expect(ids(html)).toContain("setting-update-step");
    expect(ids(html)).not.toContain("update-open");
    expect(ids(html)).not.toContain("setting-restart-to-apply");
    setFacts({ build: "unfinished", job: { state: "failed", step: "build", line: "The update did not finish at step 3 of 3, build." } });
    html = about();
    expect(text(html)).toContain("The update did not finish at step 3 of 3, build. Update");
    expect(ids(html).filter((x) => x === "update-open")).toHaveLength(1);
    expect(ids(html)).not.toContain("setting-restart-to-apply");
    setFacts({ build: "apply", job: { state: "done" } });
    html = about();
    expect(text(html)).toContain("Restart to apply");
    expect(ids(html)).not.toContain("update-open");
  });

  test("on touch, the Restart row starts where the group's other rows do (.touch .set-row's inset)", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "panels.css"), "utf8");
    expect(css).toMatch(/\.touch \.set-row \{\s*padding: var\(--s3\) var\(--s4\);/);
    expect(css).toMatch(/\.touch \.group-row\.set-link-row \{\s*padding-left: var\(--s4\);/);
  });

  test("the rows' labels are DESIGN 6.8's: Update available (the diverged line is its line) and Restart to apply (the unfinished line is its line); never two rows named Update", () => {
    setFacts({ update: "diverged", build: "unfinished" });
    const html = about();
    const label = (id: string) => text(html.slice(html.indexOf(`data-testid="${id}"`), html.indexOf("</li>", html.indexOf(`data-testid="${id}"`))));
    expect(label("setting-update")).toContain(`${ABOUT_WORDS.available} This checkout and origin have diverged`);
    expect(label("setting-restart-to-apply")).toContain(`${ABOUT_WORDS.apply} The update did not finish.`);
    expect(text(html)).not.toMatch(/\bUpdate This checkout|\bUpdate The update/);
  });
});

describe("the restart dialog (S14, S15, L15, D51)", () => {
  const ask = (p: Partial<RestartAsk>): RestartAsk => ({ when: "finish", epoch: "e1", state: "accepted", line: null, ...p });
  const body = (lists: ReturnType<typeof restartLists>, a: RestartAsk | null = null, wait: { text: string } | null = null, sheet = false) =>
    renderToStaticMarkup(createElement(RestartBody, { lists, ask: a, wait, sheet, onClose: () => {} }));

  test("each list's title starts at the dialog's edge, as its plain lines do (no group row's inset, also on touch)", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "panels.css"), "utf8");
    expect(css).toMatch(/\.set-restart-list \{[^}]*padding: 0;/);
    expect(css).toMatch(/\.set-restart \.group-title\.set-group-title \{\s*padding: 0;/);
  });

  test("the lists: running turns, open cards, background tasks and panes with a program; archived chats have none", () => {
    const running = chat({ serverState: "running", title: "Runs" });
    const starting = chat({ serverState: "starting", title: "Starts" });
    const card = chat({ serverState: "waiting", needsYou: true, title: "Asks", pending: [{} as never, {} as never] });
    const task = chat({ serverState: "idle", busy: true, title: "Background", tasks: [{ taskId: "t1", description: "watch", ambient: false }] });
    const pane = chat({ title: "Pane" });
    const archived = chat({ serverState: "running", archived: true, title: "Archived" });
    const quiet = chat({ title: "Quiet" });
    const lists = restartLists([running, starting, card, task, pane, archived, quiet], [
      { chat: pane.id, known: true },
      { chat: archived.id, known: false },
    ]);
    expect(lists.running.map((c) => c.title)).toEqual(["Runs", "Starts"]);
    expect(lists.cards.map((c) => c.title)).toEqual(["Asks"]);
    expect(lists.tasks.map((c) => c.title)).toEqual(["Background"]);
    expect(lists.panes.map((c) => c.title)).toEqual(["Pane"]);
    expect(restartClause(lists)).toBe("Stops 2 running turns, drops 2 waiting requests, ends 1 background task and ends the program in 1 Terminal pane.");
    const html = body(lists);
    for (const id of ["restart-running", "restart-cards", "restart-tasks", "restart-panes", "confirm-restart", "confirm-restart-now", "restart-clause"]) expect(ids(html)).toContain(id);
    const t = text(html);
    for (const w of [RESTART_WORDS.running, RESTART_WORDS.cards, RESTART_WORDS.tasks, RESTART_WORDS.panes, RESTART_WORDS.finish, RESTART_WORDS.now, "Runs", "Asks", "Background", "Pane"]) expect(t).toContain(w);
    expect(t).not.toContain("Archived");
    expect(t).not.toContain("Quiet");
    // Restart when they finish is the default: it holds the first focus.
    expect(html).toMatch(/data-testid="confirm-restart"[^>]*data-autofocus/);
  });

  test("a double press is one press: Restart when they finish, Restart now and Cancel restart swallow a second click, a later press acts", () => {
    // The answer changes the buttons under the pointer: while the restart waits, Cancel restart is where Restart when
    // they finish was, and the other way round (ui/secondPress).
    const posts: string[] = [];
    gm.fetch = (async (path: string) => (posts.push(path), new Response(JSON.stringify({ when: "finish", cancelled: true }), { status: 202 }))) as unknown as typeof fetch;
    const lists = restartLists([chat({ serverState: "running" })], []);
    const asks = inRender(() => RestartBody({ lists, ask: null, wait: null, sheet: false, onClose: () => {} }));
    const waits = inRender(() => RestartBody({ lists, ask: null, wait: { text: RESTART_WORDS.waits }, sheet: false, onClose: () => {} }));
    for (const [body, id] of [[asks, "confirm-restart"], [asks, "confirm-restart-now"], [waits, "confirm-cancel-restart"]] as const) {
      const { second, later } = doublePress(handlerOf(body, id));
      expect([id, acted(second), acted(later)]).toEqual([id, false, true]);
    }
    expect(posts).toEqual(["/api/restart", "/api/restart", "/api/restart/cancel"]);
  });

  test("the clause counts in Desktop's plain form (D51's example), and a pane the system says nothing about counts", () => {
    const two = [chat({ serverState: "running" }), chat({ serverState: "running" })];
    const cards = [chat({ serverState: "waiting", needsYou: true, pending: [{}, {}, {}, {}] as never[] })];
    expect(restartClause(restartLists([...two, ...cards], []))).toBe("Stops 2 running turns and drops 4 waiting requests.");
    const p = chat();
    expect(restartClause(restartLists([p], [{ chat: p.id, known: false }]))).toBe("Ends the program in 1 Terminal pane.");
    expect(restartClause(restartLists([chat()], []))).toBeNull();
  });

  test("with nothing to wait for: one button, Restart (a pane's program still gets its clause)", () => {
    const html = body(restartLists([chat()], []));
    expect(ids(html)).toContain("confirm-restart");
    expect(ids(html)).not.toContain("confirm-restart-now");
    expect(text(html)).toContain(RESTART_WORDS.plain);
    expect(text(html)).not.toContain(RESTART_WORDS.finish);
    expect(ids(html)).not.toContain("restart-clause");
    const p = chat();
    const withPane = body(restartLists([p], [{ chat: p.id, known: true }]));
    expect(ids(withPane)).not.toContain("confirm-restart-now");
    expect(text(withPane)).toContain("Ends the program in 1 Terminal pane.");
  });

  test("while it waits: the line, Cancel restart and Restart now; another page's drain shows the same", () => {
    const lists = restartLists([chat({ serverState: "running" })], []);
    for (const html of [body(lists, ask({})), body(lists, null, { text: "kitespan restarts when the running turns end." })]) {
      expect(ids(html)).toContain("confirm-cancel-restart");
      expect(ids(html)).toContain("confirm-restart-now");
      expect(ids(html)).not.toContain("confirm-restart");
      expect(text(html)).toContain(RESTART_WORDS.waits);
      expect(text(html)).toContain("Stops 1 running turn.");
    }
  });

  test("the result: Restarting kitespan..., kitespan restarted., the restart that did not happen, a refusal's line", () => {
    const lists = restartLists([chat()], []);
    expect(text(body(lists, ask({ when: "now" })))).toContain(RESTART_WORDS.restarting);
    expect(text(body(lists, ask({ state: "done" })))).toContain("kitespan restarted.");
    expect(text(body(lists, ask({ state: "not_done" })))).toContain("kitespan did not restart. Its lines are in server-out.log.");
    const refused = body(lists, ask({ state: "refused", line: "The update did not finish. Update again first." }));
    expect(text(refused)).toContain("The update did not finish. Update again first.");
    expect(ids(refused)).toContain("confirm-restart");
    expect(restartPhase(ask({ state: "sending" }), null, lists)).toBe("ask");
    expect(body(lists, ask({ state: "sending" }))).toMatch(/data-testid="confirm-restart"[^>]*disabled/);
  });

  test("Restart now is a ghost danger button (6.13) in both phases, and its clause is right under it; the wait phase's first focus is Cancel restart", () => {
    const lists = restartLists([chat({ serverState: "running" })], []);
    const now = (html: string) => html.slice(html.lastIndexOf("<button", html.indexOf('data-testid="confirm-restart-now"')), html.indexOf(">", html.indexOf('data-testid="confirm-restart-now"')) + 1);
    for (const html of [body(lists), body(lists, ask({})), body(lists, null, { text: RESTART_WORDS.waits }, true)]) {
      expect(now(html)).toContain('class="btn ghost danger"');
      expect(now(html)).not.toContain("primary");
      expect(now(html)).not.toContain("data-autofocus");
      // The clause follows the button in the same block, before any other button.
      const after = html.slice(html.indexOf('data-testid="confirm-restart-now"'));
      expect(after.indexOf('data-testid="restart-clause"')).toBeGreaterThan(0);
      expect(after.slice(0, after.indexOf('data-testid="restart-clause"'))).not.toContain("<button");
    }
    expect(body(lists, ask({}))).toMatch(/data-testid="confirm-cancel-restart"[^>]*data-autofocus/);
    expect(body(lists)).toMatch(/data-testid="confirm-restart"[^>]*data-autofocus/);
  });

  test("the lists use the list's own words (Working, Needs input) and draw the chats as plain lines, not as rows", () => {
    expect(RESTART_WORDS.running).toBe("Working");
    expect(RESTART_WORDS.cards).toBe("Needs input");
    const html = body(restartLists([chat({ serverState: "running", title: "Runs" })], []));
    const list = html.slice(html.indexOf('data-testid="restart-running"'), html.indexOf("</ul>", html.indexOf('data-testid="restart-running"')));
    expect(list).not.toContain("group-row");
    expect(text(list)).toContain("Runs");
  });

  test("the dialog forgets a finished result when it goes (Close, Done, and Back too), so a second try starts at the ask", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "settings", "RestartDialog.tsx"), "utf8");
    expect(src).toContain("useLayoutEffect(() => () => act.forgetRestart(), []);");
    resetState({ ready: true, restart: { when: "finish", epoch: "e1", state: "not_done", line: null } });
    act.forgetRestart();
    expect(getState().restart).toBeNull();
    resetState({ ready: true, restart: { when: "finish", epoch: "e1", state: "accepted", line: null } });
    act.forgetRestart();
    expect(getState().restart?.state).toBe("accepted");
  });

  test("the drain line's Restart now is a ghost danger button too, and the line steps aside once this page pressed Restart now", () => {
    resetState({ ready: true, restartWait: { id: "drain", text: RESTART_WORDS.waits } });
    const html = renderToStaticMarkup(createElement(DrainLine));
    const now = html.slice(html.lastIndexOf("<button", html.indexOf('data-testid="drain-now"')), html.indexOf(">", html.indexOf('data-testid="drain-now"')) + 1);
    expect(now).toContain('class="btn ghost danger"');
    resetState({ ready: true, restartWait: { id: "drain", text: RESTART_WORDS.waits }, restart: { when: "now", epoch: "e1", state: "sending", line: null } });
    expect(renderToStaticMarkup(createElement(DrainLine))).toBe("");
  });

  test("the phone's sheet has no Cancel or Close button of its own (its top-right word closes it)", () => {
    const html = body(restartLists([chat({ serverState: "running" })], []), null, null, true);
    expect(html).not.toMatch(/>Cancel</);
    expect(ids(html)).toContain("confirm-restart");
  });
});

// ---- the store's side, through a fake socket ----

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

let sockets: FakeSocket[] = [];
const sock = () => sockets.at(-1)!;
/** The connection's timers, run by hand: a redial after `bye` is one of them. */
let timers: ((() => void) | null)[] = [];
const welcome = (epoch: string, update: { available: boolean; kind?: "none" | "available" | "diverged" } = { available: false }): ServerFrame => ({
  t: "welcome",
  epoch,
  version: "0.1.0",
  v: PROTOCOL_VERSION,
  claude: { ok: true, version: "2.1.317", drift: null },
  update,
  auth: "none",
});
function boot(epoch = "e1", update?: { available: boolean; kind?: "none" | "available" | "diverged" }) {
  resetState({ ready: true });
  sockets = [];
  timers = [];
  const conn = new Connection({
    url: "ws://127.0.0.1:7944/ws",
    tab: "tab_me",
    open: () => (sockets.push(new FakeSocket()), sock()),
    now: () => 0,
    setTimer: (fn) => timers.push(fn),
    clearTimer: (id) => {
      timers[(id as number) - 1] = null;
    },
    random: () => 0.5,
    reload: () => {},
  });
  connectWith(conn);
  conn.start();
  sock().onopen?.({});
  sock().receive(welcome(epoch, update));
  return conn;
}
/** The old server's bye; the page dials again (its retry timer), and the new socket opens. */
function byeAndRedial() {
  const from = timers.length;
  const old = sock();
  old.receive({ t: "bye", reason: "restart" });
  for (const fn of timers.slice(from)) fn?.();
  expect(sock()).not.toBe(old);
  sock().onopen?.({});
}

function Line() {
  return createElement("span", null, useConnection());
}
const connection = () => renderToStaticMarkup(createElement(Line));

describe("the store's side of a restart (S4, S14)", () => {
  test("welcome carries origin's line; an older welcome with no kind reads as its flag", () => {
    boot("e1", { available: true, kind: "available" });
    expect(getState().update).toBe("available");
    boot("e1", { available: false, kind: "diverged" });
    expect(getState().update).toBe("diverged");
    boot("e1", { available: true });
    expect(getState().update).toBe("available");
    boot("e1");
    expect(getState().update).toBe("none");
  });

  test("Restarting between the bye and the next welcome; then the line goes", () => {
    boot();
    expect(connection()).toContain("connected");
    byeAndRedial();
    expect(getState().restarting).toBe(true);
    expect(connection()).toContain("restarting");
    sock().receive(welcome("e2"));
    expect(getState().restarting).toBe(false);
    // A shutdown's bye is not a restart.
    sock().receive({ t: "bye", reason: "shutdown" });
    expect(getState().restarting).toBe(false);
  });

  test("the drain notice is kept while it waits and offers Cancel restart; `gone` takes it and its line away", () => {
    boot();
    sock().receive({ t: "notice", text: "kitespan restarts when the running turns end.", id: "drain", actions: ["cancel_restart", "restart_now"] });
    expect(getState().restartWait).toEqual({ id: "drain", text: "kitespan restarts when the running turns end." });
    // Principle 0: the drain line shows once, as itself (DrainLine, the dialog), never also as the screen's notice.
    expect(getState().notice).toBeNull();
    expect(listNotice(getState())).toBeNull();
    sock().receive({ t: "notice", text: "", id: "drain", gone: true });
    expect(getState().restartWait).toBeNull();
    expect(listNotice(getState())).toBeNull();
    // A gone notice never takes away another line that came after it.
    sock().receive({ t: "notice", text: "Update available.", id: "update", actions: ["update"] });
    act.setNotice("A line of its own.");
    sock().receive({ t: "notice", text: "", id: "update", gone: true });
    expect(listNotice(getState())).toBe("A line of its own.");
  });

  test("a restart asked here: sending, accepted (202), then done at a welcome of another epoch", async () => {
    boot("e1");
    const sent: { path: string; body: string; headers: Record<string, string> }[] = [];
    gm.fetch = (async (path: string, init: RequestInit) => {
      sent.push({ path, body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ when: "finish" }), { status: 202, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const p = act.restart("finish");
    expect(getState().restart?.state).toBe("sending");
    await p;
    expect(sent.map((s) => [s.path, JSON.parse(s.body), s.headers["x-kitespan"]])).toEqual([["/api/restart", { when: "finish" }, "1"]]);
    expect(getState().restart).toEqual({ when: "finish", epoch: "e1", state: "accepted", line: null });
    byeAndRedial();
    sock().receive(welcome("e2"));
    expect(getState().restart?.state).toBe("done");
    act.forgetRestart();
    expect(getState().restart).toBeNull();
  });

  test("a welcome of the same epoch after the bye: the restart did not happen", async () => {
    boot("e1");
    gm.fetch = (async () => new Response(JSON.stringify({ when: "now" }), { status: 202 })) as unknown as typeof fetch;
    await act.restart("now");
    byeAndRedial();
    sock().receive(welcome("e1"));
    expect(getState().restart?.state).toBe("not_done");
  });

  test("a refusal keeps the server's line; a reconnect with no bye changes nothing", async () => {
    boot("e1");
    const line = "The update did not finish. Update again first.";
    gm.fetch = (async () => new Response(JSON.stringify({ error: { code: "preflight", message: line } }), { status: 409 })) as unknown as typeof fetch;
    await act.restart("finish");
    expect(getState().restart).toEqual({ when: "finish", epoch: "e1", state: "refused", line });
    gm.fetch = (async () => new Response(JSON.stringify({ when: "finish" }), { status: 202 })) as unknown as typeof fetch;
    await act.restart("finish");
    sock().receive(welcome("e1"));
    expect(getState().restart?.state).toBe("accepted");
  });

  test("an answer lost in the restart itself still counts as accepted", async () => {
    boot("e1");
    gm.fetch = (async () => {
      sock().receive({ t: "bye", reason: "restart" });
      throw new TypeError("connection closed");
    }) as unknown as typeof fetch;
    await act.restart("now");
    expect(getState().restart?.state).toBe("accepted");
  });

  test("Cancel restart: POST /api/restart/cancel, and the waiting state goes", async () => {
    boot();
    sock().receive({ t: "notice", text: "kitespan restarts when the running turns end.", id: "drain", actions: ["cancel_restart", "restart_now"] });
    const paths: string[] = [];
    gm.fetch = (async (path: string) => (paths.push(path), new Response(JSON.stringify({ cancelled: true }), { status: 200 }))) as unknown as typeof fetch;
    await act.cancelRestart();
    expect(paths).toEqual(["/api/restart/cancel"]);
    expect(getState().restartWait).toBeNull();
  });
});

describe("a restart seen from a page that slept, or that pressed Restart now (the review of iteration 4 part 1)", () => {
  const pong = () => {
    const ping = sock().sent.filter((f) => f.t === "ping").at(-1) as Extract<ClientFrame, { t: "ping" }>;
    sock().receive({ t: "pong", n: ping.n });
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  /** The phone's socket goes while it sleeps, and it says hello again to the same server: the welcome and the list. */
  const sleepAndReturn = (epoch = "e1") => {
    sock().close();
    for (const fn of timers.splice(0)) fn?.();
    sock().onopen?.({});
    sock().receive(welcome(epoch));
    sock().receive({ t: "chats", list: [] });
  };
  const FAILED: ServerFrame = { t: "notice", text: RESTART_WORDS.notDone, id: "restart_failed" };

  test("accepted, then a welcome of the same epoch whose hello says that the restart did not happen: not done, and its line", async () => {
    boot("e1");
    gm.fetch = (async () => new Response(JSON.stringify({ when: "finish" }), { status: 202 })) as unknown as typeof fetch;
    await act.restart("finish");
    expect(getState().restart?.state).toBe("accepted");
    // The phone slept through the restart that failed its health gate: the old server listens again, and its hello
    // brings the notice that stands since the failure.
    sleepAndReturn();
    sock().receive(FAILED);
    pong();
    await flush();
    expect(getState().restart?.state).toBe("not_done");
    expect(listNotice(getState())).toBe(RESTART_WORDS.notDone);
  });

  test("accepted, then a welcome of the same epoch with no drain, close or failed notice in its hello: Cancel restart on another page; the dialog asks again", async () => {
    boot("e1");
    gm.fetch = (async () => new Response(JSON.stringify({ when: "finish" }), { status: 202 })) as unknown as typeof fetch;
    await act.restart("finish");
    sock().receive({ t: "notice", text: RESTART_WORDS.waits, id: "restart", actions: ["cancel_restart", "restart_now"] });
    // The laptop pressed Cancel restart while this phone slept: the `gone` never came here.
    sleepAndReturn();
    pong();
    await flush();
    expect(getState().restart).toBeNull();
    expect(restartPhase(getState().restart, getState().restartWait, restartLists([], []), getState().restarting)).toBe("ask");
    expect(listNotice(getState())).toBeNull();
  });

  test("the failed notice that a hello brings shows its line once on this page, not at every reconnect; a new restart's failure shows again", async () => {
    boot("e1");
    sock().receive(FAILED);
    expect(listNotice(getState())).toBe(RESTART_WORDS.notDone);
    act.setNotice(null);
    sleepAndReturn();
    sock().receive(FAILED);
    expect(listNotice(getState())).toBeNull();
    // Another try: its close, then its failure.
    sock().receive({ t: "notice", text: RESTART_WORDS.restarting, id: "restart" });
    sock().receive(FAILED);
    expect(listNotice(getState())).toBe(RESTART_WORDS.notDone);
    // A page that asked gets its line with its answer, also from a hello.
    act.setNotice(null);
    gm.fetch = (async () => new Response(JSON.stringify({ when: "now" }), { status: 202 })) as unknown as typeof fetch;
    await act.restart("now");
    sleepAndReturn();
    sock().receive(FAILED);
    expect(getState().restart?.state).toBe("not_done");
    expect(listNotice(getState())).toBe(RESTART_WORDS.notDone);
  });

  test("a drain that still waits sends its notice after the list: the ask stays accepted", async () => {
    boot("e1");
    gm.fetch = (async () => new Response(JSON.stringify({ when: "finish" }), { status: 202 })) as unknown as typeof fetch;
    await act.restart("finish");
    sock().close();
    for (const fn of timers.splice(0)) fn?.();
    sock().onopen?.({});
    sock().receive(welcome("e1"));
    sock().receive({ t: "chats", list: [] });
    sock().receive({ t: "notice", text: "kitespan restarts when the running turns end.", id: "drain", actions: ["cancel_restart", "restart_now"] });
    pong();
    await flush();
    expect(getState().restart?.state).toBe("accepted");
  });

  test("the server's notice that an asked restart did not happen ends the ask (not done) and its Restarting line; the line shows", async () => {
    boot("e1");
    gm.fetch = (async () => new Response(JSON.stringify({ when: "now" }), { status: 202 })) as unknown as typeof fetch;
    await act.restart("now");
    expect(restartingNow(getState())).toBe(true);
    sock().receive({ t: "notice", text: RESTART_WORDS.notDone, id: "restart_failed" });
    expect(getState().restart?.state).toBe("not_done");
    expect(restartingNow(getState())).toBe(false);
    expect(listNotice(getState())).toBe(RESTART_WORDS.notDone);
  });

  test("another page's Cancel restart (`gone`): this page's own ask is over and asks again; the close's notice (another page's Restart now, or the turns' end) says Restarting", async () => {
    boot("e1");
    sock().receive({ t: "chats", list: [{ chat: "k3m7q2x4abk3m7q2x4ab", title: "Runs", project: "k3m7q2x4ab", state: "running", needsYou: false, lastActivity: "2026-11-02T10:00:00.000Z", archived: false, busy: true }] });
    gm.fetch = (async () => new Response(JSON.stringify({ when: "finish" }), { status: 202 })) as unknown as typeof fetch;
    await act.restart("finish");
    sock().receive({ t: "notice", text: RESTART_WORDS.waits, id: "restart", actions: ["cancel_restart", "restart_now"] });
    const lists = () => restartLists(getState().chats, []);
    const phase = () => restartPhase(getState().restart, getState().restartWait, lists(), getState().restarting);
    expect(phase()).toBe("wait");
    // The other page's Cancel: the drain notice goes, and the turn still runs.
    sock().receive({ t: "notice", text: "", id: "restart", gone: true });
    expect(phase()).toBe("ask");
    // A cancelled ask is over, as on the page that pressed Cancel: a later reconnect never calls it not done.
    expect(getState().restart).toBeNull();
    // Again, and this time another page presses Restart now: the close's notice, the bye, then the new server.
    await act.restart("finish");
    sock().receive({ t: "notice", text: RESTART_WORDS.waits, id: "restart", actions: ["cancel_restart", "restart_now"] });
    sock().receive({ t: "notice", text: RESTART_WORDS.restarting, id: "restart" });
    expect(phase()).toBe("restarting");
    byeAndRedial();
    expect(phase()).toBe("restarting");
    sock().receive(welcome("e2"));
    expect(getState().restart?.state).toBe("done");
    // A Cancel when nothing waits any more is a Cancel all the same: the dialog asks again.
    boot("e1");
    await act.restart("finish");
    sock().receive({ t: "notice", text: RESTART_WORDS.waits, id: "restart", actions: ["cancel_restart", "restart_now"] });
    sock().receive({ t: "notice", text: "", id: "restart", gone: true });
    expect(restartPhase(getState().restart, getState().restartWait, restartLists([], []), getState().restarting)).toBe("ask");
    // The drain that ends because the turns did: the close's notice, so the dialog says Restarting.
    await act.restart("finish");
    sock().receive({ t: "notice", text: RESTART_WORDS.waits, id: "restart", actions: ["cancel_restart", "restart_now"] });
    sock().receive({ t: "notice", text: RESTART_WORDS.restarting, id: "restart" });
    expect(restartPhase(getState().restart, getState().restartWait, restartLists([], []), getState().restarting)).toBe("restarting");
  });

  test("Restart now pressed here says Restarting from the press, while the drain line is taken back, until the restart ends", async () => {
    boot("e1");
    sock().receive({ t: "notice", text: "kitespan restarts when the running turns end.", id: "restart", actions: ["cancel_restart", "restart_now"] });
    let answer: (r: Response) => void = () => {};
    gm.fetch = (() => new Promise<Response>((r) => (answer = r))) as unknown as typeof fetch;
    const p = act.restart("now");
    expect(restartingNow(getState())).toBe(true);
    expect(connection()).toContain("restarting");
    sock().receive({ t: "notice", text: RESTART_WORDS.restarting, id: "restart" });
    answer(new Response(JSON.stringify({ when: "now" }), { status: 202 }));
    await p;
    expect(restartingNow(getState())).toBe(true);
    byeAndRedial();
    sock().receive(welcome("e2"));
    expect(getState().restart?.state).toBe("done");
    expect(restartingNow(getState())).toBe(false);
    // A refused Restart now ends it at once.
    gm.fetch = (async () => new Response(JSON.stringify({ error: { code: "preflight", message: "No." } }), { status: 409 })) as unknown as typeof fetch;
    await act.restart("now");
    expect(restartingNow(getState())).toBe(false);
  });
});

// The close's notice (the late safety review of iteration 4 part 1): at the close the server replaces the drain notice
// (its id, "restart") with "Restarting kitespan..." and no buttons, also when no drain came before (Restart now), so
// every page says Restarting from the close, not only from the `bye` that comes up to about 8 s later. `gone` for that
// id is Cancel restart only.
describe("the close's notice: Restarting kitespan... on every page", () => {
  const DRAIN: ServerFrame = { t: "notice", text: RESTART_WORDS.waits, id: "restart", actions: ["cancel_restart", "restart_now"] };
  const CLOSING: ServerFrame = { t: "notice", text: RESTART_WORDS.restarting, id: "restart" };
  const drainLine = () => renderToStaticMarkup(createElement(DrainLine));
  const phase = (lists = restartLists([chat({ serverState: "running" })], [])) => restartPhase(getState().restart, getState().restartWait, lists, getState().restarting);
  const pong = () => {
    const ping = sock().sent.filter((f) => f.t === "ping").at(-1) as Extract<ClientFrame, { t: "ping" }>;
    sock().receive({ t: "pong", n: ping.n });
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("a page that asked nothing: the drain line goes, every screen says Restarting kitespan... (once, not as the screen's notice too), and its dialog says Restarting", () => {
    boot("e1");
    sock().receive(DRAIN);
    expect(text(drainLine())).toContain(RESTART_WORDS.waits);
    expect(phase()).toBe("wait");
    sock().receive(CLOSING);
    expect(getState().restartWait).toBeNull();
    expect(drainLine()).toBe("");
    expect(restartingNow(getState())).toBe(true);
    expect(connection()).toContain("restarting");
    expect(listNotice(getState())).toBeNull();
    expect(phase()).toBe("restarting");
    // The bye, then the new server: the line goes.
    byeAndRedial();
    expect(restartingNow(getState())).toBe(true);
    sock().receive(welcome("e2"));
    expect(restartingNow(getState())).toBe(false);
    expect(phase()).toBe("ask");
  });

  test("Restart now with no drain before it: the close's notice alone says Restarting", () => {
    boot("e1");
    sock().receive(CLOSING);
    expect(connection()).toContain("restarting");
    expect(phase()).toBe("restarting");
  });

  test("Cancel restart elsewhere (`gone`): the dialog that waited asks again, and no Restarting line shows", () => {
    boot("e1");
    sock().receive(DRAIN);
    sock().receive({ t: "notice", text: "", id: "restart", gone: true });
    expect(phase()).toBe("ask");
    expect(restartingNow(getState())).toBe(false);
    expect(connection()).toContain("connected");
  });

  test("a socket that comes back to the server while it closes: the welcome, the close's notice again; the ask stays accepted, then done", async () => {
    boot("e1");
    gm.fetch = (async () => new Response(JSON.stringify({ when: "finish" }), { status: 202 })) as unknown as typeof fetch;
    await act.restart("finish");
    sock().receive(DRAIN);
    sock().receive(CLOSING);
    sock().close();
    for (const fn of timers.splice(0)) fn?.();
    sock().onopen?.({});
    sock().receive(welcome("e1"));
    sock().receive({ t: "chats", list: [] });
    sock().receive(CLOSING);
    pong();
    await flush();
    expect(getState().restart?.state).toBe("accepted");
    expect(restartingNow(getState())).toBe(true);
    byeAndRedial();
    sock().receive(welcome("e2"));
    expect(getState().restart?.state).toBe("done");
  });

  test("the successor could not start (no bye): the server's notice that the restart did not happen ends the Restarting line", () => {
    boot("e1");
    sock().receive(CLOSING);
    sock().receive({ t: "notice", text: RESTART_WORDS.notDone, id: "restart_failed" });
    expect(restartingNow(getState())).toBe(false);
    expect(listNotice(getState())).toBe(RESTART_WORDS.notDone);
  });

  test("a shutdown during the close (its bye says shutdown): the Restarting line ends", () => {
    boot("e1");
    sock().receive(CLOSING);
    sock().receive({ t: "bye", reason: "shutdown" });
    expect(restartingNow(getState())).toBe(false);
  });
});
