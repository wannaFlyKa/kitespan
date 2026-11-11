// New environment (D54): the new-chat form's folder picker opens Desktop's "New environment" in place of the typed
// path of "Add a folder". One line names the machine by the server's own name for it (welcome's `host`), never the
// browser's address; the folder is found: Suggested at the start, Browse from the home folder with a breadcrumb back
// up, a filter that narrows the rows and takes a typed /path or ~/path, the keys, and one Use this folder that adds the
// project (POST /api/projects) and nothing before it. The machine's name is also the Environment card's and the
// Environment view's. The finder's logic is pure (web/dialogs/finder.ts); the dialog renders with React's server
// renderer from a first listing; the rest are pins on the source, as the other component tests do. The click-through
// of the real page is scripts/ui-check.ts's new-environment flow.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FoldersReply, SuggestedFolder } from "../../server/http/api-types";
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, FOLDER_NOT_FULL, FOLDER_REFUSED, getState, machineOf, resetState } from "../../web/state/store";
import { activeRow, crumbs, expand, finderKey, finderView, folderToRead, folderToUse, FOLDERS_FAILED, listingAsk, narrow, parentOf, readFolders, readSuggested, SUGGESTED_SHOWN, tilde, typedPath, usable } from "../../web/dialogs/finder";
import { FILTER_HINT, Finder, NEW_ENVIRONMENT, USE_FOLDER, type FinderStart } from "../../web/dialogs/NewEnvironment";
import { useModalSheet } from "../../web/dialogs/Modal";
import { Cards } from "../../web/panels/cards";
import { Detail } from "../../web/panels/details";
import { parse } from "../../web/router";
import type { Chat, Project } from "../../web/state/types";
import { scripted } from "./fixtures";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
/** The source without its comments, so a pin reads the code only. */
const code = (...p: string[]) => src(...p).replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const text = (html: string) => html.replace(/<span class="visually-hidden">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const HOME = "/srv/u";
const MACHINE = "devbox";
const entry = (name: string, over: Partial<{ git: boolean; subfolders: boolean; link: boolean; at: string }> = {}) => ({ name, path: `${over.at ?? HOME}/${name}`, git: over.git ?? false, subfolders: over.subfolders ?? false, link: over.link ?? false });
const HOME_LIST: FoldersReply = { ok: true, path: HOME, parent: "/srv", home: HOME, folders: [entry("code", { subfolders: true }), entry("Documents")], truncated: false };
const CODE_LIST: FoldersReply = { ok: true, path: `${HOME}/code`, parent: HOME, home: HOME, folders: [entry("infra", { git: true, at: `${HOME}/code` }), entry("website", { git: true, at: `${HOME}/code` })], truncated: false };
const suggested = (name: string, path: string, over: Partial<SuggestedFolder> = {}): SuggestedFolder => ({ name, path, git: true, project: null, from: "session", ...over });
const SUGGESTED: SuggestedFolder[] = [
  suggested("kitespan", "/work/kitespan", { project: "kitespanxx" }),
  suggested("website", `${HOME}/code/website`),
  suggested("infra", `${HOME}/code/infra`, { from: "repo" }),
];

// The viewport the dialog reads (layout/size.ts): a laptop window with a mouse, or a phone with touch.
const gm = globalThis as unknown as { matchMedia?: unknown; window?: Record<string, unknown> };
const own = { mm: !gm.matchMedia, win: !gm.window };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { ...(gm.window ?? {}), innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => {
  gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
  viewport(1100, 800, false);
});
afterAll(() => {
  connectWith(null);
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  resetState();
});
beforeEach(() => resetState());

describe("the filter field's text (D54)", () => {
  test("a path is /..., ~ or ~/...: the folder up to its last / is listed, the rest narrows it", () => {
    expect(typedPath("web")).toBeNull();
    expect(typedPath("~bob/app")).toBeNull(); // another user's home is not a path the server takes
    expect(typedPath("~")).toEqual({ dir: "~", leaf: "", full: "~" });
    expect(typedPath("~/")).toEqual({ dir: "~/", leaf: "", full: "~/" });
    expect(typedPath("~/code/we")).toEqual({ dir: "~/code/", leaf: "we", full: "~/code/we" });
    expect(typedPath("/")).toEqual({ dir: "/", leaf: "", full: "/" });
    expect(typedPath(" /srv/u/code/ ")).toEqual({ dir: "/srv/u/code/", leaf: "", full: "/srv/u/code/" });
  });

  test("the filter narrows by name, case and accents ignored, the names that start with it first", () => {
    const rows = [{ name: "my-web" }, { name: "Website" }, { name: "infra" }, { name: "Wébapp" }];
    expect(narrow(rows, "web").map((r) => r.name)).toEqual(["Website", "Wébapp", "my-web"]);
    expect(narrow(rows, "").map((r) => r.name)).toEqual(["my-web", "Website", "infra", "Wébapp"]);
    expect(narrow(rows, "zzz")).toEqual([]);
  });

  test("paths: ~ for the home folder, the breadcrumb from / through ~, a typed folder made absolute", () => {
    expect(tilde(`${HOME}/code/website`, HOME)).toBe("~/code/website");
    expect(tilde(HOME, HOME)).toBe("~");
    expect(tilde(`${HOME}x/a`, HOME)).toBe(`${HOME}x/a`);
    expect(tilde("/work/kitespan", null)).toBe("/work/kitespan");
    expect(crumbs(HOME, HOME)).toEqual([{ label: "/", path: "/" }, { label: "~", path: HOME }]);
    expect(crumbs(`${HOME}/code/website`, HOME).map((c) => [c.label, c.path])).toEqual([["/", "/"], ["~", HOME], ["code", `${HOME}/code`], ["website", `${HOME}/code/website`]]);
    expect(crumbs("/work/kitespan", HOME).map((c) => c.label)).toEqual(["/", "work", "kitespan"]);
    expect(crumbs("/", HOME).map((c) => c.label)).toEqual(["/"]);
    expect(expand("~", HOME)).toBe(HOME);
    expect(expand("~/code/", HOME)).toBe(`${HOME}/code`);
    expect(expand("~/code/", null)).toBeNull();
    expect(expand("/srv/", HOME)).toBe("/srv");
    expect(expand("/", HOME)).toBe("/");
    expect(parentOf("/work/kitespan")).toBe("/work");
    expect(parentOf("/work")).toBe("/");
  });
});

describe("what the finder shows (D54, principle 0: no empty section)", () => {
  const view = (o: Partial<Parameters<typeof finderView>[0]>) => finderView({ text: "", dir: "~", home: HOME, listing: HOME_LIST, suggested: SUGGESTED, ...o });
  test("at the start: Suggested without the folders kitespan has (the folder picker lists them), then the home folder's folders, unmarked", () => {
    // kitespan is a project by the server's answer, infra by the page's own projects (one added since the read).
    const v = view({ projects: new Set([`${HOME}/code/infra`, `${HOME}/Documents`]) });
    expect(v.start).toBe(true);
    expect(v.list).toEqual({ path: "~", hidden: false });
    expect(v.suggested.map((r) => [r.name, r.git])).toEqual([["website", true]]);
    // Browse lists a project's folder as any other: Use this folder on it answers that project.
    expect(v.browse.map((r) => [r.name, r.more])).toEqual([["code", true], ["Documents", false]]);
    expect(Object.keys(v.browse[1]!)).not.toContain("project");
    // Back at the home folder by the breadcrumb (its absolute path): the same start.
    expect(view({ dir: HOME }).start).toBe(true);
  });

  test("inside a folder, or with a path typed, Suggested does not show", () => {
    expect(view({ dir: `${HOME}/code`, listing: CODE_LIST }).suggested).toEqual([]);
    expect(view({ text: "~/" }).suggested).toEqual([]);
  });

  test(`Suggested shows its first ${SUGGESTED_SHOWN} rows; the filter reaches every one`, () => {
    const many = Array.from({ length: 30 }, (_, i) => suggested(`repo-${String(i).padStart(2, "0")}`, `${HOME}/r/repo-${i}`, { from: "repo" }));
    expect(view({ suggested: many }).suggested.length).toBe(SUGGESTED_SHOWN);
    expect(view({ suggested: many, text: "repo" }).suggested.length).toBe(30);
    expect(view({ suggested: many, text: "repo-2" }).suggested.map((r) => r.name)).toEqual(["repo-20", "repo-21", "repo-22", "repo-23", "repo-24", "repo-25", "repo-26", "repo-27", "repo-28", "repo-29"]);
  });

  test("a typed path lists its folder and narrows it by the rest; a last part with a dot brings the dot folders", () => {
    const v = view({ text: "~/code/we", listing: CODE_LIST });
    expect(v.list).toEqual({ path: "~/code/", hidden: false });
    expect(v.filter).toBe("we");
    expect(v.browse.map((r) => r.name)).toEqual(["website"]);
    expect(view({ text: "~/.c" }).list).toEqual({ path: "~/", hidden: true });
    expect(view({ text: ".c" }).list).toEqual({ path: "~", hidden: true });
  });

  test("a folder that Use this folder could never take shows no row: a control character, a space at its end, too long", () => {
    expect(["/srv/u/code", "/srv/u/my folder", "~/code"].map(usable)).toEqual([true, true, true]);
    expect(["/", "", "/srv/u/odd\u001bname", "/srv/u/bidi\u202ename", "/srv/u/tail ", `/srv/${"x".repeat(1100)}`, "/srv/u/../x", "code"].map(usable)).toEqual([false, false, false, false, false, false, false, false]);
    const odd: FoldersReply = { ...HOME_LIST, folders: [entry("code", { subfolders: true }), entry("odd\u001bname"), entry("tail "), entry("bidi\u202ename"), entry("x".repeat(1100)), entry("Documents")] };
    expect(view({ listing: odd }).browse.map((r) => r.name)).toEqual(["code", "Documents"]);
    expect(view({ suggested: [suggested("bell\u0007", `${HOME}/bell\u0007`), ...SUGGESTED] }).suggested.map((r) => r.name)).toEqual(["website", "infra"]);
  });

  test("a folder with more folders than one listing holds: the filter goes to the server too (q), whose answer Browse shows", () => {
    const BIG_AT = "/srv/big";
    const many = Array.from({ length: 500 }, (_, i) => entry(`pkg-${String(i).padStart(3, "0")}`, { at: BIG_AT }));
    const BIG: FoldersReply = { ok: true, path: BIG_AT, parent: "/srv", home: HOME, folders: many, truncated: true };
    const list = { path: BIG_AT, hidden: false };
    // The first 500 by name hold no "zeta": the page alone would show no row.
    expect(finderView({ text: "zeta", dir: BIG_AT, home: HOME, listing: BIG, suggested: [] }).browse).toEqual([]);
    expect(listingAsk(list, "zeta", BIG)).toEqual({ ...list, q: "zeta" });
    // Nothing typed, a listing still on its way, or one that holds every folder: the page narrows it alone.
    expect(listingAsk(list, "", BIG)).toEqual(list);
    expect(listingAsk(list, "zeta", null)).toEqual(list);
    expect(listingAsk({ path: "~", hidden: false }, "co", HOME_LIST)).toEqual({ path: "~", hidden: false });
    // A typed path's last part is its filter: ~/big/ze asks ~/big/ with q=ze once ~/big/ came back truncated.
    expect(listingAsk({ path: "~/big/", hidden: false }, "ze", { ...BIG, path: `${HOME}/big` })).toEqual({ path: "~/big/", hidden: false, q: "ze" });
    const NARROWED: FoldersReply = { ...BIG, folders: [entry("zeta", { at: BIG_AT, git: true })], truncated: false };
    expect(finderView({ text: "zeta", dir: BIG_AT, home: HOME, listing: NARROWED, suggested: [] }).browse.map((r) => [r.name, r.git])).toEqual([["zeta", true]]);
  });

  test("a listing that is still on its way, or failed, shows no rows", () => {
    expect(view({ dir: `${HOME}/code`, listing: null }).browse).toEqual([]);
    expect(view({ listing: { ok: false, path: "/nope", parent: "/", home: HOME, reason: "missing", line: "That folder does not exist." } }).browse).toEqual([]);
  });
});

describe("the keys and the folder Use this folder takes (D54)", () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  test("the arrows move the highlight within the rows; Enter opens; Cmd or Ctrl+Enter uses", () => {
    expect(finderKey(key("ArrowDown"), null, 3)).toEqual({ kind: "move", to: 0 });
    expect(finderKey(key("ArrowDown"), 2, 3)).toEqual({ kind: "move", to: 2 });
    expect(finderKey(key("ArrowUp"), null, 3)).toEqual({ kind: "move", to: 2 });
    expect(finderKey(key("ArrowUp"), 0, 3)).toEqual({ kind: "move", to: 0 });
    expect(finderKey(key("ArrowDown"), null, 0)).toBeNull();
    expect(finderKey(key("Enter"), null, 0)).toEqual({ kind: "open" }); // a typed path opens with no row
    expect(finderKey(key("Enter", { metaKey: true }), 1, 3)).toEqual({ kind: "use" });
    expect(finderKey(key("Enter", { ctrlKey: true }), null, 0)).toEqual({ kind: "use" });
    expect(finderKey(key("Enter", { isComposing: true }), 0, 3)).toBeNull();
    expect(finderKey(key("Enter", { shiftKey: true }), 0, 3)).toBeNull();
    expect(finderKey(key("a"), 0, 3)).toBeNull();
  });

  test("the highlight: the row the arrows picked, else the first while a filter is typed, else none", () => {
    expect(activeRow(null, 3, "")).toBeNull();
    expect(activeRow(null, 3, "we")).toBe(0);
    expect(activeRow(5, 3, "")).toBe(2);
    expect(activeRow(1, 0, "we")).toBeNull();
  });

  test("Use this folder: the highlighted row, else a typed path with a last part, else, with nothing typed, the folder Browse is in", () => {
    const use = (text: string, listing: FoldersReply | null, active: number | null = null) => {
      const v = finderView({ text, dir: "~", home: HOME, listing, suggested: [] });
      return folderToUse({ active: active === null ? null : v.browse[active]!, typed: v.typed, filter: v.filter, listing });
    };
    expect(use("", HOME_LIST, 0)).toBe(`${HOME}/code`);
    expect(use("~/code/website", CODE_LIST)).toBe("~/code/website"); // the server checks it
    expect(use("~/code/", CODE_LIST)).toBe(`${HOME}/code`);
    expect(use("", HOME_LIST)).toBe(HOME);
    expect(use("", null)).toBeNull(); // still on its way
    expect(use("", { ok: false, path: "/x", parent: "/", home: HOME, reason: "denied", line: "x" })).toBeNull();
    // A filter that matches no row: nothing to use, never the folder behind the filter (it is not the folder meant).
    expect(finderView({ text: "zzz", dir: "~", home: HOME, listing: HOME_LIST, suggested: SUGGESTED }).browse).toEqual([]);
    expect(use("zzz", HOME_LIST)).toBeNull();
    expect(use("  zzz ", HOME_LIST)).toBeNull();
    // The top of the disk is no project folder, by the breadcrumb or typed.
    const TOP: FoldersReply = { ok: true, path: "/", parent: null, home: HOME, folders: [entry("srv", { at: "", subfolders: true })], truncated: false };
    expect(use("", TOP)).toBeNull();
    expect(use("/", TOP)).toBeNull();
    expect(use("", TOP, 0)).toBe("/srv");
  });

  test("the Worktree read (W2) asks only for a listed folder: a typed path that no row is may not be there", () => {
    const read = (text: string, listing: FoldersReply | null, active: number | null = null) => {
      const v = finderView({ text, dir: "~", home: HOME, listing, suggested: [] });
      return folderToRead({ active: active === null ? null : v.browse[active]!, typed: v.typed, filter: v.filter, listing });
    };
    expect(read("", HOME_LIST, 0)).toBe(`${HOME}/code`);
    expect(read("", HOME_LIST)).toBe(HOME);
    expect(read("~/code/", CODE_LIST)).toBe(`${HOME}/code`);
    // Typed before its folder's listing came (or matching no row): Use this folder would send it, the read does not,
    // so a folder that is not there never gets a failed request.
    expect(read("~/code/in", null)).toBeNull();
    expect(read("~/code/zzz", CODE_LIST)).toBeNull();
    expect(read("", null)).toBeNull();
    expect(read("zzz", HOME_LIST)).toBeNull();
  });
});

