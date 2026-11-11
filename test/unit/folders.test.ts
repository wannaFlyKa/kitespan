// New environment (D54) on the server: the machine's own name, Browse (GET /api/folders: folders only, git marks,
// links listed under their own path, dot folders on request, the 500 cap, one plain line for a folder that cannot be
// read), and Suggested (GET /api/folders/suggested: session folders, then the repositories that the walk under the
// home folder found, with kitespan's projects marked). A file system that stalls is a probe that never answers: each
// read keeps its deadline. Every tree is a mkdtemp folder; nothing of the user's is read.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver } from "../../server/agents/types";
import { folderPath, FOLDER_LINES, FS_PROBES, holdsFolder, listFolders, once } from "../../server/folders/list";
import { Cached, findRepos, RepoCache, suggestedFolders, SUGGEST_LIMITS, type RepoWalk } from "../../server/folders/suggest";
import { createGate } from "../../server/gate/guards";
import { createApi } from "../../server/http/api";
import type { FoldersReply, SuggestedFolder } from "../../server/http/api-types";
import { createApp, logRouteOf, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { machineName } from "../../server/machine";
import { SETTINGS_DEFAULTS } from "../../server/store/types";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-folders-")));
const HOME = join(ROOT, "home");
/** chmod 000 keeps nothing from root, so the unreadable cases run only for another user. */
const ROOT_USER = process.getuid?.() === 0;

const dirs = (...paths: string[]) => paths.forEach((p) => mkdirSync(join(HOME, p), { recursive: true }));
const files = (...paths: string[]) => paths.forEach((p) => writeFileSync(join(HOME, p), "x"));

beforeAll(() => {
  dirs("alpha/src", "alpha/.git", "beta", "Gamma/.cache", ".dotdir/inner", "item2", "item10", "locked/inside", "many");
  files("beta/.git", "beta/readme.md", "notes.txt");
  symlinkSync(join(HOME, "alpha"), join(HOME, "link-to-alpha"));
  symlinkSync(join(HOME, "notes.txt"), join(HOME, "link-to-file"));
  symlinkSync(join(HOME, "gone"), join(HOME, "broken-link"));
  for (let i = 0; i < 501; i++) mkdirSync(join(HOME, "many", `dir-${String(i).padStart(3, "0")}`));
  writeFileSync(join(HOME, "many", "a-file"), "x");
  chmodSync(join(HOME, "locked"), 0o000);
});
afterAll(() => {
  chmodSync(join(HOME, "locked"), 0o700);
  rmSync(ROOT, { recursive: true, force: true });
});

const ok = (r: FoldersReply) => {
  if (!r.ok) throw new Error(`not a listing: ${r.reason}`);
  return r;
};
/** A read on a stalled mount: it never answers. */
const never = <T>(): Promise<T> => new Promise<T>(() => {});

describe("the machine's own name", () => {
  test("the hostname's first label, at most 63 characters; an address stays whole; control characters are refused", () => {
    expect(machineName("devbox.example.internal")).toBe("devbox");
    expect(machineName(" laptop ")).toBe("laptop");
    expect(machineName("10.0.12.7")).toBe("10.0.12.7");
    expect(machineName("x".repeat(70))).toBe("x".repeat(63));
    expect(machineName("")).toBeNull();
    expect(machineName(".local")).toBeNull();
    expect(machineName("dev\u001bbox")).toBeNull();
    expect(machineName("devbox\n")).toBeNull();
    // The real one, read at run time: whatever it is, it has the shape.
    const own = machineName();
    if (own !== null) expect(own).toMatch(/^[^.\s]{1,63}$|^\d{1,3}(\.\d{1,3}){3}$/);
  });
});

describe("the folder a request names", () => {
  test("absolute, ~ or ~/..., normalized; the home folder when none is given; anything else is not a path", () => {
    expect(folderPath(null, HOME)).toBe(HOME);
    expect(folderPath("", HOME)).toBe(HOME);
    expect(folderPath("~", HOME)).toBe(HOME);
    expect(folderPath("~/", HOME)).toBe(HOME);
    expect(folderPath("~/alpha/../beta/", HOME)).toBe(join(HOME, "beta"));
    expect(folderPath("/srv//work/./app/", HOME)).toBe("/srv/work/app");
    expect(folderPath("/", HOME)).toBe("/");
    for (const bad of ["alpha", "./alpha", "~user/x", "~alpha", "/srv/a\u0000b", "/srv/a\nb", `/${"a".repeat(5000)}`]) expect(folderPath(bad, HOME)).toBeNull();
  });
});

describe("Browse: the folders inside one folder", () => {
  test("folders only, sorted by name; git marks; subfolders; a link to a folder under its own path; dot folders left out", async () => {
    const r = ok(await listFolders(HOME, { home: HOME }));
    expect(r.path).toBe(HOME);
    expect(r.parent).toBe(ROOT);
    expect(r.home).toBe(HOME);
    expect(r.truncated).toBe(false);
    expect(r.folders.map((f) => f.name)).toEqual(["alpha", "beta", "Gamma", "item2", "item10", "link-to-alpha", "locked", "many"]);
    const by = Object.fromEntries(r.folders.map((f) => [f.name, f]));
    expect(by.alpha).toEqual({ name: "alpha", path: join(HOME, "alpha"), git: true, subfolders: true, link: false });
    // A worktree's .git is a file: still a repository. Files are never named, and a folder of files has no subfolder.
    expect(by.beta).toEqual({ name: "beta", path: join(HOME, "beta"), git: true, subfolders: false, link: false });
    // Its only subfolder is a dot folder.
    expect(by.Gamma!.subfolders).toBe(false);
    // Resolved only when chosen: the entry keeps the link's own path.
    expect(by["link-to-alpha"]).toEqual({ name: "link-to-alpha", path: join(HOME, "link-to-alpha"), git: true, subfolders: true, link: true });
    if (!ROOT_USER) expect(by.locked).toEqual({ name: "locked", path: join(HOME, "locked"), git: false, subfolders: false, link: false });
    const names = JSON.stringify(r);
    for (const never of ["notes.txt", "link-to-file", "broken-link", ".dotdir", "readme.md"]) expect(names).not.toContain(never);
  });

  test("hidden adds the dot folders, and a dot subfolder counts", async () => {
    const r = ok(await listFolders(HOME, { home: HOME, hidden: true }));
    expect(r.folders.map((f) => f.name)).toContain(".dotdir");
    expect(r.folders.find((f) => f.name === "Gamma")!.subfolders).toBe(true);
    const alpha = ok(await listFolders(join(HOME, "alpha"), { home: HOME, hidden: true }));
    expect(alpha.folders.map((f) => f.name)).toEqual([".git", "src"]);
  });

  test("going into a link lists its folder under the link's path; its parent is where it was listed", async () => {
    const r = ok(await listFolders(join(HOME, "link-to-alpha"), { home: HOME }));
    expect(r.path).toBe(join(HOME, "link-to-alpha"));
    expect(r.parent).toBe(HOME);
    expect(r.folders).toEqual([{ name: "src", path: join(HOME, "link-to-alpha", "src"), git: false, subfolders: false, link: false }]);
  });

  test("at most 500 folders, the first 500 by name, and the truncated flag", async () => {
    const r = ok(await listFolders(join(HOME, "many"), { home: HOME }));
    expect(r.folders).toHaveLength(500);
    expect(r.truncated).toBe(true);
    expect(r.folders[0]!.name).toBe("dir-000");
    expect(r.folders[499]!.name).toBe("dir-499");
    expect(ok(await listFolders(join(HOME, "many"), { home: HOME, cap: 501 })).truncated).toBe(false);
  });

  test("a filter (q) narrows before the cap, as the page does: a folder past the cap is found by its name", async () => {
    const many = join(HOME, "many");
    expect(ok(await listFolders(many, { home: HOME, q: "DIR-500" })).folders.map((f) => f.name)).toEqual(["dir-500"]);
    expect(ok(await listFolders(many, { home: HOME, q: "DIR-500" })).truncated).toBe(false);
    // truncated counts the folders that match, not the whole folder.
    expect(ok(await listFolders(many, { home: HOME, q: "dir-4" })).truncated).toBe(false);
    expect(ok(await listFolders(many, { home: HOME, q: "dir" })).truncated).toBe(true);
    expect(ok(await listFolders(many, { home: HOME, q: "" })).folders).toHaveLength(500);
    // Case and accents are ignored, and the name only has to hold it.
    const accents = join(ROOT, "accents");
    mkdirSync(join(accents, "Café"), { recursive: true });
    mkdirSync(join(accents, "my-cafe-app"), { recursive: true });
    mkdirSync(join(accents, "tea"), { recursive: true });
    expect(ok(await listFolders(accents, { home: HOME, q: "CAFE" })).folders.map((f) => f.name)).toEqual(["Café", "my-cafe-app"]);
  });

  test("a folder that cannot be read answers one plain reason, with its parent", async () => {
    expect(await listFolders(join(HOME, "missing"), { home: HOME })).toEqual({ ok: false, path: join(HOME, "missing"), parent: HOME, home: HOME, reason: "missing", line: FOLDER_LINES.missing });
    expect(await listFolders(join(HOME, "notes.txt"), { home: HOME })).toMatchObject({ ok: false, reason: "not_a_folder", line: "That is a file, not a folder." });
    expect(await listFolders(join(HOME, "broken-link"), { home: HOME })).toMatchObject({ ok: false, reason: "missing" });
    if (!ROOT_USER) expect(await listFolders(join(HOME, "locked"), { home: HOME })).toMatchObject({ ok: false, reason: "denied", line: "You do not have permission to open that folder." });
    expect((await listFolders("/", { home: HOME })).parent).toBeNull();
  });

  test("a subfolder among many files keeps its chevron, whatever the order; a folder of files alone has none", async () => {
    const F = join(ROOT, "files");
    const fill = (dir: string) => {
      for (let i = 0; i < 2_100; i++) writeFileSync(join(F, dir, `f-${i}.txt`), "x");
    };
    mkdirSync(join(F, "src-first", "src"), { recursive: true });
    fill("src-first");
    mkdirSync(join(F, "src-last"));
    fill("src-last");
    mkdirSync(join(F, "src-last", "src"));
    mkdirSync(join(F, "files-only"));
    fill("files-only");
    const r = ok(await listFolders(F, { home: HOME }));
    expect(r.folders.map((f) => [f.name, f.subfolders])).toEqual([
      ["files-only", false],
      ["src-first", true],
      ["src-last", true],
    ]);
    // 6,300 files: on a slow disk (a CI runner, a TMPDIR off tmpfs) the writes alone take over Bun's 5 s.
  }, 20_000);

  test("links past the look cap answer maybe (a chevron), never no", async () => {
    const L = join(ROOT, "links");
    mkdirSync(L);
    for (const n of ["a", "b", "c"]) symlinkSync(join(HOME, "notes.txt"), join(L, n));
    expect(await holdsFolder(L, false, 3)).toBe(false);
    expect(await holdsFolder(L, false, 2)).toBe(true);
    symlinkSync(join(HOME, "alpha"), join(L, "d"));
    expect(await holdsFolder(L, false, 4)).toBe(true);
  });
});

describe("Browse on a file system that stalls", () => {
  test("a folder whose own read never answers: the failed line, within the listing's time", async () => {
    const at = performance.now();
    expect(await listFolders(HOME, { home: HOME, probes: { entries: never }, ms: { list: 50 } })).toEqual({
      ok: false,
      path: HOME,
      parent: ROOT,
      home: HOME,
      reason: "failed",
      line: FOLDER_LINES.failed,
    });
    expect(performance.now() - at).toBeLessThan(1_000);
  });

  test("probes that never answer: no git mark and a chevron after the probe's time; a link whose target never answers is left out", async () => {
    const at = performance.now();
    const r = ok(await listFolders(HOME, { home: HOME, probes: { git: never, subfolders: never, kind: never }, ms: { probe: 20 } }));
    expect(performance.now() - at).toBeLessThan(1_000);
    expect(r.folders.map((f) => f.name)).toEqual(["alpha", "beta", "Gamma", "item2", "item10", "locked", "many"]);
    expect(r.folders.every((f) => !f.git && f.subfolders)).toBe(true);
  });

  test("after the listing's deadline no new probe starts: the rest answer at once", async () => {
    let asked = 0;
    const at = performance.now();
    const r = ok(
      await listFolders(join(HOME, "many"), {
        home: HOME,
        probes: { git: () => (asked++, never()), subfolders: async () => false },
        ms: { list: 50, probe: 10_000 },
      }),
    );
    expect(performance.now() - at).toBeLessThan(1_000);
    expect(r.folders).toHaveLength(500);
    expect(r.folders.every((f) => !f.git)).toBe(true);
    // The 16 probed at once when the deadline came; none of the other 484.
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(16);
  });

  test("one read per path at a time: an ask while it runs shares it, and an ask after it ends reads again", async () => {
    let starts = 0;
    let release: (v: string) => void = () => {};
    const start = () => (starts++, new Promise<string>((r) => (release = r)));
    const a = once("test:shared", start);
    const b = once("test:shared", start);
    expect(starts).toBe(1);
    release("x");
    expect([await a, await b]).toEqual(["x", "x"]);
    await once("test:shared", async () => (starts++, "y"));
    expect(starts).toBe(2);
    // The file system probes share theirs the same way.
    expect(FS_PROBES.git(join(HOME, "alpha"))).toBe(FS_PROBES.git(join(HOME, "alpha")));
  });
});

describe("the walk for git repositories under the home folder", () => {
  const W = join(ROOT, "walk");
  beforeAll(() => {
    const d = (p: string) => mkdirSync(join(W, p), { recursive: true });
    // Home itself is a repository (dotfiles): never counted, still walked.
    for (const p of [".git", "code/website/.git", "code/website/inner/.git", "code/plain/deeper", "a/b/c/.git", "a/b/c2/d/.git", "node_modules/pkg/.git", ".config/tool/.git", "Zeta/.git"]) d(p);
    d("code/infra");
    writeFileSync(join(W, "code", "infra", ".git"), "gitdir: elsewhere\n");
    symlinkSync(join(W, "code"), join(W, "link-to-code"));
  });

  test("depth 3 at most; a repository's own folders, dot folders, node_modules and links are not walked", async () => {
    const r = await findRepos(W);
    expect(r).toEqual({ repos: [join(W, "a", "b", "c"), join(W, "code", "infra"), join(W, "code", "website"), join(W, "Zeta")], complete: true });
  });

  test("the time budget stops it: what it found so far, and complete false", async () => {
    let t = 0;
    // Each look at the clock is 1 ms later: a 3 ms budget ends during the first level.
    const r = await findRepos(W, { budgetMs: 3, now: () => t++ });
    expect(r.complete).toBe(false);
    expect(r.repos.length).toBeLessThan(4);
  });

  test("the cap stops it too", async () => {
    const r = await findRepos(W, { cap: 1 });
    expect(r.repos).toHaveLength(1);
    expect(r.complete).toBe(false);
  });

  test("the cache: the first read waits for the first walk; later reads answer at once; an old walk is served while a new one runs", async () => {
    let walks = 0;
    let release: () => void = () => {};
    const walk = async (): Promise<RepoWalk> => {
      walks++;
      if (walks === 2) await new Promise<void>((r) => (release = r));
      return { repos: [`/repo-${walks}`], complete: true };
    };
    let now = 0;
    const cache = new RepoCache(walk, { cacheMs: 1000, now: () => now });
    expect(await cache.get()).toEqual({ repos: ["/repo-1"], complete: true });
    now = 500;
    expect((await cache.get()).repos).toEqual(["/repo-1"]);
    expect(walks).toBe(1);
    now = 2000;
    expect((await cache.get()).repos).toEqual(["/repo-1"]);
    expect(walks).toBe(2);
    // One walk at a time.
    void cache.get();
    void cache.warm();
    expect(walks).toBe(2);
    release();
    await cache.warm();
    expect((await cache.get()).repos).toEqual(["/repo-2"]);
  });

  test("a first walk that hangs holds a read no longer than its wait, and that read has none", async () => {
    const cache = new RepoCache(() => new Promise<RepoWalk>(() => {}), { waitMs: 20 });
    const at = performance.now();
    expect(await cache.get()).toEqual({ repos: [], complete: false });
    expect(performance.now() - at).toBeLessThan(1_000);
  });
});

describe("Suggested", () => {
  const S = join(ROOT, "suggest");
  const p = (...s: string[]) => join(S, ...s);
  beforeAll(() => {
    for (const d of ["recent/.git", "older", "repo-one/.git", "repo-two/.git", "real-target"]) mkdirSync(p(d), { recursive: true });
    symlinkSync(p("real-target"), p("via-link"));
  });

  const repos = (list: string[]) => ({ get: async (): Promise<RepoWalk> => ({ repos: list, complete: true }) });

  test("session folders newest first (existing ones only), then the repositories, each folder once, projects marked", async () => {
    const out = await suggestedFolders({
      sessionFolders: async () => [p("recent"), p("deleted-since"), p("via-link"), p("older"), p("recent")],
      repos: repos([p("repo-one"), p("recent"), p("real-target"), p("repo-two")]),
      projects: async () => [
        { id: "k3m7q2x4ab", cwd: p("recent") },
        { id: "abcdefghij", cwd: p("real-target") },
      ],
    });
    expect(out).toEqual([
      { name: "recent", path: p("recent"), git: true, project: "k3m7q2x4ab", from: "session" },
      { name: "via-link", path: p("via-link"), git: false, project: "abcdefghij", from: "session" },
      { name: "older", path: p("older"), git: false, project: null, from: "session" },
      { name: "repo-one", path: p("repo-one"), git: true, project: null, from: "repo" },
      { name: "repo-two", path: p("repo-two"), git: true, project: null, from: "repo" },
    ] satisfies SuggestedFolder[]);
  });

  test("at most 20 session folders; a session list that fails leaves the repositories", async () => {
    const many = Array.from({ length: 30 }, (_, i) => p(`s-${String(i).padStart(2, "0")}`));
    for (const d of many) mkdirSync(d, { recursive: true });
    const out = await suggestedFolders({ sessionFolders: async () => many, repos: repos([]), projects: async () => [] });
    expect(out.map((f) => f.path)).toEqual(many.slice(0, SUGGEST_LIMITS.sessions));
    const failed = await suggestedFolders({ sessionFolders: () => Promise.reject(new Error("no")), repos: repos([p("repo-one")]), projects: async () => [] });
    expect(failed.map((f) => f.from)).toEqual(["repo"]);
  });

  test("a session list that never answers leaves the repositories, within the read's time", async () => {
    const at = performance.now();
    const out = await suggestedFolders({ sessionFolders: never, repos: repos([p("repo-one")]), projects: async () => [], ms: { read: 50 } });
    expect(out.map((f) => f.path)).toEqual([p("repo-one")]);
    expect(performance.now() - at).toBeLessThan(1_000);
  });

  test("checks that never answer: that session folder is left out, a real path is the folder's own, a .git mark is none", async () => {
    const at = performance.now();
    const out = await suggestedFolders({
      sessionFolders: async () => [p("recent"), p("older"), p("via-link")],
      repos: repos([]),
      projects: async () => [{ id: "abcdefghij", cwd: p("real-target") }],
      probes: { isFolder: (x) => (x === p("older") ? never() : Promise.resolve(true)), realpath: never, git: never },
      ms: { probe: 20 },
    });
    expect(performance.now() - at).toBeLessThan(1_000);
    expect(out).toEqual([
      { name: "recent", path: p("recent"), git: false, project: null, from: "session" },
      { name: "via-link", path: p("via-link"), git: false, project: null, from: "session" },
    ] satisfies SuggestedFolder[]);
  });

  test("the session list is read in the background: none while the first read hangs, then served from memory; a failed read keeps the last", async () => {
    const hung = new Cached<string[]>(never, [], { waitMs: 20 });
    expect(await hung.get()).toEqual([]);
    let reads = 0;
    let now = 0;
    const cache = new Cached<string[]>(
      async () => {
        if (++reads === 2) throw new Error("the SDK failed");
        return [`/s-${reads}`];
      },
      [],
      { cacheMs: SUGGEST_LIMITS.sessionsCacheMs, now: () => now },
    );
    expect(await cache.get()).toEqual(["/s-1"]);
    expect(await cache.get()).toEqual(["/s-1"]);
    expect(reads).toBe(1);
    now = SUGGEST_LIMITS.sessionsCacheMs + 1;
    expect(await cache.get()).toEqual(["/s-1"]);
    await cache.warm();
    expect(reads).toBe(2);
    expect(await cache.get()).toEqual(["/s-1"]);
  });
});

describe("the routes: GET reads behind the Host allowlist and the Origin check", () => {
  const PORT = 7941;
  const OWN = `http://127.0.0.1:${PORT}`;
  const noServer: Upgrader = { upgrade: () => false };
  const driver = {
    probe: async () => ({ ok: false, path: null, realpath: null, version: null, source: "path" as const, refused: [], platformPackages: [], drift: null, belowMinimum: null }),
    settings: async () => ({ respondToBash: true, cleanupPeriodDays: null, promptSuggestions: false, defaultMode: null }),
    listSessions: async () => [],
    history: async () => ({ events: [], more: null }),
    sessionInfo: async () => null,
  } satisfies Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo">;

  function makeApp(suggested?: () => Promise<SuggestedFolder[]>) {
    const gate = createGate(PORT, ["https://forward.example.com"]);
    const site = loadSite(join(ROOT, "no-dist"), gate.origins);
    const api = createApi({
      gate,
      safe: site.safe,
      store: {
        listProjects: async () => [],
        putProject: async () => {},
        readSettings: async () => ({ ...SETTINGS_DEFAULTS }),
        readChat: async () => null,
        listUploads: async () => [],
        putUpload: async () => {},
        removeUpload: async () => null,
      },
      driver,
      uploadFolder: async () => ({ ok: true, path: "/tmp/x", choice: "temp" }),
      chatForSession: () => null,
      heldSessions: () => new Set(),
      info: { port: PORT, version: "0.1.0", adapters: { ...PUBLIC_ADAPTERS, origins: ["https://forward.example.com"] } },
      home: HOME,
      ...(suggested ? { suggestedFolders: suggested } : {}),
    });
    return createApp({ gate, site, api, sockets: {} });
  }
  const get = async (app: ReturnType<typeof makeApp>, path: string, headers: Record<string, string> = {}, method = "GET") =>
    (await app.fetch(new Request(`${OWN}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }), noServer))!;

  test("the home folder with no path, a ~/ path, the dot folders on request; a path that is not one is a 400", async () => {
    const app = makeApp();
    const home = await get(app, "/api/folders");
    expect(home.status).toBe(200);
    expect(home.headers.get("cache-control")).toBe("no-store");
    const body = (await home.json()) as FoldersReply;
    expect(body).toMatchObject({ ok: true, path: HOME, home: HOME });
    const alpha = (await (await get(app, `/api/folders?path=${encodeURIComponent("~/alpha")}&hidden=1`)).json()) as FoldersReply;
    expect(ok(alpha).folders.map((f) => f.name)).toEqual([".git", "src"]);
    const past = (await (await get(app, `/api/folders?path=${encodeURIComponent("~/many")}&q=dir-500`)).json()) as FoldersReply;
    expect(ok(past).folders.map((f) => f.name)).toEqual(["dir-500"]);
    for (const bad of ["alpha", "~nobody", "%00"]) {
      const r = await get(app, `/api/folders?path=${bad}`);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    }
  });

  test("a folder that cannot be read is still a 200 read with its line, never an error page", async () => {
    const app = makeApp();
    const r = await get(app, `/api/folders?path=${encodeURIComponent(join(HOME, "missing"))}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: false, reason: "missing", line: "That folder does not exist." });
  });

  test("a rebinding Host and a foreign Origin read nothing; an allowed origin reads; only GET and HEAD", async () => {
    const app = makeApp(async () => []);
    for (const path of ["/api/folders", "/api/folders/suggested"]) {
      expect((await get(app, path, { host: `rebind.example:${PORT}` })).status).toBe(403);
      expect((await get(app, path, { origin: "https://evil.example" })).status).toBe(403);
      expect((await get(app, path, { origin: "https://forward.example.com" })).status).toBe(200);
      expect((await get(app, path, { host: "forward.example.com" })).status).toBe(200);
      expect((await get(app, path, {}, "HEAD")).status).toBe(200);
      const post = await get(app, path, { "x-kitespan": "1", "content-type": "application/json", origin: OWN }, "POST");
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  test("suggested: the service's list, or none without one; a log line names only the route", async () => {
    const list: SuggestedFolder[] = [{ name: "alpha", path: join(HOME, "alpha"), git: true, project: null, from: "repo" }];
    expect(await (await get(makeApp(async () => list), "/api/folders/suggested")).json()).toEqual({ folders: list });
    expect(await (await get(makeApp(), "/api/folders/suggested")).json()).toEqual({ folders: [] });
    expect(logRouteOf("/api/folders")).toBe("/api/folders");
    expect(logRouteOf("/api/folders/suggested")).toBe("/api/folders/suggested");
  });
});
