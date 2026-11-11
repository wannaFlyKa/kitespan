// The page's part of FIX-W25b (part 2's last items): a Start refused because kitespan could not make the chat's
// worktree names the off reason's line (item 1); Archive keeps a worktree that holds only files git ignores, with its
// own line, and the archived chat's line names the path only (item 2); an unreadable variables file says "Could not be
// read" on the project page and in New environment, linked to the editor (item 3); the env_unreadable line is matched
// by its code, never by its text (item 4); New environment's rows and Delete's worktree path on a phone (item 7); and
// the chat row's session read without a cast (item 8). Rendered with React's server renderer; a fake socket for the
// frames.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ERROR_MESSAGES, PROTOCOL_VERSION, WORKTREE_OFF as SHARED_OFF, type ChatEvent, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import type { ProjectView } from "../../server/http/api-types";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, projectOf, resetState } from "../../web/state/store";
import { applyEvent } from "../../web/state/reduce";
import type { Chat, InfoItem, Item, Project } from "../../web/state/types";
import { InfoLine } from "../../web/chat/items/Notes";
import { TranscriptProvider } from "../../web/chat/items/context";
import { isUnreadableLine } from "../../web/env/UnreadableLine";
import { ENV_WORDS, envCell } from "../../web/env/vars";
import { ProjectEnvironmentRows } from "../../web/screens/ProjectScreen";
import { NewChat } from "../../web/screens/Home";
import { Finder } from "../../web/dialogs/NewEnvironment";
import { DeleteBody } from "../../web/dialogs/ChatDialogs";
import { Composer } from "../../web/composer/Composer";
import { PathText } from "../../web/worktree/PathText";
import { WORKTREE_OFF, WORKTREE_OFF_LINE, archiveKeepsLine, keptLine, refusalLine } from "../../web/worktree/worktree";
import { readWorktreeStatus } from "../../web/worktree/api";
import { parse } from "../../web/router";
import { scripted } from "./fixtures";