describe("the reads are GETs, never recorded (D 8.4: nothing is sent before the click)", () => {
  const stub = (status: number, body: unknown, seen: { url: string; init: RequestInit }[]) =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  test("GET /api/folders with the path in the query, hidden=1 for the dot folders, q for a filter; no sender gate header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    expect(await readFolders({ path: "~/code/", hidden: false }, stub(200, CODE_LIST, seen))).toEqual(CODE_LIST);
    await readFolders({ path: "/srv/my folder", hidden: true }, stub(200, HOME_LIST, seen));
    await readFolders({ path: "/srv/big", hidden: false, q: "zé ta" }, stub(200, HOME_LIST, seen));
    expect(seen.map((s) => [s.url, s.init.method])).toEqual([
      ["/api/folders?path=%7E%2Fcode%2F", "GET"],
      ["/api/folders?path=%2Fsrv%2Fmy+folder&hidden=1", "GET"],
      ["/api/folders?path=%2Fsrv%2Fbig&q=z%C3%A9+ta", "GET"],
    ]);
    expect(JSON.stringify(seen[0]!.init.headers)).not.toContain("x-kitespan");
    expect(gm.window?.__kitespanFrames ?? []).toEqual([]);
  });
  test("a refused or failed read is a folder that could not be read; failed suggestions are none", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const refused = await readFolders({ path: "~/x", hidden: false }, stub(400, { error: { code: "bad_request", message: "That request could not be read." } }, seen));
    expect(refused).toMatchObject({ ok: false, reason: "failed", line: FOLDERS_FAILED });
    const down = await readFolders({ path: "~/x", hidden: false }, (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch);
    expect(down).toMatchObject({ ok: false, line: "kitespan could not be reached." });
    expect(await readSuggested(stub(200, { folders: SUGGESTED }, seen))).toEqual(SUGGESTED);
    expect(await readSuggested(stub(500, { error: { code: "failed", message: "That did not work." } }, seen))).toEqual([]);
    expect(seen.at(-1)!.url).toBe("/api/folders/suggested");
  });
});

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

