// The page's fixes after part 2's review (W24, row 73 and D60): Start waits for its ack (one chat, one worktree) with
// one step line while git makes the worktree; a /new link's project before the project list came; the Worktree switch
// that an off reason must never lock on; New environment's variables, kept until their save went through, never
// dropped for a folder that has a project, and counted by the lines that pass; Delete's confirm says only what Delete
// does (a linked worktree, a worktree a copy shares, a read that waits or failed); Continue in a copy for a chat whose
// Claude Code never ran on this page; the refusal lines in kitespan's words with Claude Code's line under them; the
// unreadable file's line with its link wherever a refusal says it; the editor's keyboard path. Rendered with React's
// server renderer; a fake socket for the frames.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ERROR_MESSAGES, PROTOCOL_VERSION, type ChatEvent, type ChatRow, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, resetState } from "../../web/state/store";
import { applyEvent } from "../../web/state/reduce";
import type { Chat, InfoItem, Item, Project } from "../../web/state/types";
import { ItemView } from "../../web/chat/items/ItemView";
import { TranscriptProvider } from "../../web/chat/items/context";
import { WorktreeOption } from "../../web/worktree/WorktreeOption";
import { DeleteBody } from "../../web/dialogs/ChatDialogs";
import { Finder, addEnvironment } from "../../web/dialogs/NewEnvironment";
import { EnvironmentScreen } from "../../web/screens/EnvironmentScreen";
import { NewChatForm } from "../../web/screens/NewChatForm";
import { NewChat, linkedProject } from "../../web/screens/Home";
import { ChatScreen } from "../../web/chat/ChatScreen";
import { Detail } from "../../web/panels/details";
import { EnvSection, boxKey } from "../../web/env/EnvSection";
import { ENV_WORDS, readField } from "../../web/env/vars";
import { WORKTREE_OFF_LINE, WORKTREE_WORDS, deleteFacts, startActions, startDetail, startLine } from "../../web/worktree/worktree";
import { readWorktreeStatus } from "../../web/worktree/api";
import { parse } from "../../web/router";
import { scripted } from "./fixtures";

const WEB = join(import.meta.dir, "..", "..", "web");
const code = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const css = (name: string) => readFileSync(join(WEB, "styles", name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The text a reader sees: a path's parts (web/worktree/PathText.tsx) read as the one path they are. */
const text = (html: string) =>
  html
    .replace(/<span class="visually-hidden">[^<]*<\/span>/g, "")
    .replace(/<span class="wt-path-part">([^<]*)<\/span>/g, "$1")
    .replace(/<wbr\/?>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
/** The opening tag of the element with this test id. */
const tag = (html: string, id: string) => html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";

const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ROOT = "/work/kitespan";
const WT = "/srv/u/.local/share/kitespan/worktrees/k3m7q2x4ab/wtchataa";
const P: Project = { id: "k3m7q2x4ab", name: "kitespan", folder: ROOT, branch: "", picks: {}, env: 3, worktree: true, worktreeOff: null };
const CHAT = "wtchataaaaaaaaaaaaaa";
const COPY = "wtcopyaaaaaaaaaaaaaa";
const WORKTREE = { path: WT, branch: "kitespan/wtchataa", kept: false };

function chatWith(p: Partial<Chat> = {}): Chat {
  return {
    ...scripted({
      id: CHAT,
      projectId: P.id,
      title: "Try the worktree",
      titleSource: "first-prompt",
      state: "sleeping",
      updatedAt: "2026-11-03T08:00:00.000Z",
      sessionId: SID,
      model: "default",
      effort: "default",
      mode: "default",
      items: [{ id: "u1", kind: "user", text: "go" } as Item],
      pending: [],
      context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] },
      connectors: [],
      outputs: [],
    }),
    serverState: "sleeping",
    worktree: WORKTREE,
    ...p,
  };
}

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
  }
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