const WEB = join(import.meta.dir, "..", "..", "web");
const code = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const css = (name: string) => readFileSync(join(WEB, "styles", name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The text a reader sees: a path's parts (PathText) read as the one path they are. */
const text = (html: string) =>
  html
    .replace(/<span class="wt-path-part">([^<]*)<\/span>/g, "$1")
    .replace(/<wbr\/?>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);

const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ROOT = "/work/kitespan";
const WT = "/srv/u/.local/share/kitespan/worktrees/k3m7q2x4ab/wtchataa";
const P: Project = { id: "k3m7q2x4ab", name: "kitespan", folder: ROOT, branch: "", picks: {}, env: 0, worktree: true, worktreeOff: null };
const CHAT = "wtchataaaaaaaaaaaaaa";
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
  /** A frame as the server writes it (JSON), so a field the page's types do not name yet still arrives. */
  receive(f: ServerFrame | Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

function connect(): FakeSocket {
  const socket = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7943/ws", tab: "tab_me", open: () => socket, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  socket.onopen?.({});
  socket.receive({ t: "welcome", epoch: "e1", version: "0.4.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none", host: "devbox" });
  return socket;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const framesOf = <T extends ClientFrame["t"]>(s: FakeSocket, t: T) => s.sent.filter((f): f is Extract<ClientFrame, { t: T }> => f.t === t);

const g = globalThis as unknown as { matchMedia?: unknown; window?: unknown; history?: unknown };
const was = { mm: g.matchMedia, win: g.window, hist: g.history, hadMm: "matchMedia" in g, hadWin: "window" in g, hadHist: "history" in g };
beforeAll(() => {
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.window = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  g.history = { state: null, pushState() {}, replaceState() {} };
});
afterAll(() => {
  if (was.hadMm) g.matchMedia = was.mm;
  else delete g.matchMedia;
  if (was.hadWin) g.window = was.win;
  else delete g.window;
  if (was.hadHist) g.history = was.hist;
  else delete g.history;
  connectWith(null);
  resetState();
});
beforeEach(() => {
  connectWith(null);
  resetState({ ready: true, projects: [P], chats: [chatWith()] });
});

// ---------------------------------------------------------------------------------------------------------------

describe("item 1: a refused Start names the worktree's off reason (F5)", () => {
  const start = async (error: Record<string, unknown>) => {
    const socket = connect();
    resetState({ ready: true, projects: [P], chats: [], projectsRead: true });
    void act.newChat({ projectId: P.id, text: "go", sessionId: "6f0c2a8e-1b3d-4c5e-8f70-123456789abc" });
    const f = framesOf(socket, "new_chat")[0]!;
    socket.receive({ t: "ack", rid: f.rid, ok: false, error });
    await tick();
    return getState().notice;
  };

  test("worktree_failed with a known reason: the form's line is that reason's line (a WorktreeCreate hook, for one)", async () => {
    expect(await start({ code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed, reason: "hook" })).toBe(WORKTREE_OFF_LINE.hook);
    const html = renderToStaticMarkup(createElement(NewChat, { route: parse(new URL(`http://x/new?project=${P.id}`)) }));
    expect(html).toContain('data-testid="screen-notice"');
    expect(text(html)).toContain(WORKTREE_OFF_LINE.hook);
    expect(text(html)).not.toContain(ERROR_MESSAGES.worktree_failed);
    // Every reason of the shared list has its line, not_top among them.
    for (const why of WORKTREE_OFF) expect(await start({ code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed, reason: why })).toBe(WORKTREE_OFF_LINE[why]);
  });

  test("no reason, or one the page does not know: the code's message", async () => {
    expect(await start({ code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed })).toBe(ERROR_MESSAGES.worktree_failed);
    expect(await start({ code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed, reason: "bogus" })).toBe(ERROR_MESSAGES.worktree_failed);
    expect(await start({ code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed, reason: 7 })).toBe(ERROR_MESSAGES.worktree_failed);
    expect(refusalLine({ code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed, reason: "not_top" })).toBe(WORKTREE_OFF_LINE.not_top);
    expect(refusalLine({ code: "queue_full", message: ERROR_MESSAGES.queue_full })).toBe(ERROR_MESSAGES.queue_full);
  });

  test("the page's list of off reasons is the shared one (shared/protocol.ts), so a reason the server sends has its line", () => {
    expect(WORKTREE_OFF).toBe(SHARED_OFF);
    expect(Object.keys(WORKTREE_OFF_LINE).sort()).toEqual([...SHARED_OFF].sort());
    // The reason counts only on worktree_failed (ackReason): another code with one reads as its own message.
    expect(refusalLine({ code: "failed", message: ERROR_MESSAGES.failed, reason: "hook" })).toBe(ERROR_MESSAGES.failed);
  });
});

describe("item 2: Archive with only ignored files (L25)", () => {
  test("changes keep today's line; no changes but ignored files: their own line; else none", () => {
    expect(archiveKeepsLine({ changes: 2, ignored: true, branchStays: false })).toBe("Its worktree has changes in 2 files, so it stays on disk.");
    expect(archiveKeepsLine({ changes: 1, ignored: false, branchStays: false })).toBe("Its worktree has changes in 1 file, so it stays on disk.");
    expect(archiveKeepsLine({ changes: 0, ignored: true, branchStays: false })).toBe("Its worktree has files that git ignores, so it stays on disk.");
    expect(archiveKeepsLine({ changes: 0, ignored: false, branchStays: false })).toBeNull();
    expect(archiveKeepsLine({ changes: 0, branchStays: false })).toBeNull();
    expect(archiveKeepsLine({ changes: null, ignored: true, branchStays: false })).toBeNull();
    expect(archiveKeepsLine(null)).toBeNull();
  });

  test("the archived chat's line names the path only: the worktree may hold ignored files, not changes", () => {
    expect(keptLine(WT)).toBe(`Its worktree stays at ${WT}.`);
    const kept = chatWith({ archived: true, worktree: { ...WORKTREE, kept: true } });
    resetState({ ready: true, projects: [P], chats: [kept] });
    const html = renderToStaticMarkup(createElement(Composer, { chat: kept, route: parse(new URL(`http://x/c/${CHAT}`)) }));
    expect(text(html)).toBe(`Its worktree stays at ${WT}. Unarchive`);
  });

  test("the read keeps the server's ignored, true only when it says true", async () => {
    const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    expect(await readWorktreeStatus(CHAT, answer({ changes: 0, ignored: true, branchStays: false }))).toEqual({ changes: 0, ignored: true, branchStays: false });
    expect(await readWorktreeStatus(CHAT, answer({ changes: 0, ignored: null, branchStays: false }))).toEqual({ changes: 0, ignored: false, branchStays: false });
    expect(await readWorktreeStatus(CHAT, answer({ changes: 0, ignored: "yes", branchStays: false }))).toEqual({ changes: 0, ignored: false, branchStays: false });
  });
});

describe("item 3: an unreadable variables file on the project page and in New environment (L39)", () => {
  const BAD: Project = { ...P, envUnreadable: true };

  test("the project view's envUnreadable, true only when the server says true", () => {
    const base = { id: P.id, name: "kitespan", cwd: ROOT, createdAt: "", lastUsedAt: "", picks: { model: null, effort: null, permissionMode: null }, worktree: false, worktreeOff: null } as ProjectView;
    expect(projectOf({ ...base, envUnreadable: true }).envUnreadable).toBe(true);
    expect(projectOf(base).envUnreadable ?? false).toBe(false);
    expect(projectOf({ ...base, envUnreadable: "yes" } as unknown as ProjectView).envUnreadable ?? false).toBe(false);
  });

  test("the project page: the Environment variables cell says Could not be read, and opens the editor", () => {
    const html = renderToStaticMarkup(createElement(ProjectEnvironmentRows, { project: BAD }));
    expect(text(html)).toBe(`Environment Worktree On ${ENV_WORDS.title} Could not be read`);
    expect(ENV_WORDS.unreadableCell).toBe("Could not be read");
    expect(html.match(/href="\/p\/k3m7q2x4ab\/environment"/g)).toHaveLength(2);
    expect(envCell(BAD)).toBe("Could not be read");
    expect(envCell({ env: 2 })).toBe("2 variables");
    expect(envCell({})).toBe(ENV_WORDS.none);
  });

  test("the editor's read and save carry the flag, so the cell says Could not be read only while the file is unreadable", () => {
    resetState({ ready: true, projects: [BAD], chats: [] });
    act.tookEnvCount(P.id, 0, false); // a save that removed the unreadable file
    expect(getState().projects[0]!.envUnreadable).toBe(false);
    expect(text(renderToStaticMarkup(createElement(ProjectEnvironmentRows, { project: getState().projects[0]! })))).toContain(`${ENV_WORDS.title} ${ENV_WORDS.none}`);
    act.tookEnvCount(P.id, 0, true); // a read that found it unreadable again
    expect(envCell(getState().projects[0]!)).toBe(ENV_WORDS.unreadableCell);
    const src = code("env", "EnvSection.tsx");
    expect(src).toContain("act.tookEnvCount(project.id, reply.vars.length, reply.unreadable)");
    expect(src).toContain("act.tookEnvCount(project.id, answer.reply.vars.length, answer.reply.unreadable)");
  });

  test("New environment's row for a folder whose project has an unreadable file: Could not be read, linked to its editor", () => {
    const HOME = "/srv/u";
    const LISTING = { ok: true as const, path: HOME, parent: "/srv", home: HOME, folders: [], truncated: false };
    resetState({ ready: true, projects: [{ id: "h0h0h0h0h0", name: "u", folder: HOME, branch: "", picks: {}, env: 0, worktree: false, envUnreadable: true }] });
    const html = renderToStaticMarkup(createElement(Finder, { onAdded: () => {}, onClose: () => {}, start: { listing: LISTING, suggested: [] } }));
    expect(text(html)).toContain(`Worktree Off ${ENV_WORDS.title} Could not be read`);
    expect(html.match(/href="\/p\/h0h0h0h0h0\/environment"/g)).toHaveLength(2);
  });
});

describe("item 4: the env_unreadable line by its code, never by its text", () => {
  const reduce = (chat: Chat, e: ChatEvent) => applyEvent(chat, e, { seq: 5, replay: false, cwd: ROOT, now: 0 });
  const draw = (item: InfoItem) =>
    renderToStaticMarkup(createElement(TranscriptProvider, { value: { chatId: CHAT, view: "normal", readOnly: false, isOpen: () => false, toggle: () => {} } }, createElement(InfoLine, { item })));

  test("the notice keeps its code env_unreadable, and the line draws its link by that code", () => {
    const chat = reduce(chatWith({ worktree: null }), { k: "notice", text: ERROR_MESSAGES.env_unreadable, code: "env_unreadable" });
    const line = chat.items.at(-1) as InfoItem;
    expect(line).toMatchObject({ kind: "info", text: ERROR_MESSAGES.env_unreadable, code: "env_unreadable" });
    expect(line.start).toBeUndefined();
    const html = draw(line);
    expect(ids(html)).toContain("env-unreadable-line");
    expect(html).toContain(`href="/p/${P.id}/environment"`);
  });

  test("other words with the code still link; the same words with no code are a plain line", () => {
    const worded = { kind: "info" as const, id: "n1", text: "The variables of this environment could not be read.", level: "notice" as const, code: "env_unreadable" as const };
    expect(isUnreadableLine(worded)).toBe(true);
    expect(ids(draw(worded))).toContain("env-unreadable-line");
    expect(text(draw(worded))).toBe(`${worded.text} ${ENV_WORDS.title}`);
    const plain = { kind: "info" as const, id: "n2", text: ERROR_MESSAGES.env_unreadable, level: "notice" as const };
    expect(isUnreadableLine(plain)).toBe(false);
    expect(ids(draw(plain))).not.toContain("env-unreadable-line");
    // A notice with no code, or with another one, keeps none.
    const other = reduce(chatWith({ worktree: null }), { k: "notice", text: "This chat waits for a free slot.", code: "queue_full" });
    expect((other.items.at(-1) as InfoItem).code).toBeUndefined();
  });

  test("the sources compare the code: no comparison of a line's text with the sentence", () => {
    expect(code("env", "UnreadableLine.tsx")).not.toMatch(/===\s*ERROR_MESSAGES\.env_unreadable/);
    expect(code("chat", "items", "Notes.tsx")).toContain("isUnreadableLine(item)");
  });
});

describe("item 7: the phone's layout (390x844)", () => {
  test("Delete's confirm breaks a worktree's path only after a /: each part whole, a <wbr> after each /", () => {
    const html = renderToStaticMarkup(createElement(DeleteBody, { chat: getState().chats[0]!, onClose: () => {} }));
    const line = html.match(/<p class="wt-path-line" data-testid="worktree-delete-line"[^>]*>([^]*?)<\/p>/)?.[1] ?? "";
    expect(text(line)).toBe(`This also removes its worktree, ${WT}. ...`);
    const parts = [...line.matchAll(/<span class="wt-path-part">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(parts).toEqual(["/srv/", "u/", ".local/", "share/", "kitespan/", "worktrees/", "k3m7q2x4ab/", "wtchataa"]);
    expect(line.match(/<wbr\/?>/g)).toHaveLength(parts.length - 1);
    // A part is one box that never breaks inside (at a hyphen or a space) unless it alone is wider than the line.
    const rule = css("environment.css").match(/\.wt-path-part\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/display:\s*inline-block/);
    expect(rule).toMatch(/max-width:\s*100%/);
  });

  test("a path's parts: hyphens and spaces stay inside their part, and the leading / is never a part of its own", () => {
    const parts = (path: string) => [...renderToStaticMarkup(createElement(PathText, { path })).matchAll(/<span class="wt-path-part">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(parts("/tmp/it4-page-lane/run before/x")).toEqual(["/tmp/", "it4-page-lane/", "run before/", "x"]);
    expect(parts("~/code/shop")).toEqual(["~/", "code/", "shop"]);
    expect(parts("/")).toEqual(["/"]);
    // The archived chat's line takes its path the same way.
    const kept = chatWith({ archived: true, worktree: { ...WORKTREE, kept: true } });
    resetState({ ready: true, projects: [P], chats: [kept] });
    const html = renderToStaticMarkup(createElement(Composer, { chat: kept, route: parse(new URL(`http://x/c/${CHAT}`)) }));
    expect(html).toContain('<span class="wt-path-part">wtchataa</span>');
  });

  test("New environment's rows and the project page's on touch: the value under its label, whole (never cut)", () => {
    // Each rule is read by its selector list, which names both rows.
    const sheet = css("environment.css");
    const rule = (a: string, b: string) => {
      const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return sheet.match(new RegExp(`${esc(a)},\\s*${esc(b)}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    };
    expect(rule(".touch .group-row.scr-env-opt", ".touch .group-row.scr-penv-row")).toMatch(/display:\s*grid/);
    expect(rule(".touch .scr-env-opt > .group-label", ".touch .scr-penv-row > .group-label")).toMatch(/grid-(area|row):\s*1\b/);
    const value = rule(".touch .scr-env-opt > .group-value", ".touch .scr-penv-row > .group-value");
    expect(value).toMatch(/grid-(area|row):\s*2\b/);
    expect(value).toMatch(/max-width:\s*none/);
    expect(value).toMatch(/white-space:\s*normal/);
    expect(rule(".touch .scr-env-opt > .group-chevron", ".touch .scr-penv-row > .group-chevron")).toMatch(/align-self:\s*center/);
    // The rows carry those classes: the project page's two links, New environment's links and its variables' button.
    resetState({ ready: true, projects: [P], chats: [] });
    expect(renderToStaticMarkup(createElement(ProjectEnvironmentRows, { project: P })).match(/class="group-row scr-penv-row"/g)).toHaveLength(2);
    const LISTING = { ok: true as const, path: "/srv/u", parent: "/srv", home: "/srv/u", folders: [], truncated: false };
    const fresh = renderToStaticMarkup(createElement(Finder, { onAdded: () => {}, onClose: () => {}, start: { listing: LISTING, suggested: [] } }));
    expect(fresh).toMatch(/class="group-row scr-env-opt"[^>]*data-testid="new-env-vars"/);
  });
});

describe("item 8: the row's session id without a cast", () => {
  test("sessionOfRow reads row.session as the protocol types it, and keeps its UUID check", async () => {
    const src = code("state", "store.ts");
    const fn = src.match(/function sessionOfRow\(row: ChatRow\): string \| null \{([^}]*)\}/)?.[1] ?? "";
    expect(fn).toContain("row.session");
    expect(fn).not.toMatch(/\bas\b/);
    expect(fn).toContain("isUuid(");
    const socket = connect();
    const row = { chat: CHAT, title: "t", project: P.id, state: "sleeping" as const, needsYou: false, lastActivity: "2026-11-03T08:00:00.000Z", archived: false, session: SID };
    resetState({ ready: true, projects: [P], chats: [] });
    socket.receive({ t: "chats", list: [row] });
    expect(getState().chats[0]!.sessionId).toBe(SID);
    socket.receive({ t: "chats", list: [{ ...row, session: "not a session" }] });
    expect(getState().chats[0]!.sessionId).toBe(SID);
    resetState({ ready: true, projects: [P], chats: [] });
    socket.receive({ t: "chats", list: [{ ...row, session: null }] });
    expect(getState().chats[0]!.sessionId).toBe("");
  });
});