describe("the machine's name comes from the server (D54), never from the browser's address", () => {
  const welcome = (host?: string | null): ServerFrame => ({ t: "welcome", epoch: "lz2k3m-abcdefghijkl", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.312", drift: null }, update: { available: false }, auth: "none", ...(host === undefined ? {} : { host }) });
  test("welcome's host is the store's machine; none, or a name that cannot be shown, is null", () => {
    const sock = new FakeSocket();
    const conn = new Connection({ url: "ws://127.0.0.1:7942/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
    connectWith(conn);
    conn.start();
    sock.onopen?.({});
    expect(getState().machine).toBeNull();
    sock.receive(welcome(MACHINE));
    expect(getState().machine).toBe(MACHINE);
    sock.receive(welcome(null));
    expect(getState().machine).toBeNull();
    sock.receive(welcome());
    expect(getState().machine).toBeNull();
    connectWith(null);
    expect(machineOf("x".repeat(64))).toBeNull();
    expect(machineOf("dev\nbox")).toBeNull();
    expect(machineOf(" ")).toBeNull();
    expect(machineOf(7)).toBeNull();
  });

  test("no part of the page reads location.hostname, and the catalog has no host stand-in", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : /\.(ts|tsx)$/.test(n) ? [join(dir, n)] : []));
    const readers = files(WEB).filter((f) => /location\.hostname|HOST_NAME/.test(readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "")));
    expect(readers).toEqual([]);
  });

  const P: Project = { id: "k3m7q2x4ab", name: "kitespan", folder: "/work/kitespan", branch: "", picks: {} };
  const chat: Chat = scripted({
    id: "k3m7q2x4abk3m7q2x4ab", projectId: P.id, title: "Fix the upload", titleSource: "first-prompt", state: "idle", updatedAt: "2026-10-31T08:00:00.000Z", sessionId: "", model: "default", effort: "default", mode: "default",
    items: [], pending: [], context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] }, connectors: [], outputs: [],
  });
  const url = (path: string) => parse(new URL(path, "http://127.0.0.1"));
  test("the Environment card and its view name the machine by it; with no name the card has no host row", () => {
    resetState({ projects: [P], chats: [chat], ready: true, machine: MACHINE });
    expect(text(renderToStaticMarkup(createElement(Cards, { chat, route: url(`/c/${chat.id}/details`) })))).toContain(`Environment ${MACHINE} kitespan`);
    expect(text(renderToStaticMarkup(createElement(Detail, { name: "environment", chat, route: url(`/c/${chat.id}/environment`) })))).toContain(`Host ${MACHINE}`);
    resetState({ projects: [P], chats: [chat], ready: true });
    const card = text(renderToStaticMarkup(createElement(Cards, { chat, route: url(`/c/${chat.id}/details`) })));
    expect(card).toBe("Environment kitespan /work");
    expect(card).not.toContain("127.0.0.1");
  });
});

