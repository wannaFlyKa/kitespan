// Row 99 on the page: an environment's menu on its heading (Rename, Move up, Move down, Remove) and on its page (Rename,
// Remove); Rename's field and Remove's confirm, each on its own path; the order steps of Move up, Move down and a
// heading's drop as one move request; the `projects` frame (every page reads the list again; `removed`: the pages on
// that environment or its chats go to / with no line, and it and its chats leave the lists at once); and the actions'
// requests, each only from its named button.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ChatRow, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { REMOVE_BUSY } from "../../server/chats/environments";
import { Connection, type SocketLike } from "../../web/net/socket";
import { parse, pushedState } from "../../web/router";
import { act, connectWith, getState, resetState } from "../../web/state/store";
import { dropBefore, gapAt, onEnvironment, reordered, stepBefore } from "../../web/state/environments";
import { EnvRenameForm, REMOVE_BUSY_LINE, REMOVE_VARS_LINE, RemoveEnvBody, envBusy, envParent, removeLine, removeTitle, removeTrees } from "../../web/dialogs/EnvironmentDialogs";
import { removeTreeLine } from "../../web/worktree/worktree";
import { ChatListBody } from "../../web/screens/ChatListBody";
import { CHATS, PROJECTS } from "./fixtures";

const WEB = join(import.meta.dir, "..", "..", "web");
const A = "aaaaaaaaaa";
const B = "bbbbbbbbbb";
const C = "cccccccccc";
const CHAT_A = "chatofaxxxxxxxxxxxxx";
const CHAT_B = "chatofbxxxxxxxxxxxxx";

describe("the order steps", () => {
  const all = [A, B, C];
  test("reordered: just before another, or last; an unknown place puts it last", () => {
    const list = all.map((id) => ({ id }));
    expect(reordered(list, C, A).map((p) => p.id)).toEqual([C, A, B]);
    expect(reordered(list, A, null).map((p) => p.id)).toEqual([B, C, A]);
    expect(reordered(list, A, A).map((p) => p.id)).toEqual(all);
    expect(reordered(list, B, "zzzzzzzzzz").map((p) => p.id)).toEqual([A, C, B]);
  });
  test("Move up and Move down: the first has no Move up, the last no Move down", () => {
    expect(stepBefore(all, all, A, -1)).toBeUndefined();
    expect(stepBefore(all, all, B, -1)).toBe(A);
    expect(stepBefore(all, all, A, 1)).toBe(C);
    expect(stepBefore(all, all, B, 1)).toBeNull();
    expect(stepBefore(all, all, C, 1)).toBeUndefined();
  });
  test("in a filtered view a step goes past the next one shown", () => {
    // Only A and C show (B has no working chat): A down goes after C, C up goes before A.
    expect(stepBefore(all, [A, C], A, 1)).toBeNull();
    expect(stepBefore(all, [A, C], C, -1)).toBe(A);
  });
  test("a drop: the gap under the pointer, none where the heading already is", () => {
    expect(dropBefore(all, all, A, 0)).toBeUndefined();
    expect(dropBefore(all, all, A, 1)).toBeUndefined();
    expect(dropBefore(all, all, A, 2)).toBe(C);
    expect(dropBefore(all, all, A, 3)).toBeNull();
    expect(dropBefore(all, all, C, 0)).toBe(A);
    expect(dropBefore(all, all, C, 3)).toBeUndefined();
    expect(gapAt(5, [10, 40, 70])).toBe(0);
    expect(gapAt(41, [10, 40, 70])).toBe(2);
    expect(gapAt(99, [10, 40, 70])).toBe(3);
  });
  test("the pages of an environment: its page, Rename, Remove, a session, its chats and /new in it", () => {
    const on = (path: string) => onEnvironment(parse(new URL(path, "http://127.0.0.1")), A, [CHAT_A]);
    for (const p of [`/p/${A}`, `/p/${A}/rename`, `/p/${A}/remove`, `/p/${A}/session/7c9e6679-7425-40de-944b-e07fc1f90ae7`, `/c/${CHAT_A}`, `/c/${CHAT_A}/details`, `/new?project=${A}`]) expect(on(p)).toBe(true);
    for (const p of ["/", "/chats", `/p/${B}`, `/c/${CHAT_B}`, `/new?project=${B}`, "/settings"]) expect(on(p)).toBe(false);
  });
});

