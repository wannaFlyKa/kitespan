// Row 73 on the page (build checklist W2's page part, W4 to W7 and W9's lines, W6; DESIGN 9.4 "Worktrees"): Desktop's
// Worktree switch, off with one line where a worktree cannot be made; a worktree chat's folder, "Worktree of <project
// folder>" and its branch in the Environment detail; the archive line and the delete confirm of a worktree chat; a
// refused start's line with its buttons (W4: Make it again from its branch, Continue in the project folder; W5: Try
// again; Continue in a copy and Continue without the worktree), which never starts anything by itself. Rendered with
// React's server renderer; a fake socket for the frames.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ERROR_MESSAGES, PROTOCOL_VERSION, type ChatEvent, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import type { ProjectView } from "../../server/http/api-types";
import { act, connectWith, getState, resetState } from "../../web/state/store";
import { applyEvent, settledStarts, shownWorkingFolder, workingFolderOf } from "../../web/state/reduce";
import type { Chat, InfoItem, Item, Project } from "../../web/state/types";
import { Detail } from "../../web/panels/details";
import { Cards } from "../../web/panels/cards";
import { TerminalBody } from "../../web/dialogs/ChatDialogs";
import { Composer } from "../../web/composer/Composer";
import { ItemView } from "../../web/chat/items/ItemView";
import { TranscriptProvider } from "../../web/chat/items/context";
import { WorktreeOption } from "../../web/worktree/WorktreeOption";
import { Finder } from "../../web/dialogs/NewEnvironment";
import { EnvironmentScreen } from "../../web/screens/EnvironmentScreen";
import { SessionRows } from "../../web/screens/Home";
import { ProjectEnvironmentRows } from "../../web/screens/ProjectScreen";
import { ENV_WORDS } from "../../web/env/vars";
import {
  WORKTREE_OFF_LINE,
  WORKTREE_WORDS,
  archiveKeepsLine,
  branchStaysLine,
  chatFolder,
  deleteWorktreeLine,
  keptLine,
  startActions,
  startLine,
  worktreeOf,
  worktreeOfRow,
} from "../../web/worktree/worktree";
import { readWorktreeCan, readWorktreeStatus } from "../../web/worktree/api";
import { WORKTREE_OFF_LINES } from "../../server/worktree/ops";
import { parse } from "../../web/router";
import { scripted } from "./fixtures";

const WEB = join(import.meta.dir, "..", "..", "web");
const code = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
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