function connect(): FakeSocket {
  const socket = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7944/ws", tab: "tab_me", open: () => socket, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  socket.onopen?.({});
  socket.receive({ t: "welcome", epoch: "e1", version: "0.4.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none", host: "devbox" });
  return socket;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const framesOf = <T extends ClientFrame["t"]>(s: FakeSocket, t: T) => s.sent.filter((f): f is Extract<ClientFrame, { t: T }> => f.t === t);

const g = globalThis as unknown as { matchMedia?: unknown; window?: unknown; history?: unknown; fetch: typeof fetch };
const was = { mm: g.matchMedia, win: g.window, hist: g.history, hadMm: "matchMedia" in g, hadWin: "window" in g, hadHist: "history" in g, fetch: g.fetch };
beforeAll(() => {
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.window = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  g.history = { state: null, pushState() {}, replaceState() {} }; // the chat screen reads its entry's trail
});
afterAll(() => {
  if (was.hadMm) g.matchMedia = was.mm;
  else delete g.matchMedia;
  if (was.hadWin) g.window = was.win;
  else delete g.window;
  if (was.hadHist) g.history = was.hist;
  else delete g.history;
  g.fetch = was.fetch;
  connectWith(null);
  resetState();
});
beforeEach(() => {
  g.fetch = was.fetch;
  connectWith(null);
  resetState({ ready: true, projects: [P], chats: [chatWith()] });
});

// ---------------------------------------------------------------------------------------------------------------

describe("Start waits for its ack (W3): one chat and one worktree per press, and one step line while git works", () => {
  test("a second Start while the first waits sends no second new_chat; the wait ends with the ack, ok or refused", async () => {
    const socket = connect();
    const session = "5f0c2a8e-1b3d-4c5e-8f70-123456789abc";
    const first = act.newChat({ projectId: P.id, text: "Make the coupon page", sessionId: session });
    const second = act.newChat({ projectId: P.id, text: "Make the coupon page", sessionId: session });
    expect(await second).toBeNull();
    expect(framesOf(socket, "new_chat")).toHaveLength(1);
    expect(getState().newChatOut).toEqual([session]);
    const f = framesOf(socket, "new_chat")[0]!;
    socket.receive({ t: "ack", rid: f.rid, ok: true, result: { chat: CHAT } });
    expect(await first).toBe(CHAT);
    expect(getState().newChatOut).toEqual([]);
    // A refusal ends the wait too, so Start can be pressed again.
    const third = act.newChat({ projectId: P.id, text: "again", sessionId: session });
    const f3 = framesOf(socket, "new_chat")[1]!;
    socket.receive({ t: "ack", rid: f3.rid, ok: false, error: { code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed } });
    expect(await third).toBeNull();
    expect(getState().newChatOut).toEqual([]);
  });

  test("while it waits, a worktree project's form shows one step line in Start's place; a plain project's Start is off", () => {
    resetState({ ready: true, projects: [P], chats: [], newChatOut: ["5f0c2a8e-1b3d-4c5e-8f70-123456789abc"] });
    const html = renderToStaticMarkup(createElement(NewChatForm, { init: { project: P.id, text: "Make it" }, autoFocus: false }));
    expect(ids(html)).not.toContain("confirm-start");
    expect(tag(html, "start-step")).toMatch(/role="status"/);
    expect(text(html)).toContain(WORKTREE_WORDS.making);
    expect(WORKTREE_WORDS.making).toBe("Making the worktree...");
    const plain: Project = { ...P, worktree: false };
    resetState({ ready: true, projects: [plain], chats: [], newChatOut: ["5f0c2a8e-1b3d-4c5e-8f70-123456789abc"] });
    const off = renderToStaticMarkup(createElement(NewChatForm, { init: { project: P.id, text: "Make it" }, autoFocus: false }));
    expect(tag(off, "confirm-start")).toMatch(/disabled=""/);
    expect(ids(off)).not.toContain("start-step");
    // With nothing waiting, Start is the button.
    resetState({ ready: true, projects: [P], chats: [] });
    const idle = renderToStaticMarkup(createElement(NewChatForm, { init: { project: P.id, text: "Make it" }, autoFocus: false }));
    expect(tag(idle, "confirm-start")).not.toMatch(/disabled/);
    expect(ids(idle)).not.toContain("start-step");
  });
});

describe("a /new link's project (an iteration 3 bug): the link wins once the project list comes", () => {
  const B = { ...P, id: "bbbbbbbbbb", name: "shop", folder: "/work/shop" };
  test("before the list came, the link's project stands, with no line; after it, a project that is not there is unread", () => {
    expect(linkedProject("bbbbbbbbbb", [], false)).toEqual({ project: "bbbbbbbbbb", unread: false });
    expect(linkedProject("bbbbbbbbbb", [P, B], true)).toEqual({ project: "bbbbbbbbbb", unread: false });
    expect(linkedProject("cccccccccc", [P, B], true)).toEqual({ project: undefined, unread: true });
    expect(linkedProject("cccccccccc", [], true)).toEqual({ project: undefined, unread: true });
    expect(linkedProject(undefined, [], false)).toEqual({ project: undefined, unread: false });
  });

  test("/new?project=<not the newest> opened as a new document: the form holds that project, and no line shows", () => {
    // The page's first render of a new document: the projects' read has not answered yet.
    resetState({ ready: true, projects: [], chats: [] });
    const route = parse(new URL("http://x/new?project=bbbbbbbbbb"));
    const html = renderToStaticMarkup(createElement(NewChat, { route }));
    expect(ids(html)).not.toContain("link-notice");
    // The form keeps the link's project from its first mount (it is keyed on the URL alone, so it is not mounted again
    // when the list comes): its draft names that project.
    expect(code("screens", "Home.tsx")).toContain("<NewChatForm key={JSON.stringify(q)} init={init} autoFocus />");
    expect(code("screens", "Home.tsx")).toContain("linkedProject(wantProject, projects, projectsRead)");
    // Once the list came, the form shows it (it was not the newest).
    resetState({ ready: true, projects: [P, B], chats: [], projectsRead: true });
    const after = renderToStaticMarkup(createElement(NewChat, { route }));
    expect(text(after)).toContain("What should we work on in shop?");
  });

  test("the project list's read marks the list as known", async () => {
    g.fetch = (async () => new Response(JSON.stringify({ project: { id: P.id, name: "kitespan", cwd: ROOT, createdAt: "", lastUsedAt: "", picks: { model: null, effort: null, permissionMode: null } } }), { status: 200 })) as unknown as typeof fetch;
    resetState({ ready: true, projects: [], chats: [] });
    expect(getState().projectsRead).toBe(false);
    await act.addFolder(ROOT);
    expect(getState().projectsRead).toBe(true);
  });
});

describe("the Worktree switch (W2): an off reason never locks it on", () => {
  test("on with an off reason: still on, and enabled, so it can be turned off; the reason's line shows under it", () => {
    const html = renderToStaticMarkup(createElement(WorktreeOption, { on: true, off: "hook", onChange: () => {} }));
    const sw = tag(html, "worktree-switch");
    expect(sw).toMatch(/checked=""/);
    expect(sw).not.toMatch(/disabled/);
    expect(text(html)).toContain(WORKTREE_OFF_LINE.hook);
    // Off with a reason: it cannot be turned on.
    const off = tag(renderToStaticMarkup(createElement(WorktreeOption, { on: false, off: "hook", onChange: () => {} })), "worktree-switch");
    expect(off).toMatch(/disabled=""/);
    expect(off).not.toMatch(/checked/);
  });

  test("the editor of a project with {worktree: true, worktreeOff: 'hook'}: an enabled switch, whose press sends {on: false}", async () => {
    const stuck: Project = { ...P, worktree: true, worktreeOff: "hook" };
    resetState({ ready: true, projects: [stuck], chats: [] });
    const html = renderToStaticMarkup(createElement(EnvironmentScreen, { route: parse(new URL(`http://x/p/${P.id}/environment`)) }));
    const sw = tag(html, "worktree-switch");
    expect(sw).toMatch(/checked=""/);
    expect(sw).not.toMatch(/disabled/);
    const calls: unknown[] = [];
    g.fetch = (async (url: string, init: RequestInit) => {
      calls.push([url, JSON.parse(String(init.body))]);
      return new Response(JSON.stringify({ project: { id: P.id, cwd: ROOT, name: "kitespan", createdAt: "", lastUsedAt: "", picks: { model: null, effort: null, permissionMode: null }, worktree: false, worktreeOff: "hook", env: 3 } }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await act.setWorktree(P.id, false)).toBe(true);
    expect(calls).toEqual([[`/api/projects/${P.id}/worktree`, { on: false }]]);
    // The press is the switch's own value: the checkbox turns to unchecked, which is {on: false}.
    expect(code("ui", "Switch.tsx")).toContain("onChange={(e) => onChange(e.currentTarget.checked)}");
  });

  test("New environment: a folder whose read says off shows the switch off, whatever was picked before the read came", () => {
    resetState({ ready: true, projects: [] });
    const LISTING = { ok: true as const, path: "/srv/u", parent: "/srv", home: "/srv/u", folders: [], truncated: false };
    const html = renderToStaticMarkup(createElement(Finder, { onAdded: () => {}, onClose: () => {}, start: { listing: LISTING, suggested: [], can: { ok: false, why: "no_commit" }, worktree: true } }));
    const sw = tag(html, "new-env-worktree");
    expect(sw).not.toMatch(/checked/);
    expect(sw).toMatch(/disabled=""/);
  });

  test("while its POST runs, the switch keeps the focus: it is never disabled for that (a press then does nothing)", () => {
    const html = renderToStaticMarkup(createElement(WorktreeOption, { on: true, off: null, busy: true, onChange: () => {} }));
    const sw = tag(html, "worktree-switch");
    expect(sw).not.toMatch(/disabled/);
    expect(sw).toMatch(/aria-busy="true"/);
    expect(code("worktree", "WorktreeOption.tsx")).toMatch(/if \(!busy\) onChange\(v\)/);
  });
});

describe("Delete's confirm says only what Delete does (W9, L26, L27, W12)", () => {
  const draw = () => renderToStaticMarkup(createElement(DeleteBody, { chat: getState().chats.find((c) => c.id === CHAT)!, onClose: () => {} }));

  test("while the worktree's read runs: the path line without a claim of changes, a dim ..., and Delete off", () => {
    const html = draw();
    expect(text(html)).toContain(`This also removes its worktree, ${WT}. ...`);
    expect(text(html)).not.toContain("changes");
    expect(html).toMatch(/data-testid="worktree-delete-line"[^>]*>[^]*?\.\.\./);
    expect(tag(html, "confirm-delete")).toMatch(/disabled=""/);
    expect(deleteFacts(WORKTREE, undefined, false)).toEqual({ line: `This also removes its worktree, ${WT}.`, reading: true, branch: null });
  });

  test("a read that failed: Delete is on, and the line says the changes could not be read, never the clean form", () => {
    const f = deleteFacts(WORKTREE, null, false);
    expect(f).toEqual({ line: `This also removes its worktree, ${WT}, whose changes could not be read.`, reading: false, branch: null });
    expect(deleteFacts(WORKTREE, { changes: 2, branchStays: true }, false)).toEqual({
      line: `This also removes its worktree, ${WT}, with changes in 2 files.`,
      reading: false,
      branch: "Its branch kitespan/wtchataa stays: it holds commits that no other branch has.",
    });
    expect(deleteFacts(WORKTREE, { changes: 0, branchStays: false }, false)).toEqual({ line: `This also removes its worktree, ${WT}.`, reading: false, branch: null });
  });

  test("a terminal session's linked worktree (Continue here, W12): no line, no read, and Delete is on", () => {
    const linked = chatWith({ worktree: { ...WORKTREE, own: false as const } });
    resetState({ ready: true, projects: [P], chats: [linked] });
    const html = draw();
    expect(ids(html)).not.toContain("worktree-delete-line");
    expect(ids(html)).not.toContain("worktree-branch-line");
    expect(tag(html, "confirm-delete")).not.toMatch(/disabled/);
    expect(deleteFacts({ ...WORKTREE, own: false as const }, undefined, false)).toEqual({ line: null, reading: false, branch: null });
  });

  test("a worktree that a copy shares (L27): Delete keeps it, so its confirm names no removal", () => {
    const copy = chatWith({ id: COPY, title: "Copy" });
    resetState({ ready: true, projects: [P], chats: [chatWith(), copy] });
    const html = draw();
    expect(ids(html)).not.toContain("worktree-delete-line");
    expect(tag(html, "confirm-delete")).not.toMatch(/disabled/);
    // The server's own answer wins when it says so.
    expect(deleteFacts(WORKTREE, { changes: 1, branchStays: false, removes: false }, false)).toEqual({ line: null, reading: false, branch: null });
  });

  test("the facts read: a 404 (no worktree of its own) removes nothing; the server's removes is read", async () => {
    const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await readWorktreeStatus(CHAT, answer({ error: { code: "not_found", message: "x" } }, 404))).toEqual({ changes: null, branchStays: false, removes: false });
    expect(await readWorktreeStatus(CHAT, answer({ changes: 1, branchStays: false, removes: false }))).toEqual({ changes: 1, ignored: false, branchStays: false, removes: false });
    expect(await readWorktreeStatus(CHAT, answer({ changes: 1, branchStays: false }))).toEqual({ changes: 1, ignored: false, branchStays: false });
    expect(await readWorktreeStatus(CHAT, answer({ error: { code: "failed", message: "x" } }, 500))).toBeNull();
  });

  test("the chat list's own: false is the page's; a row without it is kitespan's own worktree", () => {
    const socket = connect();
    socket.receive({ t: "chats", list: [{ chat: CHAT, title: "t", project: P.id, state: "sleeping", needsYou: false, lastActivity: "2026-11-03T08:00:00.000Z", archived: false, worktree: { ...WORKTREE, own: false } } as ChatRow] });
    expect(getState().chats[0]!.worktree).toEqual({ ...WORKTREE, own: false });
    socket.receive({ t: "chats", delta: { chat: CHAT, worktree: WORKTREE } });
    expect(getState().chats[0]!.worktree).toEqual(WORKTREE);
  });
});

describe("a refused start's line (W4, W5; DESIGN 4.4 'Claude Code's own refusals')", () => {
  const reduce = (chat: Chat, e: ChatEvent, seq = 5) => applyEvent(chat, e, { seq, replay: false, cwd: WT, now: 0 });
  const draw = (chat: Chat, item: Item) =>
    renderToStaticMarkup(
      createElement(TranscriptProvider, { value: { chatId: chat.id, view: "normal", readOnly: false, isOpen: () => false, toggle: () => {} } }, createElement(ItemView, { item, chatId: chat.id })),
    );
  const CLI = "Error: cannot resume into worktree /tmp/x/m2rnybim because the session's worktree binding does not match this folder";

  test("worktree_resume_refused: kitespan's sentence, with Claude Code's own line under it in mono", () => {
    const chat = reduce(chatWith(), { k: "notice", text: CLI, code: "worktree_resume_refused" });
    resetState({ ready: true, projects: [P], chats: [chat] });
    const line = chat.items.at(-1) as InfoItem;
    expect(line).toMatchObject({ text: ERROR_MESSAGES.worktree_resume_refused, detail: CLI, start: "worktree_resume_refused" });
    const html = draw(chat, line);
    expect(text(html)).toBe(`${ERROR_MESSAGES.worktree_resume_refused} ${CLI} ${WORKTREE_WORDS.copy} ${WORKTREE_WORDS.without}`);
    expect(html).toMatch(/<p class="[^"]*\bwt-start-detail\b[^"]*\bmono\b[^"]*"/);
    // From an exit's startup too.
    const exited = reduce(chatWith(), { k: "exit", code: 1, signal: null, stderr: [], startup: { reason: "worktree_resume_refused", line: CLI } });
    expect(exited.items.at(-1)).toMatchObject({ text: ERROR_MESSAGES.worktree_resume_refused, detail: CLI });
  });

  test("worktree_unverified: the fixed sentence alone; a line with no CLI text or the same words has no detail", () => {
    const chat = reduce(chatWith(), { k: "notice", text: "Error: could not verify the worktree", code: "worktree_unverified" });
    expect(chat.items.at(-1)).toMatchObject({ text: ERROR_MESSAGES.worktree_unverified, start: "worktree_unverified" });
    expect((chat.items.at(-1) as InfoItem).detail).toBeUndefined();
    resetState({ ready: true, projects: [P], chats: [chat] });
    expect(text(draw(chat, chat.items.at(-1)!))).toBe(`${ERROR_MESSAGES.worktree_unverified} ${WORKTREE_WORDS.tryAgain}`);
    expect(startLine("worktree_gone")).toBe(ERROR_MESSAGES.worktree_gone);
    expect(startDetail("worktree_resume_refused", ` ${ERROR_MESSAGES.worktree_resume_refused} `)).toBeUndefined();
    expect(startDetail("worktree_resume_refused", "")).toBeUndefined();
    expect(startDetail("worktree_unverified", "Error: x")).toBeUndefined();
  });

  test("a gone linked worktree (W12) offers Continue in the project folder only; cwd_unavailable never names Make it again", () => {
    const linked = { ...WORKTREE, own: false as const };
    expect(startActions("cwd_unavailable", linked)).toEqual(["project"]);
    expect(startActions("cwd_unavailable", WORKTREE)).toEqual(["project"]);
    expect(startActions("cwd_unavailable", null)).toEqual([]);
    expect(startActions("worktree_gone", WORKTREE)).toEqual(["again", "project"]);
    expect(startActions("worktree_gone", linked)).toEqual(["project"]);
    const chat = reduce(chatWith({ worktree: linked }), { k: "notice", text: ERROR_MESSAGES.cwd_unavailable, code: "cwd_unavailable" });
    resetState({ ready: true, projects: [P], chats: [chat] });
    const html = draw(chat, chat.items.at(-1)!);
    expect(ids(html)).toContain("start-project");
    expect(ids(html)).not.toContain("start-again");
  });

  test("Continue in a copy on a chat whose Claude Code never ran on this page: the row's session id enables it, and a press forks it", async () => {
    const socket = connect();
    const row = { chat: CHAT, title: "Try the worktree", project: P.id, state: "sleeping", needsYou: false, lastActivity: "2026-11-03T08:00:00.000Z", archived: false, worktree: WORKTREE, session: SID } as ChatRow;
    socket.receive({ t: "chats", list: [row] });
    expect(getState().chats[0]!.sessionId).toBe(SID);
    const chat = reduce(getState().chats[0]!, { k: "notice", text: CLI, code: "worktree_resume_refused" });
    resetState({ ready: true, projects: [P], chats: [chat] });
    const html = draw(chat, chat.items.at(-1)!);
    expect(tag(html, "start-copy")).not.toMatch(/disabled/);
    expect(tag(html, "start-copy")).toMatch(/class="btn primary"/);
    const copied = act.continueSession(P.id, getState().chats[0]!.sessionId, true);
    const f = framesOf(socket, "continue_session");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ project: P.id, session: SID, fork: true });
    socket.receive({ t: "ack", rid: f[0]!.rid, ok: true, result: { chat: COPY } });
    expect(await copied).toBe(COPY);
    // A row without a session id keeps the one the page has; one that cannot be a session id is none.
    socket.receive({ t: "chats", list: [{ ...row, session: "not a session" } as ChatRow] });
    expect(getState().chats[0]!.sessionId).toBe(SID);
  });

  test("after Make it again or Continue in the project folder went through, the composer's field takes the focus (a laptop)", () => {
    const src = code("worktree", "StartLine.tsx");
    expect(src).toMatch(/if \(ok && !touch\) focusComposer\(\)/);
    expect(src).toContain('document.querySelector<HTMLElement>(\'[data-testid="composer-input"]\')');
  });
});

describe("the unreadable environment's line (L39): one line and a way to clear it, wherever a refusal says it", () => {
  test("a send that env_unreadable refused: the chat's line links to the project's environment", async () => {
    const socket = connect();
    socket.receive({ t: "chats", list: [{ chat: CHAT, title: "t", project: P.id, state: "sleeping", needsYou: false, lastActivity: "2026-11-03T08:00:00.000Z", archived: false }] });
    void act.send(CHAT, "hello");
    const f = framesOf(socket, "send")[0]!;
    socket.receive({ t: "ack", rid: f.rid, ok: false, error: { code: "env_unreadable", message: ERROR_MESSAGES.env_unreadable } });
    await tick();
    expect(getState().notice).toBe(ERROR_MESSAGES.env_unreadable);
    expect(getState().noticeFor).toEqual({ code: "env_unreadable", project: P.id });
    const html = renderToStaticMarkup(createElement(ChatScreen, { route: parse(new URL(`http://x/c/${CHAT}`)) }));
    expect(html).toMatch(/data-testid="chat-notice"[^]*?href="\/p\/k3m7q2x4ab\/environment"/);
    // Another line later is a plain line again: the code goes with the line it came with.
    act.setNotice("Something else.");
    expect(getState().noticeFor).toBeNull();
  });

  test("a Start that env_unreadable refused: the form's screen line links to that project's environment", async () => {
    const socket = connect();
    resetState({ ready: true, projects: [P], chats: [], projectsRead: true });
    void act.newChat({ projectId: P.id, text: "go", sessionId: "6f0c2a8e-1b3d-4c5e-8f70-123456789abc" });
    const f = framesOf(socket, "new_chat")[0]!;
    socket.receive({ t: "ack", rid: f.rid, ok: false, error: { code: "env_unreadable", message: ERROR_MESSAGES.env_unreadable } });
    await tick();
    expect(getState().noticeFor).toEqual({ code: "env_unreadable", project: P.id });
    const html = renderToStaticMarkup(createElement(NewChat, { route: parse(new URL(`http://x/new?project=${P.id}`)) }));
    expect(html).toMatch(/data-testid="screen-notice"[^]*?href="\/p\/k3m7q2x4ab\/environment"/);
  });
});

describe("New environment's variables (E6, L39, D60)", () => {
  const HOME = "/srv/u";
  const LISTING = { ok: true as const, path: HOME, parent: "/srv", home: HOME, folders: [{ name: "site", path: `${HOME}/site`, git: true, subfolders: false, link: false }], truncated: false };
  const render = (start: Record<string, unknown>) => renderToStaticMarkup(createElement(Finder, { onAdded: () => {}, onClose: () => {}, start: { listing: LISTING, suggested: [], ...start } }));
  const SITE = { id: "p0p0p0p0p0", cwd: `${HOME}/site`, name: "site", createdAt: "", lastUsedAt: "", picks: { model: null, effort: null, permissionMode: null }, worktree: false, env: 0 };

  test("a save that failed keeps the variables: the next Use this folder sends only the save again, and the form opens after it", async () => {
    const calls: string[] = [];
    let envFails = 1;
    g.fetch = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (url === "/api/projects") return new Response(JSON.stringify({ project: SITE }), { status: 201 });
      if (envFails-- > 0) throw new TypeError("network");
      return new Response(JSON.stringify({ vars: [{ name: "STRIPE_KEY", at: "2026-11-03T08:00:00.000Z", inSettings: false }], unreadable: false }), { status: 200 });
    }) as unknown as typeof fetch;
    resetState({ ready: true, projects: [] });
    const vars = readField("STRIPE_KEY=sk-test-1");
    const first = await addEnvironment({ target: `${HOME}/site`, existing: undefined, made: null, worktree: false, vars });
    expect(first).toMatchObject({ kind: "notSaved", made: "p0p0p0p0p0" });
    expect(calls).toEqual(["POST /api/projects", "POST /api/projects/p0p0p0p0p0/env"]);
    // The project exists now, so the dialog's folder has a project: it is this dialog's own, and the save is retried.
    const existing = getState().projects.find((p) => p.id === "p0p0p0p0p0");
    const second = await addEnvironment({ target: `${HOME}/site`, existing, made: "p0p0p0p0p0", worktree: false, vars });
    expect(second).toEqual({ kind: "added", id: "p0p0p0p0p0" });
    expect(calls).toEqual(["POST /api/projects", "POST /api/projects/p0p0p0p0p0/env", "POST /api/projects/p0p0p0p0p0/env"]);
    // The field emptied by the user: the project opens with no save.
    const none = await addEnvironment({ target: `${HOME}/site`, existing, made: "p0p0p0p0p0", worktree: false, vars: readField("") });
    expect(none).toEqual({ kind: "added", id: "p0p0p0p0p0" });
    expect(calls).toHaveLength(3);
  });

  test("while the save waits for a retry, the dialog keeps the field and its lines for the project it made", () => {
    // The folder Use this folder takes (Browse's, HOME) is the project this dialog made.
    resetState({ ready: true, projects: [{ id: "p0p0p0p0p0", name: "u", folder: HOME, branch: "", picks: {}, env: 0, worktree: false }] });
    const html = render({ vars: "STRIPE_KEY=sk-test-1", made: "p0p0p0p0p0", refused: ["The variables were not saved."] });
    expect(html).toContain("<textarea");
    expect(text(html)).toContain("The variables were not saved.");
    expect(tag(html, "confirm-use-folder")).not.toMatch(/disabled/);
    expect(ids(html)).not.toContain("env-existing-vars");
  });

  test("typed lines and a folder that has a project: Use this folder is off, with one line and the editor's link; nothing is dropped", () => {
    resetState({ ready: true, projects: [{ id: "h0h0h0h0h0", name: "u", folder: HOME, branch: "", picks: {}, env: 2, worktree: true }] });
    const html = render({ vars: "STRIPE_KEY=sk-test-1" });
    expect(tag(html, "confirm-use-folder")).toMatch(/disabled=""/);
    expect(text(html)).toMatch(/This folder has an environment already\. Add these in its editor ?\./);
    expect(html).toMatch(/data-testid="env-existing-vars"[^]*?href="\/p\/h0h0h0h0h0\/environment"/);
    // The field stays in view, so it can be emptied (or copied from); no link carries what it holds.
    expect(html).toContain("<textarea");
    for (const h of html.match(/href="[^"]*"/g) ?? []) expect(h).not.toContain("sk-test-1");
    // With no typed lines, Use this folder takes that project.
    expect(tag(render({}), "confirm-use-folder")).not.toMatch(/disabled/);
  });

  test("a folder that has a project: both rows, Worktree (On or Off) and Environment variables, link to its editor (DESIGN 6.9)", () => {
    resetState({ ready: true, projects: [{ id: "h0h0h0h0h0", name: "u", folder: HOME, branch: "", picks: {}, env: 2, worktree: true }] });
    const html = render({});
    expect(text(html)).toContain("Worktree On Environment variables 2 variables");
    expect(html.match(/href="\/p\/h0h0h0h0h0\/environment"/g)).toHaveLength(2);
  });

  test("the row's count is the lines that pass; while a line has a problem it shows no count", () => {
    resetState({ ready: true, projects: [] });
    expect(text(render({ vars: "API_KEY=abc\nnot a line\nPATH=/x" }))).not.toMatch(/Environment variables \d+ variables?/);
    expect(text(render({ vars: "API_KEY=abc\nOTHER=1" }))).toContain("Environment variables 2 variables");
    expect(text(render({ vars: "" }))).toContain(`Environment variables ${ENV_WORDS.none}`);
  });
});