describe("the dialog (D54, principle 0)", () => {
  // Row 73 and D60: Desktop's two rows under the finder, the Worktree switch and Environment variables.
  const ROWS = "Worktree Environment variables None for this environment";
  const render = (start: FinderStart = { listing: HOME_LIST, suggested: SUGGESTED }) => renderToStaticMarkup(createElement(Finder, { onAdded: () => {}, onClose: () => {}, start }));
  test("one line names the machine; the field says what it takes; Suggested, then Browse; one primary button", () => {
    resetState({ machine: MACHINE, projects: [{ id: "kitespanxx", name: "kitespan", folder: "/work/kitespan", branch: "", picks: {} }] });
    const html = render();
    expect([...html.matchAll(/<p\b[^>]*>(.*?)<\/p>/g)].map((m) => text(m[1]!))).toEqual([`On ${MACHINE}`]);
    expect(html).toContain(`placeholder="${FILTER_HINT}"`);
    expect(html).toContain('role="combobox"');
    // kitespan has a project already: the folder picker lists it, so Suggested does not; no row has a mark.
    expect(text(html)).toBe(`On ${MACHINE} Suggested website ~/code infra ~/code Browse / ~ code Documents ${ROWS} Cancel ${USE_FOLDER}`);
    expect(html.match(/class="btn primary"/g)?.length).toBe(1);
    expect(html).toMatch(/data-testid="confirm-use-folder"(?![^>]*disabled)/); // the home folder is a folder to use
    expect(html.match(/<span class="visually-hidden">Git repository<\/span>/g)?.length).toBe(2);
    // The laptop's field takes the focus; on touch the keyboard stays down until the field is tapped.
    expect(html).toContain('data-autofocus=""');
  });

  test("no machine name: no line; no suggestions: no Suggested and no Browse title; a failed folder: its one line", () => {
    const html = render({ listing: HOME_LIST, suggested: [] });
    expect(html).not.toMatch(/<p[\s>]/);
    expect(text(html)).toBe(`/ ~ code Documents ${ROWS} Cancel ${USE_FOLDER}`);
    const failed = render({ listing: { ok: false, path: HOME, parent: "/srv", home: HOME, reason: "denied", line: "You do not have permission to open that folder." }, suggested: [] });
    expect(text(failed)).toBe(`/ ~ You do not have permission to open that folder. ${ROWS} Cancel ${USE_FOLDER}`);
    expect(failed).toMatch(/data-testid="confirm-use-folder"[^>]*disabled/);
  });

  test("touch (the phone and a tablet): a full-height sheet with Cancel at the top right, so no Cancel at the foot; no first focus", () => {
    // A tablet's centred dialog stayed where it was under the on-screen keyboard, with its only Cancel at the foot: on
    // every touch size New environment is the sheet that rides the keyboard (Modal.tsx CancelSheet).
    const sheetHere = (full: boolean) => text(renderToStaticMarkup(createElement(() => createElement("i", null, String(useModalSheet(full))))));
    for (const [w, h] of [[390, 844], [834, 1194], [1024, 1366]] as const) {
      viewport(w, h, true);
      try {
        expect([sheetHere(true), sheetHere(false)]).toEqual(["true", w < 600 ? "true" : "false"]);
        const html = render({ listing: HOME_LIST, suggested: SUGGESTED });
        expect(text(html).endsWith(`Browse / ~ code Documents ${ROWS} ${USE_FOLDER}`)).toBe(true);
        expect(html).not.toContain("data-autofocus");
        expect(html).toContain('class="group-row scr-env-row"');
      } finally {
        viewport(1100, 800, false);
      }
    }
    expect([sheetHere(true), sheetHere(false)]).toEqual(["false", "false"]);
    const modal = code("dialogs", "Modal.tsx");
    expect(modal).toContain("const sheet = useModalSheet(full);");
    expect(modal).toContain("if (sheet && (confirm || full))");
    expect(modal).toContain('className={`sheet${full ? " sheet-full" : ""}${riding ? " is-riding" : ""}`}');
    expect(modal).toContain("height: full ? kb.visualHeight : undefined");
    const dialog = code("dialogs", "NewEnvironment.tsx");
    expect(dialog).toContain('<Modal title={NEW_ENVIRONMENT} testId="dialog-new-environment" onClose={onClose} full>');
    expect(NEW_ENVIRONMENT).toBe("New environment");
    const css = src("styles", "screens.css");
    expect(css).toMatch(/\.sheet\.sheet-full \{\s*top: max\(var\(--s6\), env\(safe-area-inset-top\)\);/);
  });

  test("the form's folder picker opens it as New environment..., and its folder becomes the form's", () => {
    const form = code("screens", "NewChatForm.tsx");
    expect(form).toContain('<span className="scr-pick-text">New environment…</span>');
    expect(form).not.toContain("Add a folder");
    expect(form).toMatch(/<NewEnvironmentDialog\s+onClose=\{\(\) => setAdding\(false\)\}\s+onAdded=\{\(id\) => \{\s*setAdding\(false\);\s*setProjectId\(id\);/);
  });
});

describe("Use this folder (POST /api/projects, the one request, D54)", () => {
  const g = globalThis as unknown as { fetch: typeof fetch };
  const realFetch = g.fetch;
  test("the folder's project: its id, or the server's line; a path that is not one never goes out", async () => {
    const calls: { url: string; body: unknown }[] = [];
    let status = 201;
    g.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (status === 404) return new Response(JSON.stringify({ error: { code: "not_found", message: "That folder does not exist." } }), { status });
      const project = { id: "p0p0p0p0p0", cwd: `${HOME}/code/website`, name: "website", createdAt: "2026-11-01T10:00:00.000Z", lastUsedAt: "2026-11-01T10:00:00.000Z", picks: { model: null, effort: null, permissionMode: null } };
      return new Response(JSON.stringify({ project }), { status });
    }) as unknown as typeof fetch;
    try {
      expect(await act.addFolder(`${HOME}/code/website`)).toEqual({ id: "p0p0p0p0p0" });
      expect(getState().projects.map((p) => [p.id, p.name, p.folder])).toEqual([["p0p0p0p0p0", "website", `${HOME}/code/website`]]);
      status = 404;
      expect(await act.addFolder("~/code/gone")).toEqual({ line: "That folder does not exist." });
      expect(await act.addFolder("code/website")).toEqual({ line: FOLDER_NOT_FULL });
      // The top of the disk, and a full path with an empty, "." or ".." part: a true line, and nothing goes out.
      expect(await act.addFolder("/")).toEqual({ line: FOLDER_REFUSED });
      expect(await act.addFolder("/srv/u//code")).toEqual({ line: FOLDER_REFUSED });
      expect(await act.addFolder("~/code/../x")).toEqual({ line: FOLDER_REFUSED });
      expect(calls).toEqual([
        { url: "/api/projects", body: { cwd: `${HOME}/code/website` } },
        { url: "/api/projects", body: { cwd: "~/code/gone" } },
      ]);
    } finally {
      g.fetch = realFetch;
    }
  });
});