describe("the words", () => {
  test("Remove's confirm says what leaves kitespan and what stays; its refusal is the server's own line", () => {
    expect(removeTitle("notes-api")).toBe("Remove notes-api?");
    expect(removeLine(3)).toBe("Its 3 chats leave kitespan. Their conversations stay in Claude Code, and the folder is not changed.");
    expect(removeLine(1)).toBe("Its chat leaves kitespan. The conversation stays in Claude Code, and the folder is not changed.");
    expect(removeLine(0)).toBe("The folder is not changed.");
    expect(REMOVE_BUSY_LINE).toBe(REMOVE_BUSY);
  });
  test("row 100: while a worktree inside the folder may go, the first line does not say that the folder is not changed", () => {
    expect(removeLine(3, true)).toBe("Its 3 chats leave kitespan. Their conversations stay in Claude Code.");
    expect(removeLine(1, true)).toBe("Its chat leaves kitespan. The conversation stays in Claude Code.");
    expect(removeLine(3, false)).toBe(removeLine(3));
  });
  test("busy: a chat of it that works or needs input; an archived or sleeping one does not count", () => {
    const of = (projectId: string, over = {}) => ({ ...CHATS[0]!, projectId, archived: false, busy: false, serverState: "sleeping" as const, state: "sleeping" as const, needsYou: false, pending: [], turn: null, tasks: [], ...over });
    expect(envBusy([of(A)], A)).toBe(false);
    expect(envBusy([of(A, { serverState: "running", state: "running" })], A)).toBe(true);
    expect(envBusy([of(A, { needsYou: true, serverState: "waiting", state: "waiting" })], A)).toBe(true);
    expect(envBusy([of(B, { serverState: "running", state: "running" })], A)).toBe(false);
    expect(envBusy([of(A, { busy: true, archived: true })], A)).toBe(false);
    // Part 2: another app, or the finishing hold, holds a chat of it (the server refuses Remove then too).
    expect(envBusy([of(A, { held: { app: "terminal", session: "7c9e6679-7425-40de-944b-e07fc1f90ae7" } })], A)).toBe(true);
    expect(envBusy([of(A, { held: { app: "other", session: "7c9e6679-7425-40de-944b-e07fc1f90ae7", kind: "finishing" } })], A)).toBe(true);
  });
  test("Rename and Remove close back to the page that opened them, else the project page", () => {
    expect(envParent(A, `/c/${CHAT_A}`)).toBe(`/c/${CHAT_A}`);
    expect(envParent(A, "/chats")).toBe("/chats");
    expect(envParent(A, `/p/${A}`)).toBe(`/p/${A}`);
    expect(envParent(A, `/p/${A}/remove`)).toBe(`/p/${A}`);
    expect(envParent(A, undefined)).toBe(`/p/${A}`);
    expect(envParent(A, "//evil.example/x")).toBe(`/p/${A}`);
    expect(envParent(A, "/nope/x")).toBe(`/p/${A}`);
  });
});