describe("the editor's variables (E6): the unreadable file, and the keyboard path", () => {
  const unreadable = { vars: [], unreadable: true };

  test("an unreadable file: its line and Remove the unreadable file, and no 'None for this environment' under it", () => {
    const html = renderToStaticMarkup(createElement(EnvSection, { project: P, marked: null, running: false, start: unreadable }));
    expect(ids(html)).toContain("env-unreadable");
    expect(ids(html)).not.toContain("env-none");
    expect(text(html)).not.toContain(ENV_WORDS.none);
    const fine = renderToStaticMarkup(createElement(EnvSection, { project: P, marked: null, running: false, start: { vars: [], unreadable: false } }));
    expect(ids(fine)).toContain("env-none");
  });

  test("Remove the unreadable file asks in place, with Cancel and Remove, as a variable's Remove does", () => {
    const asked = renderToStaticMarkup(createElement(EnvSection, { project: P, marked: null, running: false, start: unreadable, askDiscard: true }));
    expect(ids(asked)).toContain("env-discard-ask");
    expect(text(asked)).toContain(`${ENV_WORDS.cancel} ${ENV_WORDS.remove}`);
    expect(ids(asked)).toContain("confirm-env-discard");
    // The first press only asks: the button that sends is the ask's.
    const first = renderToStaticMarkup(createElement(EnvSection, { project: P, marked: null, running: false, start: unreadable }));
    expect(ids(first)).toContain("env-discard");
    expect(ids(first)).not.toContain("confirm-env-discard");
  });

  test("Escape in a box is its Cancel; an input method's Escape is the method's", () => {
    expect(boxKey({ key: "Escape", isComposing: false })).toBe(true);
    expect(boxKey({ key: "Escape", isComposing: true })).toBe(false);
    expect(boxKey({ key: "Enter", isComposing: false })).toBe(false);
    const src = code("env", "EnvSection.tsx");
    // Each box (Edit's, the Remove ask, Add variables, the unreadable file's ask) closes on it.
    expect(src.match(/onKeyDown=\{onBoxKey\(/g)?.length).toBeGreaterThanOrEqual(4);
    // A box that closes gives the focus back to the button that opened it; after a Remove, the next row's Edit or Add.
    expect(src).toContain("focusLater(");
  });
});

describe("the chat's Environment detail on touch (row 73, D60)", () => {
  test("'Worktree of <folder>' is the size of the path above it", () => {
    resetState({ ready: true, projects: [P], chats: [chatWith()], machine: "devbox" });
    const html = renderToStaticMarkup(createElement(Detail, { name: "environment", chat: getState().chats[0]!, route: parse(new URL(`http://x/c/${CHAT}/environment`)) }));
    expect(tag(html, "worktree-of")).toMatch(/class="[^"]*\bside-sub\b/);
    const sheet = css("environment.css") + css("panels.css");
    expect(sheet).toMatch(/\.side-sub\s*\{[^}]*font-size:\s*var\(--fs-small\)/);
    expect(sheet).toMatch(/\.touch \.side-sub\s*\{[^}]*font-size:\s*var\(--fs-ui\)/);
    // The same sizes as the mono path (.side-path, and .touch .side-path).
    expect(css("panels.css")).toMatch(/\.side-path\s*\{[^}]*font-size:\s*var\(--fs-small\)/);
    expect(css("panels.css")).toMatch(/\.touch \.side-path\s*\{[^}]*font-size:\s*var\(--fs-ui\)/);
  });

  test("the Environment variables link is a 44 px target on touch", () => {
    expect(css("environment.css")).toMatch(/\.touch \.side-env-link\s*\{[^}]*min-height:\s*var\(--touch\)/);
    expect(css("environment.css")).toMatch(/\.touch \.side-env-link\s*\{[^}]*display:\s*(block|flex)/);
  });
});