const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ROOT = "/work/kitespan";
const WT = "/srv/u/.local/share/kitespan/worktrees/k3m7q2x4ab/wtchataa";
const P: Project = { id: "k3m7q2x4ab", name: "kitespan", folder: ROOT, branch: "", picks: {}, env: 3, worktree: true };
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
  receive(f: ServerFrame) {
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

const g = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const was = { mm: g.matchMedia, win: g.window, hadMm: "matchMedia" in g, hadWin: "window" in g };
beforeAll(() => {
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.window = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
});
afterAll(() => {
  if (was.hadMm) g.matchMedia = was.mm;
  else delete g.matchMedia;
  if (was.hadWin) g.window = was.win;
  else delete g.window;
  connectWith(null);
  resetState();
});
beforeEach(() => resetState({ ready: true, projects: [P], chats: [chatWith()] }));

describe("the Worktree option (W2)", () => {
  test("Desktop's word and a switch, off by default; where a worktree cannot be made, off and disabled with its one line", () => {
    const on = renderToStaticMarkup(createElement(WorktreeOption, { on: true, off: null, onChange: () => {} }));
    expect(text(on)).toBe("Worktree");
    expect(on).toMatch(/role="switch"[^>]*checked=""/);
    expect(on).not.toContain("<p");
    for (const off of ["not_git", "not_top", "no_commit", "hook", "config", "link", "nested"] as const) {
      const html = renderToStaticMarkup(createElement(WorktreeOption, { on: false, off, onChange: () => {} }));
      expect(text(html)).toBe(`Worktree ${WORKTREE_OFF_LINE[off]}`);
      expect(html).toMatch(/role="switch"(?![^>]*checked)[^>]*disabled=""/);
      expect(html.match(/<p\b/g)).toHaveLength(1);
      // An option that is on when the reason comes later stays on, and can be turned off, with the same line.
      const stuck = renderToStaticMarkup(createElement(WorktreeOption, { on: true, off, onChange: () => {} }));
      expect(text(stuck)).toBe(`Worktree ${WORKTREE_OFF_LINE[off]}`);
      expect(stuck).toMatch(/role="switch"[^>]*checked=""/);
      expect(stuck).not.toMatch(/role="switch"[^>]*disabled/);
    }
    expect(WORKTREE_OFF_LINE).toEqual({
      not_git: "This folder is not a git repository.",
      not_top: "kitespan makes worktrees only from the top folder of a repository's main checkout.",
      no_commit: "This repository has no commit yet.",
      hook: "Your Claude Code settings have a WorktreeCreate hook, which kitespan's worktrees would not run.",
      config: "This repository's git config could run a program, so kitespan makes no worktree here.",
      link: "This repository's .claude or .claude/worktrees is a symbolic link or not a folder, so kitespan makes no worktree here.",
      nested: "This repository's .claude or .claude/worktrees is another git repository, so kitespan makes no worktree here.",
    });
  });

  test("the page's off lines are the server's (the read's `line`, and each project view's reason)", () => {
    expect(WORKTREE_OFF_LINE).toEqual(WORKTREE_OFF_LINES);
  });

  test("New environment's read for a folder is a GET, and an answer it cannot read is no answer", async () => {
    const urls: string[] = [];
    const answer = (body: unknown, status = 200) => (async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    expect(await readWorktreeCan("/work/site", answer({ ok: true }))).toEqual({ ok: true });
    expect(await readWorktreeCan("/work/site", answer({ ok: false, why: "no_commit" }))).toEqual({ ok: false, why: "no_commit" });
    expect(await readWorktreeCan("/work/site", answer({ ok: false, why: "bogus" }))).toBeNull();
    expect(await readWorktreeCan("/work/site", answer({ error: { code: "not_found", message: "x" } }, 404))).toBeNull();
    expect(urls[0]).toBe("GET /api/folders/worktree?path=%2Fwork%2Fsite");
  });

  test("the project page: one Environment group whose two rows open the editor", () => {
    const html = renderToStaticMarkup(createElement(ProjectEnvironmentRows, { project: P }));
    expect(text(html)).toBe(`Environment Worktree On ${ENV_WORDS.title} 3 variables`);
    expect(html.match(/href="\/p\/k3m7q2x4ab\/environment"/g)).toHaveLength(2);
    const none = renderToStaticMarkup(createElement(ProjectEnvironmentRows, { project: { ...P, env: 0, worktree: false } }));
    expect(text(none)).toBe(`Environment Worktree Off ${ENV_WORDS.title} None for this environment`);
  });

  test("the project view's new fields: the count of variables, the switch and why it is off, read with care", async () => {
    const socket = connect();
    void socket;
    const { projectOf } = await import("../../web/state/store");
    // A server without the fields gives a project with none of them.
    const base = { id: P.id, name: "kitespan", cwd: ROOT, createdAt: "", lastUsedAt: "", picks: { model: null, effort: null, permissionMode: null } } as unknown as ProjectView;
    expect(projectOf(base)).toMatchObject({ env: 0, worktree: false, worktreeOff: null });
    expect(projectOf({ ...base, env: 3, worktree: true, worktreeOff: "hook" })).toMatchObject({ env: 3, worktree: true, worktreeOff: "hook" });
    expect(projectOf({ ...base, env: -1, worktree: "yes", worktreeOff: "nope" } as unknown as ProjectView)).toMatchObject({ env: 0, worktree: false, worktreeOff: null });
    connectWith(null);
  });
});

describe("a worktree chat's folder (W6, L34)", () => {
  test("the chat list's worktree becomes the chat's, and a row without one is a chat in its project's folder", () => {
    const socket = connect();
    socket.receive({ t: "chats", list: [{ chat: CHAT, title: "Try the worktree", project: P.id, state: "sleeping", needsYou: false, lastActivity: "2026-11-03T08:00:00.000Z", archived: false, worktree: WORKTREE }] });
    expect(getState().chats[0]!.worktree).toEqual(WORKTREE);
    socket.receive({ t: "chats", delta: { chat: CHAT, worktree: null } });
    expect(getState().chats[0]!.worktree ?? null).toBeNull();
    expect(worktreeOfRow({ worktree: { path: "relative", branch: "b", kept: false } })).toBeNull();
    expect(worktreeOfRow({ worktree: { path: WT, branch: "", kept: true } })).toEqual({ path: WT, branch: null, kept: true });
    expect(chatFolder(WORKTREE, ROOT)).toBe(WT);
    expect(chatFolder(null, ROOT)).toBe(ROOT);
    connectWith(null);
  });

  test("the Environment detail: the worktree as Folder, Worktree of the project folder, its branch, and the variables' count", () => {
    resetState({ ready: true, projects: [P], chats: [chatWith()], machine: "devbox" });
    const route = parse(new URL(`http://x/c/${CHAT}/environment`));
    const html = renderToStaticMarkup(createElement(Detail, { name: "environment", chat: getState().chats[0]!, route }));
    const t = text(html);
    expect(t).toMatch(/^Host devbox Folder /);
    expect(html).toContain('data-testid="worktree-of"');
    expect(t).toContain(worktreeOf(ROOT));
    expect(worktreeOf(ROOT)).toBe("Worktree of /work/kitespan");
    expect(t).toContain(`Branch ${WORKTREE.branch}`);
    expect(t).toContain(`${ENV_WORDS.title} 3`);
    expect(html).toContain('href="/p/k3m7q2x4ab/environment"');
    // The folder fact is the worktree's path, every part of it.
    for (const part of WT.split("/").filter(Boolean)) expect(t).toContain(part);
  });

  test("a plain chat: the project's folder and branch, no worktree line; no variables, no fact; a moved session's folder", () => {
    const plain: Project = { ...P, env: 0, branch: "main" };
    resetState({ ready: true, projects: [plain], chats: [chatWith({ worktree: null, workingFolder: "/work/kitespan/.claude/worktrees/probe" })] });
    const route = parse(new URL(`http://x/c/${CHAT}/environment`));
    const html = renderToStaticMarkup(createElement(Detail, { name: "environment", chat: getState().chats[0]!, route }));
    const t = text(html);
    expect(html).not.toContain("worktree-of");
    expect(t).toContain("Branch main");
    expect(t).not.toContain(ENV_WORDS.title);
    expect(t).toContain(`${WORKTREE_WORDS.workingFolder}`);
    expect(t).toContain("probe");
  });

  test("system/init's folder shows only when it is not the chat's own, also when the page learns the folder later", () => {
    const session = (cwd?: string | null): Extract<ChatEvent, { k: "session" }> => ({ k: "session", sessionId: SID, model: null, mode: null, version: "2.1.317", bypass: false, cwd });
    expect(workingFolderOf(session(WT))).toBe(WT);
    expect(workingFolderOf(session(undefined))).toBeNull();
    expect(workingFolderOf(session(null))).toBeNull();
    expect(workingFolderOf(session("relative"))).toBeNull();
    expect(shownWorkingFolder(WT, WT)).toBeNull();
    expect(shownWorkingFolder(`${WT}/`, WT)).toBeNull();
    expect(shownWorkingFolder("/elsewhere", WT)).toBe("/elsewhere");
    expect(shownWorkingFolder("/elsewhere", null)).toBeNull();
    // The event came before the page knew the chat's folder (a snapshot before the projects, at boot).
    const next = applyEvent(chatWith(), session(WT), { seq: 3, replay: false, cwd: null, now: 0 });
    expect(next.workingFolder).toBe(WT);
    resetState({ ready: true, projects: [P], chats: [next] });
    const html = renderToStaticMarkup(createElement(Detail, { name: "environment", chat: getState().chats[0]!, route: parse(new URL(`http://x/c/${CHAT}/environment`)) }));
    expect(text(html)).not.toContain(WORKTREE_WORDS.workingFolder);
  });

  test("the Environment card names the worktree's branch beside the project's folder", () => {
    const route = parse(new URL(`http://x/c/${CHAT}/details`));
    const html = renderToStaticMarkup(createElement(Cards, { chat: getState().chats[0]!, route }));
    expect(html).toContain('data-testid="side-worktree-branch"');
    expect(text(html)).toContain(WORKTREE.branch);
  });

  test("Copy the command goes into the worktree; with variables, one line says a terminal of your own lacks them", () => {
    const chat = getState().chats[0]!;
    const html = renderToStaticMarkup(createElement(TerminalBody, { chat, folder: WT, sheet: false, onClose: () => {}, vars: 3 }));
    expect(text(html)).toContain(`cd ${WT} && claude --resume ${SID}`);
    expect(text(html)).toContain(ENV_WORDS.terminal);
    expect(ENV_WORDS.terminal).toBe("A terminal of your own does not have this environment's variables.");
    const none = renderToStaticMarkup(createElement(TerminalBody, { chat, folder: WT, sheet: false, onClose: () => {} }));
    expect(ids(none)).not.toContain("terminal-env-line");
    expect(code("dialogs", "ChatDialogs.tsx")).toContain("const folder = chatFolder(chat.worktree, project?.folder) ?? \"~\";");
  });

  test("the pane, the file pages, the mentions, the search and the tool rows read the chat's own folder", () => {
    for (const [file, needle] of [
      [["terminal", "TerminalPane.tsx"], "chatFolderIn(s, chat)"],
      [["panels", "file.tsx"], "chatFolderIn(s, chat)"],
      [["panels", "details.tsx"], "chatFolderIn(s, chat)"],
      [["composer", "Composer.tsx"], "chatFolderIn(s, chat)"],
      [["search", "useSearch.ts"], "chatFolderIn(s,"],
      [["chat", "items", "Files.tsx"], "chatFolderIn(s,"],
    ] as const)
      expect(code(...file)).toContain(needle);
  });
});

describe("Archive and Delete of a worktree chat (W7, W9; L25, L26)", () => {
  test("the lines: Delete names the worktree and how many files have changes, and when the branch stays", () => {
    expect(deleteWorktreeLine(WT, { changes: 3, branchStays: false })).toBe(`This also removes its worktree, ${WT}, with changes in 3 files.`);
    expect(deleteWorktreeLine(WT, { changes: 1, branchStays: false })).toBe(`This also removes its worktree, ${WT}, with changes in 1 file.`);
    expect(deleteWorktreeLine(WT, { changes: 0, branchStays: true })).toBe(`This also removes its worktree, ${WT}.`);
    expect(deleteWorktreeLine(WT, null)).toBe(`This also removes its worktree, ${WT}.`);
    expect(branchStaysLine("kitespan/wtchataa")).toBe("Its branch kitespan/wtchataa stays: it holds commits that no other branch has.");
    expect(archiveKeepsLine({ changes: 2, branchStays: false })).toBe("Its worktree has changes in 2 files, so it stays on disk.");
    expect(archiveKeepsLine({ changes: 0, branchStays: false })).toBeNull();
    expect(archiveKeepsLine({ changes: 0, ignored: true, branchStays: false })).toBe("Its worktree has files that git ignores, so it stays on disk.");
    expect(archiveKeepsLine(null)).toBeNull();
    expect(keptLine(WT)).toBe(`Its worktree stays at ${WT}.`);
  });

  test("the read of a worktree's changes is a GET; an answer it cannot read is no count", async () => {
    const urls: string[] = [];
    const answer = (body: unknown, status = 200) => (async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    expect(await readWorktreeStatus(CHAT, answer({ changes: 4, branchStays: true }))).toEqual({ changes: 4, ignored: false, branchStays: true });
    expect(await readWorktreeStatus(CHAT, answer({ changes: -1 }))).toEqual({ changes: null, ignored: false, branchStays: false });
    // A 404 is the route's answer for a chat with no worktree of its own: Delete removes none (W12).
    expect(await readWorktreeStatus(CHAT, answer({}, 404))).toEqual({ changes: null, branchStays: false, removes: false });
    expect(await readWorktreeStatus(CHAT, answer({}, 500))).toBeNull();
    expect(urls[0]).toBe(`GET /api/chats/${CHAT}/worktree`);
  });

  test("the dialogs read it once when they open and say it in their own lines; an archived chat says its worktree stayed", () => {
    const src = code("dialogs", "ChatDialogs.tsx");
    expect(src).toContain("readWorktreeStatus(chat.id)");
    expect(src).toContain('data-testid="worktree-delete-line"');
    expect(src).toContain('data-testid="worktree-branch-line"');
    expect(src).toContain('data-testid="worktree-archive-line"');
    const kept = chatWith({ archived: true, worktree: { ...WORKTREE, kept: true } });
    resetState({ ready: true, projects: [P], chats: [kept] });
    const route = parse(new URL(`http://x/c/${CHAT}`));
    const html = renderToStaticMarkup(createElement(Composer, { chat: kept, route }));
    expect(text(html)).toBe(`${keptLine(WT)} Unarchive`);
    const clean = renderToStaticMarkup(createElement(Composer, { chat: { ...kept, worktree: WORKTREE }, route }));
    expect(text(clean)).toBe("Unarchive");
  });

  test("a line with a worktree's path breaks anywhere, so a long path never runs past a phone's edge", () => {
    // A worktree's path (~/.local/share/kitespan/worktrees/<project>/<name>) has no space or hyphen to break at.
    const css = readFileSync(join(WEB, "styles", "environment.css"), "utf8");
    expect(css).toMatch(/\.wt-path-line\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.wt-start-line\s*\{[^}]*overflow-wrap:\s*anywhere/); // Claude Code's refusal may name one
    expect(code("dialogs", "ChatDialogs.tsx")).toMatch(/className="wt-path-line" data-testid="worktree-delete-line"/);
    const kept = chatWith({ archived: true, worktree: { ...WORKTREE, kept: true } });
    resetState({ ready: true, projects: [P], chats: [kept] });
    const html = renderToStaticMarkup(createElement(Composer, { chat: kept, route: parse(new URL(`http://x/c/${CHAT}`)) }));
    expect(html).toMatch(/class="[^"]*\bwt-path-line\b[^"]*" data-testid="worktree-kept"/);
  });
});

describe("a refused start's line and its buttons (W4, W5)", () => {
  const notice = (code: "worktree_gone" | "worktree_unverified" | "worktree_resume_refused" | "cwd_unavailable", text = ""): ChatEvent => ({ k: "notice", text, code });
  const reduce = (chat: Chat, e: ChatEvent, seq = 5) => applyEvent(chat, e, { seq, replay: false, cwd: WT, now: 0 });
  const starts = (items: readonly Item[]) => items.filter((i): i is InfoItem => i.kind === "info" && !!i.start).map((i) => i.start);
  const draw = (chat: Chat, item: Item, readOnly = false) =>
    renderToStaticMarkup(
      createElement(TranscriptProvider, { value: { chatId: chat.id, view: "normal", readOnly, isOpen: () => false, toggle: () => {} } }, createElement(ItemView, { item, chatId: chat.id })),
    );

  test("the server's line keeps its code, so only the newest one draws buttons, until the chat's Claude Code starts", () => {
    let chat = reduce(chatWith(), notice("worktree_gone", ERROR_MESSAGES.worktree_gone));
    expect(starts(chat.items)).toEqual(["worktree_gone"]);
    // Refused again (another send meanwhile): the open line's place, so the chat shows one line, not one per send.
    chat = reduce(chat, notice("worktree_gone", ERROR_MESSAGES.worktree_gone), 6);
    chat = reduce(chat, notice("worktree_unverified", "Error: could not verify worktree"), 7);
    expect(chat.items.at(-1)).toMatchObject({ text: ERROR_MESSAGES.worktree_unverified });
    expect(starts(chat.items)).toEqual(["worktree_unverified"]);
    expect(chat.items.filter((i) => i.kind === "info")).toHaveLength(1);
    // A start that went through: the line stays, with its words only; a later refusal is a line of its own.
    chat = reduce(chat, { k: "session", sessionId: SID, model: null, mode: null, version: "2.1.317", bypass: false, cwd: WT }, 8);
    expect(starts(chat.items)).toEqual([]);
    expect(chat.items.filter((i) => i.kind === "info")).toHaveLength(1);
    chat = reduce(chat, notice("worktree_gone", ERROR_MESSAGES.worktree_gone), 9);
    expect(chat.items.filter((i) => i.kind === "info")).toHaveLength(2);
    expect(starts(chat.items)).toEqual(["worktree_gone"]);
    // A notice without a start code is a plain line; a start code's line is the code's own sentence.
    expect(starts(reduce(chatWith(), { k: "notice", text: "This chat waits for a free slot.", code: "queue_full" }).items)).toEqual([]);
    expect(startLine("worktree_gone")).toBe(ERROR_MESSAGES.worktree_gone);
  });

  test("an exit with an unknown startup reason is its line, with no button; a known one is the refusal's line", () => {
    const unknown = reduce(chatWith(), { k: "exit", code: 1, signal: null, stderr: [], startup: { reason: "unknown", line: "Error: sandbox required" } });
    expect(unknown.items.at(-1)).toMatchObject({ kind: "error", text: "Error: sandbox required" });
    const known = reduce(chatWith(), { k: "exit", code: 1, signal: null, stderr: [], startup: { reason: "worktree_resume_refused", line: "Error: cannot resume into worktree" } });
    expect(starts(known.items)).toEqual(["worktree_resume_refused"]);
    expect(known.items.at(-1)).toMatchObject({ text: ERROR_MESSAGES.worktree_resume_refused, detail: "Error: cannot resume into worktree" });
    expect(settledStarts(known.items)!.some((i) => i.kind === "info" && i.start)).toBe(false);
  });

  test("each code's buttons, in Desktop-free words of kitespan's own; none for a plain chat's gone folder", () => {
    expect(startActions("worktree_gone", WORKTREE)).toEqual(["again", "project"]);
    // cwd_unavailable in a worktree chat is a terminal session's linked worktree (the server sends worktree_gone for
    // kitespan's own): it can only continue in the project's folder (W12).
    expect(startActions("cwd_unavailable", WORKTREE)).toEqual(["project"]);
    expect(startActions("cwd_unavailable", null)).toEqual([]);
    expect(startActions("worktree_unverified", WORKTREE)).toEqual(["tryAgain"]);
    expect(startActions("worktree_resume_refused", WORKTREE)).toEqual(["copy", "without"]);
    expect([WORKTREE_WORDS.again, WORKTREE_WORDS.project, WORKTREE_WORDS.tryAgain, WORKTREE_WORDS.copy, WORKTREE_WORDS.without]).toEqual([
      "Make it again from its branch",
      "Continue in the project folder",
      "Try again",
      "Continue in a copy",
      "Continue without the worktree",
    ]);
  });

  test("the line in the chat: its words and its buttons; none in a read-only view or on an archived chat", () => {
    const chat = reduce(chatWith(), notice("worktree_gone", ERROR_MESSAGES.worktree_gone));
    resetState({ ready: true, projects: [P], chats: [chat] });
    const line = chat.items.at(-1)!;
    const html = draw(chat, line);
    expect(text(html)).toBe(`${ERROR_MESSAGES.worktree_gone} ${WORKTREE_WORDS.again} ${WORKTREE_WORDS.project}`);
    expect(ids(html)).toEqual(expect.arrayContaining(["start-line", "start-again", "start-project"]));
    expect(text(draw(chat, line, true))).toBe(ERROR_MESSAGES.worktree_gone);
    resetState({ ready: true, projects: [P], chats: [{ ...chat, archived: true }] });
    expect(ids(draw(chat, line))).not.toContain("start-again");
    const refused = reduce(chatWith(), notice("worktree_resume_refused", "Error: cannot resume into worktree /x: it failed its checks."));
    resetState({ ready: true, projects: [P], chats: [refused] });
    // DESIGN 4.4: kitespan's sentence, with Claude Code's first error line under it.
    expect(text(draw(refused, refused.items.at(-1)!))).toBe(`${ERROR_MESSAGES.worktree_resume_refused} Error: cannot resume into worktree /x: it failed its checks. ${WORKTREE_WORDS.copy} ${WORKTREE_WORDS.without}`);
  });

  test("a button sends one worktree frame on its own press; the ok ack takes this page's buttons away", async () => {
    const chat = reduce(chatWith(), notice("worktree_gone", ERROR_MESSAGES.worktree_gone));
    resetState({ ready: true, projects: [P], chats: [chat] });
    const socket = connect();
    expect(socket.sent.filter((f) => f.t === "worktree")).toEqual([]);
    const done = act.worktreeAct(CHAT, "again");
    const frame = socket.sent.find((f) => f.t === "worktree") as Extract<ClientFrame, { t: "worktree" }>;
    expect(frame).toMatchObject({ t: "worktree", chat: CHAT, act: "again" });
    socket.receive({ t: "ack", rid: frame.rid, ok: true, result: { started: false } });
    expect(await done).toBe(true);
    expect(starts(getState().chats[0]!.items)).toEqual([]);
    // A refusal keeps the buttons and shows its line.
    resetState({ ready: true, projects: [P], chats: [chat] });
    const socket2 = connect();
    const again = act.worktreeAct(CHAT, "start");
    const f2 = socket2.sent.find((f) => f.t === "worktree") as Extract<ClientFrame, { t: "worktree" }>;
    socket2.receive({ t: "ack", rid: f2.rid, ok: false, error: { code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed } });
    expect(await again).toBe(false);
    expect(starts(getState().chats[0]!.items)).toEqual(["worktree_gone"]);
    expect(getState().notice).toBe(ERROR_MESSAGES.worktree_failed);
    connectWith(null);
  });

  test("a send refused for its start shows no second line: the chat has it, with its buttons", async () => {
    resetState({ ready: true, projects: [P], chats: [chatWith()] });
    const socket = connect();
    const sent = act.send(CHAT, "hello");
    void sent;
    const frame = socket.sent.find((f) => f.t === "send") as Extract<ClientFrame, { t: "send" }> | undefined;
    expect(frame).toBeDefined();
    socket.receive({ t: "ack", rid: frame!.rid, ok: false, error: { code: "worktree_gone", message: ERROR_MESSAGES.worktree_gone } });
    await new Promise((r) => setTimeout(r, 0));
    expect(getState().notice).toBeNull();
    connectWith(null);
  });

  test("the press is the line's own: no button retries by itself, and Continue in a copy forks the session", () => {
    const src = code("worktree", "StartLine.tsx");
    expect(src).toContain("act.continueSession(chat.projectId, chat.sessionId, true)");
    expect(src).toContain('act.worktreeAct(chat.id, a === "again" ? "again" : a === "project" ? "project" : "start")');
    expect(src).not.toMatch(/useEffect/);
  });
});

describe("New environment's two rows (row 73, D60)", () => {
  const HOME = "/srv/u";
  const LISTING = { ok: true as const, path: HOME, parent: "/srv", home: HOME, folders: [{ name: "site", path: `${HOME}/site`, git: true, subfolders: false, link: false }], truncated: false };
  const render = (start: Record<string, unknown>) => renderToStaticMarkup(createElement(Finder, { onAdded: () => {}, onClose: () => {}, start: { listing: LISTING, suggested: [], ...start } }));

  test("Worktree, off by default, and Environment variables with Desktop's None for this environment", () => {
    resetState({ ready: true, projects: [] });
    const html = render({});
    expect(text(html)).toContain("Worktree Environment variables None for this environment");
    expect(html).toMatch(/data-testid="new-env-worktree"/);
    expect(html).not.toMatch(/data-testid="new-env-worktree"[^>]*checked/);
    expect(html).toContain('aria-expanded="false" data-testid="new-env-vars"');
    expect(html).not.toContain("<textarea");
  });

  test("a folder where a worktree cannot be made: the switch is off and disabled, with its one line", () => {
    resetState({ ready: true, projects: [] });
    const html = render({ can: { ok: false, why: "no_commit" }, worktree: true });
    expect(text(html)).toContain(`Worktree ${WORKTREE_OFF_LINE.no_commit}`);
    expect(html).toMatch(/role="switch"(?![^>]*checked)[^>]*disabled=""/);
  });

  test("the KEY=value field opens under its row; a line's problem keeps Use this folder off", () => {
    resetState({ ready: true, projects: [] });
    const html = render({ vars: "NO_EQUALS\nOK=1" });
    expect(html).toContain("<textarea");
    expect(text(html)).not.toMatch(/Environment variables \d+ variables?/); // no count while a line has a problem
    expect(text(html)).toContain("Line 1: No = on this line.");
    expect(html).toMatch(/data-testid="confirm-use-folder"[^>]*disabled/);
    const fine = render({ vars: "OK=1" });
    expect(fine).toMatch(/data-testid="confirm-use-folder"(?![^>]*disabled)/);
    expect(text(fine)).toContain("Environment variables 1 variable");
  });

  test("a folder that a project has already: both rows open that project's environment instead", () => {
    resetState({ ready: true, projects: [{ id: "h0h0h0h0h0", name: "u", folder: HOME, branch: "", picks: {}, env: 2 }] });
    const html = render({});
    expect(text(html)).toContain("Worktree Off Environment variables 2 variables");
    expect(html).toContain('href="/p/h0h0h0h0h0/environment"');
    expect(html).not.toContain('data-testid="new-env-worktree"');
  });

  test("Use this folder: one POST /api/projects, with worktree only when it is on, then the values once, after the project exists", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const real = (globalThis as { fetch: typeof fetch }).fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const project = { id: "p0p0p0p0p0", cwd: `${HOME}/site`, name: "site", createdAt: "", lastUsedAt: "", picks: { model: null, effort: null, permissionMode: null }, worktree: true, env: 0 };
      return new Response(JSON.stringify({ project }), { status: 201 });
    }) as unknown as typeof fetch;
    try {
      resetState({ ready: true, projects: [] });
      expect(await act.addFolder(`${HOME}/site`)).toEqual({ id: "p0p0p0p0p0" });
      expect(await act.addFolder(`${HOME}/site`, { worktree: true })).toEqual({ id: "p0p0p0p0p0" });
      expect(calls.map((c) => [c.url, c.body])).toEqual([
        ["/api/projects", { cwd: `${HOME}/site` }],
        ["/api/projects", { cwd: `${HOME}/site`, worktree: true }],
      ]);
      expect(getState().projects[0]).toMatchObject({ id: "p0p0p0p0p0", worktree: true });
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = real;
    }
    const src = code("dialogs", "NewEnvironment.tsx");
    // The values go after the project exists, in one save; the dialog's own state holds them, and empties it.
    expect(src).toMatch(/const r = await act\.addFolder\(target, \{ worktree: !existing && worktree \}\);[\s\S]*?saveEnv\(id, change\)/);
    expect(src).toMatch(/void addEnvironment\(\{[^}]*\}\)\.then\(\(r\) => \{[\s\S]*?setVarsText\(""\);\s*onAdded\(r\.id\);/);
    expect(src).not.toContain("localStorage");
    expect(code("screens", "NewChatForm.tsx")).not.toMatch(/vars|ENV_WORDS/);
  });

  test("the editor's Worktree switch: one POST of the project's option, on its own press", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const real = (globalThis as { fetch: typeof fetch }).fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const project = { id: P.id, cwd: ROOT, name: "kitespan", createdAt: "", lastUsedAt: "", picks: { model: null, effort: null, permissionMode: null }, worktree: false, env: 3 };
      return new Response(JSON.stringify({ project }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      expect(await act.setWorktree(P.id, false)).toBe(true);
      expect(calls).toEqual([{ url: `/api/projects/${P.id}/worktree`, body: { on: false } }]);
      expect(getState().projects[0]).toMatchObject({ worktree: false, env: 3 });
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = real;
    }
  });
});

describe("the editor's page, /p/<project>/environment (opened directly, after a reload, Back and Forward: the URL is all it needs)", () => {
  test("its folder, its Worktree switch and its variables, under the title Environment; the bar names the project", () => {
    resetState({ ready: true, projects: [P], chats: [] });
    const route = parse(new URL(`http://x/p/${P.id}/environment?name=API_KEY`));
    const html = renderToStaticMarkup(createElement(EnvironmentScreen, { route }));
    expect(html).toContain('data-testid="project-environment"');
    expect(html).toMatch(/<h1 class="scr-h1">Environment<\/h1>/);
    const t = text(html);
    expect(t).toContain("Folder");
    expect(t).toContain("Worktree");
    expect(html).toMatch(/data-testid="worktree-switch"/);
    expect(html).toMatch(/role="switch"[^>]*checked=""/);
    expect(t).toContain(ENV_WORDS.title);
    expect(t).toContain("kitespan"); // the title bar
  });

  test("a project that is not here: Home, with the 5.4 line", () => {
    resetState({ ready: true, projects: [P], chats: [] });
    const route = parse(new URL("http://x/p/k3m7q2x4aa/environment"));
    expect(text(renderToStaticMarkup(createElement(EnvironmentScreen, { route })))).toContain("That project is not here.");
  });

  test("the route opens its screen from the route table, and every way in is the same path", () => {
    expect(code("App.tsx")).toContain('case "projectEnvironment":\n      return <EnvironmentScreen route={route} />;');
    const r = parse(new URL(`http://x/p/${P.id}/environment?name=API_KEY&value=x`));
    expect([r.name, r.params.project, r.query]).toEqual(["projectEnvironment", P.id, { name: "API_KEY" }]);
    // The page's own links to it carry no name or value: the project page's rows, the chat's fact, New environment's row.
    for (const file of [["screens", "ProjectScreen.tsx"], ["panels", "details.tsx"], ["dialogs", "NewEnvironment.tsx"]] as const)
      expect(code(...file)).toMatch(/href\("projectEnvironment", \{ project: [a-z.]+\.id \}\)/);
  });
});

describe("the session lists (L31)", () => {
  test("a terminal session from another worktree of the repository names its branch there; others name none", () => {
    const rows = [
      { s: { sessionId: SID, title: "In a worktree", lastModified: Date.parse("2026-11-03T07:00:00.000Z"), branch: "feature/x" }, p: P },
      { s: { sessionId: "8c9e6679-7425-40de-944b-e07fc1f90ae7", title: "Here", lastModified: Date.parse("2026-11-03T07:00:00.000Z") }, p: P },
    ];
    const one = renderToStaticMarkup(createElement(SessionRows, { rows, withProject: false }));
    expect(one.match(/data-testid="session-branch"/g)).toHaveLength(1);
    expect(text(one)).toContain("In a worktree feature/x");
    const mixed = renderToStaticMarkup(createElement(SessionRows, { rows, withProject: true }));
    expect(text(mixed)).toContain("In a worktree kitespan, feature/x");
    expect(text(mixed)).toContain("Here kitespan");
  });
});