describe("Remove's confirm in part 2: the worktrees that stay and the variables (L25, L27, W12, D60)", () => {
  const WT = "/srv/data/kitespan/worktrees/aaaaaaaaaa/chatofax";
  const of = (id: string, projectId: string, over = {}) => ({ ...CHATS[0]!, id, projectId, archived: false, busy: false, serverState: "sleeping" as const, state: "sleeping" as const, needsYou: false, pending: [], turn: null, tasks: [], held: null, ...over });

  test("one line per worktree that stays: with changes, with ignored files, shared by a copy; a clean one goes with none", () => {
    expect(removeTreeLine(WT, { changes: 3, branchStays: false }, false, false)).toEqual({ line: `Its worktree at ${WT} has changes in 3 files, so it stays on disk.`, reading: false, touchesFolder: false });
    expect(removeTreeLine(WT, { changes: 1, branchStays: false }, false, false).line).toBe(`Its worktree at ${WT} has changes in 1 file, so it stays on disk.`);
    expect(removeTreeLine(WT, { changes: 0, ignored: true, branchStays: false }, false, false).line).toBe(`Its worktree at ${WT} has files that git ignores, so it stays on disk.`);
    expect(removeTreeLine(WT, { changes: 0, branchStays: false }, true, false)).toEqual({ line: `Its worktree at ${WT} stays on disk.`, reading: false, touchesFolder: false });
    expect(removeTreeLine(WT, { changes: 0, ignored: false, branchStays: true }, false, false)).toEqual({ line: null, reading: false, touchesFolder: false });
    // Not there (archive removed it), or no worktree of the chat's own (the read's 404): no line.
    expect(removeTreeLine(WT, { changes: null, branchStays: false }, true, false)).toEqual({ line: null, reading: false, touchesFolder: false });
    expect(removeTreeLine(WT, { changes: null, branchStays: false, removes: false }, false, false)).toEqual({ line: null, reading: false, touchesFolder: false });
  });

  test("row 100: a clean worktree inside the project's folder gets Delete's line, and Remove changes the folder", () => {
    const IN = "/srv/code/shop/.claude/worktrees/chatofax";
    expect(removeTreeLine(IN, { changes: 0, ignored: false, branchStays: false }, false, true)).toEqual({ line: `This also removes its worktree, ${IN}.`, reading: false, touchesFolder: true });
    expect(removeTreeLine(IN, { changes: 0, branchStays: true }, false, true).line).toBe(`This also removes its worktree, ${IN}.`);
    // One that stays changes nothing there; one whose changes are being read, or could not be read, may go.
    expect(removeTreeLine(IN, { changes: 2, branchStays: false }, false, true)).toEqual({ line: `Its worktree at ${IN} has changes in 2 files, so it stays on disk.`, reading: false, touchesFolder: false });
    expect(removeTreeLine(IN, { changes: 0, ignored: true, branchStays: false }, false, true).touchesFolder).toBe(false);
    expect(removeTreeLine(IN, { changes: 0, branchStays: false }, true, true)).toEqual({ line: `Its worktree at ${IN} stays on disk.`, reading: false, touchesFolder: false });
    expect(removeTreeLine(IN, { changes: null, branchStays: false }, false, true)).toEqual({ line: null, reading: false, touchesFolder: false });
    expect(removeTreeLine(IN, undefined, false, true)).toEqual({ line: `Its worktree at ${IN} stays on disk if it has changes.`, reading: true, touchesFolder: true });
    expect(removeTreeLine(IN, null, false, true)).toEqual({ line: `Its worktree at ${IN} stays on disk if it has changes, which could not be read.`, reading: false, touchesFolder: true });
    // One made before row 100, in kitespan's data folder: the folder is not changed, and a clean one has no line.
    expect(removeTreeLine(WT, { changes: 0, ignored: false, branchStays: false }, false, false)).toEqual({ line: null, reading: false, touchesFolder: false });
  });

  test("while the read runs the line makes no claim and Remove waits; a read that failed says so, and Remove is on", () => {
    expect(removeTreeLine(WT, undefined, false, false)).toEqual({ line: `Its worktree at ${WT} stays on disk if it has changes.`, reading: true, touchesFolder: false });
    expect(removeTreeLine(WT, null, false, false)).toEqual({ line: `Its worktree at ${WT} stays on disk if it has changes, which could not be read.`, reading: false, touchesFolder: false });
    // A shared one stays whatever the read says, so it never waits.
    expect(removeTreeLine(WT, undefined, true, false)).toEqual({ line: `Its worktree at ${WT} stays on disk.`, reading: false, touchesFolder: false });
  });

  test("the worktrees read: kitespan's own in the environment, archived chats' too, each path once; never a linked one", () => {
    const own = { path: WT, branch: "kitespan/chatofax", kept: false };
    const chats = [
      of(CHAT_A, A, { worktree: own }),
      of("copyofaxxxxxxxxxxxxx", A, { worktree: own }),
      of("archivedxxxxxxxxxxxx", A, { archived: true, worktree: { ...own, path: `${WT}-2`, kept: true } }),
      of("linkedxxxxxxxxxxxxxx", A, { worktree: { path: "/srv/src/mine", branch: "mine", kept: false, own: false as const } }),
      of("plainxxxxxxxxxxxxxxx", A),
      of(CHAT_B, B, { worktree: { ...own, path: "/elsewhere" } }),
    ];
    expect(removeTrees(chats, A)).toEqual([
      { chat: CHAT_A, path: WT, shared: true },
      { chat: "archivedxxxxxxxxxxxx", path: `${WT}-2`, shared: false },
    ]);
  });

  test("on the page: the first line as it is, the variables line (no value), each worktree's line with its path", () => {
    const mm = gm.matchMedia;
    gm.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    try {
      const project = { id: A, name: "shop", folder: "/srv/code/shop", branch: "", picks: {}, env: 2, worktree: true };
      const draw = (chats: ReturnType<typeof of>[], p: typeof project & { envUnreadable?: boolean } = project) => {
        resetState({ ready: true, projects: [p], chats });
        return renderToStaticMarkup(createElement(RemoveEnvBody, { project: p, onClose: () => {} }));
      };
      const html = draw([of(CHAT_A, A, { worktree: { path: WT, branch: "kitespan/chatofax", kept: false } }), of(CHAT_B, A)]);
      const text = html.replace(/<[^>]+>/g, "");
      expect(text).toContain(removeLine(2));
      expect(html).toContain(`data-testid="remove-vars-line">${REMOVE_VARS_LINE}</p>`);
      expect(REMOVE_VARS_LINE).toBe("Its environment variables are removed.");
      // The read of its changes runs as the confirm opens: no claim yet, a dim ..., and Remove waits for it.
      expect(text).toContain(`Its worktree at ${WT} stays on disk if it has changes. ...`);
      expect(html).toMatch(/<p class="wt-path-line" data-testid="remove-worktree-line" aria-busy="true">/);
      expect(html).toContain('<span class="wt-path-part">');
      expect(html).toMatch(/data-testid="confirm-remove" disabled=""/);
      // Row 100: a worktree inside the project's folder may go, so the first line does not say the folder is not changed.
      const IN = "/srv/code/shop/.claude/worktrees/chatofax";
      const inside = draw([of(CHAT_A, A, { worktree: { path: IN, branch: "kitespan/chatofax", kept: false } }), of(CHAT_B, A)]).replace(/<[^>]+>/g, "");
      expect(inside).toContain(removeLine(2, true));
      expect(inside).not.toContain("not changed");
      expect(inside).toContain(`Its worktree at ${IN} stays on disk if it has changes. ...`);
      // No variables and no worktree: the first line alone, and Remove is on.
      const plain = draw([of(CHAT_B, A)], { ...project, env: 0 });
      expect(plain).not.toContain("remove-vars-line");
      expect(plain).not.toContain("remove-worktree-line");
      expect(plain).not.toMatch(/data-testid="confirm-remove" disabled/);
      // A variables file that cannot be read goes too, so the line shows.
      expect(draw([], { ...project, env: 0, envUnreadable: true })).toContain("remove-vars-line");
      // While a chat there works, only the line that says so.
      const busy = draw([of(CHAT_A, A, { serverState: "running", state: "running", worktree: { path: WT, branch: "kitespan/chatofax", kept: false } })]);
      expect(busy).toContain(REMOVE_BUSY_LINE);
      expect(busy).not.toContain("remove-vars-line");
      expect(busy).not.toContain("remove-worktree-line");
      expect(busy).not.toContain("confirm-remove");
    } finally {
      gm.matchMedia = mm;
    }
  });
});

// ---- the store, with a fake socket, a fake fetch and the router's history

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
  close() {}
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

type Hist = { state: unknown; entries: string[]; pushState: (s: unknown, t: string, u: string) => void; replaceState: (s: unknown, t: string, u: string) => void; back: () => void; go: (n: number) => void };
const g = globalThis as unknown as { window?: { __kitespanFrames?: { t: string }[] }; history?: Hist; location?: { pathname: string; search: string; href: string; origin: string }; fetch: typeof fetch };
const own = { window: !g.window, history: !g.history, location: !g.location };
const realFetch = g.fetch;
function goTo(url: string) {
  const u = new URL(url, "http://127.0.0.1");
  g.location = { pathname: u.pathname, search: u.search, href: u.href, origin: u.origin };
}
/** The fake fetch's calls and its answers, by `METHOD path`. */
const calls: { method: string; path: string; body: unknown }[] = [];
let answers: Record<string, { status: number; body: unknown }> = {};
const view = (id: string, name: string) => ({ id, name, cwd: `/srv/${name}`, createdAt: "2026-11-01T00:00:00.000Z", lastUsedAt: "2026-11-01T00:00:00.000Z", picks: { model: null, effort: null, permissionMode: null } });

beforeAll(() => {
  g.window ??= {};
  g.history = {
    state: null,
    entries: [],
    pushState(s, _t, u) {
      this.state = s;
      this.entries.push(`push ${u}`);
      goTo(u);
    },
    replaceState(s, _t, u) {
      this.state = s;
      this.entries.push(`replace ${u}`);
      goTo(u);
    },
    back() {
      this.entries.push("back");
    },
    go(n) {
      this.entries.push(`go ${n}`);
    },
  };
  g.fetch = (async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input);
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const a = answers[`${method} ${path}`] ?? { status: 200, body: { projects: [view(A, "a"), view(B, "b"), view(C, "c")] } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(() => {
  connectWith(null);
  resetState();
  g.fetch = realFetch;
  if (own.window) delete g.window;
  if (own.history) delete g.history;
  if (own.location) delete g.location;
});
beforeEach(() => {
  calls.length = 0;
  answers = {};
});

let sock: FakeSocket;
const row = (chat: string, project: string, over: Partial<ChatRow> = {}): ChatRow => ({ chat, title: `Chat in ${project}`, project, state: "idle", needsYou: false, lastActivity: "2026-11-01T10:00:00.000Z", archived: false, ...over });
const projects = () => getState().projects.map((p) => p.id);

function boot(at: string) {
  resetState({ projects: [view(A, "a"), view(B, "b"), view(C, "c")].map((v) => ({ id: v.id, name: v.name, folder: v.cwd, branch: "", picks: {} })) });
  sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7947/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: "lz2k3m-abcdefghijkl", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.312", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: [row(CHAT_A, A), row(CHAT_B, B)] });
  g.history!.entries = [];
  (g.window!.__kitespanFrames ??= []).length = 0;
  goTo(at);
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the projects frame", () => {
  test("removed: a page on that environment goes to / with no line; it and its chats leave the lists at once", () => {
    boot(`/p/${A}`);
    sock.receive({ t: "projects", removed: A });
    expect(g.history!.entries).toEqual(["replace /"]);
    expect(projects()).toEqual([B, C]);
    expect(getState().chats.map((c) => c.id)).toEqual([CHAT_B]);
    expect(getState().notice).toBeNull();
    // A list frame that still holds its chat (sent before the chat's `gone`) leaves it out; then the `gone`.
    sock.receive({ t: "chats", delta: { chat: CHAT_A, title: "renamed meanwhile" } });
    expect(getState().chats.map((c) => c.id)).toEqual([CHAT_B]);
    sock.receive({ t: "chats", delta: { chat: CHAT_A, gone: true } });
    expect(getState().chats.map((c) => c.id)).toEqual([CHAT_B]);
    expect(calls).toEqual([]);
  });

  test("a page on one of its chats goes to / too; a page elsewhere stays", () => {
    boot(`/c/${CHAT_A}/details`);
    sock.receive({ t: "projects", removed: A });
    expect(g.history!.entries).toEqual(["replace /"]);
    boot(`/p/${B}`);
    sock.receive({ t: "projects", removed: A });
    expect(g.history!.entries).toEqual([]);
  });

  test("the plain frame reads the list again (a rename or a move on another page), and ends a removal", async () => {
    boot(`/p/${B}`);
    sock.receive({ t: "projects", removed: A });
    answers["GET /api/projects"] = { status: 200, body: { projects: [view(C, "c"), view(B, "b renamed")] } };
    sock.receive({ t: "projects" });
    await settle();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/projects"]);
    expect(projects()).toEqual([C, B]);
    expect(getState().projects.find((p) => p.id === B)!.name).toBe("b renamed");
  });

  test("a removal that did not happen: the list read at its end brings the environment and its chat back", async () => {
    boot("/");
    sock.receive({ t: "projects", removed: A });
    expect(getState().chats.map((c) => c.id)).toEqual([CHAT_B]);
    sock.receive({ t: "projects" });
    await settle();
    expect(projects()).toEqual([A, B, C]);
    expect(getState().chats.map((c) => c.id).sort()).toEqual([CHAT_A, CHAT_B]);
  });

  test("a reconnect reads the list again, since a change may have come while the socket was down", async () => {
    boot("/");
    sock.receive({ t: "welcome", epoch: "lz2k3m-abcdefghijkl", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.312", drift: null }, update: { available: false }, auth: "none" });
    await settle();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/projects"]);
  });
});

describe("the actions, each one request", () => {
  test("Move: the page's order at once, one POST with the place, then the server's order", async () => {
    boot("/");
    answers[`POST /api/projects/${C}/move`] = { status: 200, body: { projects: [view(C, "c"), view(A, "a"), view(B, "b")] } };
    act.moveProject(C, A);
    expect(projects()).toEqual([C, A, B]);
    await settle();
    expect(calls).toEqual([{ method: "POST", path: `/api/projects/${C}/move`, body: { before: A } }]);
    expect(g.window!.__kitespanFrames!.map((f) => f.t)).toEqual([`POST /api/projects/:project/move`]);
    expect(projects()).toEqual([C, A, B]);
    expect(sock.sent.filter((f) => !["hello", "ping", "attach", "detach", "get"].includes(f.t))).toEqual([]);
  });

  test("Rename: one POST with the name; the new name in the lists on the server's ok", async () => {
    boot(`/p/${A}/rename`);
    answers[`POST /api/projects/${A}/rename`] = { status: 200, body: { project: view(A, "Web app") } };
    expect(await act.renameProject(A, "Web app")).toBe(true);
    expect(calls).toEqual([{ method: "POST", path: `/api/projects/${A}/rename`, body: { name: "Web app" } }]);
    expect(getState().projects.find((p) => p.id === A)!.name).toBe("Web app");
  });

  test("Remove refused while a chat there works: false, with the server's line", async () => {
    boot(`/p/${A}/remove`);
    answers[`POST /api/projects/${A}/remove`] = { status: 409, body: { error: { code: "busy", message: REMOVE_BUSY } } };
    expect(await act.removeProject(A)).toBe(false);
    expect(getState().notice).toBe(REMOVE_BUSY_LINE);
    expect(projects()).toEqual([A, B, C]);
  });

  test("an environment added on this page is first in the lists", async () => {
    boot("/");
    answers["POST /api/projects"] = { status: 201, body: { project: view("dddddddddd", "d") } };
    expect(await act.addFolder("/srv/d")).toEqual({ id: "dddddddddd" });
    expect(projects()).toEqual(["dddddddddd", A, B, C]);
  });
});

// ---- what the lists and the project page draw

const gm = globalThis as unknown as { matchMedia?: unknown; innerWidth?: number };
describe("the heading and the page", () => {
  test("each heading has the environment's menu button and is a drag handle (data-env), with no drop line at rest", () => {
    const mm = gm.matchMedia;
    gm.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    try {
      resetState({ projects: structuredClone(PROJECTS), chats: structuredClone(CHATS), ready: true });
      const html = renderToStaticMarkup(createElement(ChatListBody, { route: parse(new URL("/chats", "http://127.0.0.1")), variant: "sidebar" }));
      for (const p of PROJECTS) {
        expect(html).toContain(`data-env="${p.id}"`);
        expect(html).toContain(`aria-label="Menu for ${p.name}"`);
      }
      expect(html.match(/data-testid="env-more"/g)!.length).toBe(PROJECTS.length);
      expect(html).not.toContain("data-drop");
    } finally {
      gm.matchMedia = mm;
    }
  });

  test("Rename's field holds the name, or a link's ?name= (shown, not saved), with Cancel and Save", () => {
    const project = { id: A, name: "notes-api", folder: "/srv/notes", branch: "", picks: {} };
    const at = (path: string) => renderToStaticMarkup(createElement(EnvRenameForm, { project, route: parse(new URL(path, "http://127.0.0.1")) }));
    const plain = at(`/p/${A}/rename`);
    expect(plain).toContain('value="notes-api"');
    expect(plain).toContain('maxLength="80"');
    expect(plain).toContain('data-testid="confirm-save-name"');
    expect(plain).toContain(">Cancel<");
    expect(at(`/p/${A}/rename?name=Web%20app`)).toContain('value="Web app"');
  });

  test("the project page puts the field in the title's place and Remove's confirm over the page, by the path", () => {
    const src = readFileSync(join(WEB, "screens", "ProjectScreen.tsx"), "utf8");
    expect(src).toContain('route.name === "projectRename" ? <EnvRenameForm');
    expect(src).toContain('route.name === "projectRemove" ? <RemoveEnvDialog');
    expect(src).toContain("<EnvMenu open={menu} onClose={() => setMenu(false)} anchor={more} project={project} steps={null} />");
    const app = readFileSync(join(WEB, "App.tsx"), "utf8");
    expect(app).toMatch(/case "project":\s*case "projectRename":\s*case "projectRemove":\s*return <ProjectScreen route=\{route\} \/>;/);
  });

  test("the pointer drag is the mouse's (a finger lifts by a long press, env-touch-drag.test.ts; a pen never drags), and Esc puts the heading back (env-longpress.test.ts)", () => {
    const src = readFileSync(join(WEB, "screens", "EnvironmentMenu.tsx"), "utf8");
    expect(src).toContain('if (e.pointerType !== "mouse" || e.button !== 0');
    expect(src).toContain('if (ev.key !== "Escape" || !mouse.escape()) return;');
    // A menu that only lists items has no URL (5.1 rule 1): Rename and Remove open their own paths.
    expect(src).toContain('href("projectRename", { project: project.id })');
    expect(src).toContain('href("projectRemove", { project: project.id })');
  });

  test("an entry pushed from a chat closes Rename back to the chat", () => {
    g.history!.state = pushedState(null, `/c/${CHAT_A}`);
    expect(envParent(A)).toBe(`/c/${CHAT_A}`);
    g.history!.state = null;
  });
});
