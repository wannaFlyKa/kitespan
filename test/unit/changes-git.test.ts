// U1 (DESIGN-U1 3 and 9): the marks in scratch repositories (each under its own mkdtemp folder, with git's global and
// system config off): a mark of a clean folder is its commit's tree and writes nothing into the repository; a turn's
// edit, new file, delete, rename and binary file between two marks; ignored files never in a mark; an untracked file
// over 8 MiB left out by the pathspec file; a chat in a subfolder (paths relative to it, nothing outside it); a split
// index left unwritten; a linked worktree's own index; a folder that is not a repository, no git, a refused config, a
// filter driver that never runs; the deadline; and one file's patch with its caps (a side over 1 MiB, a patch over
// 2 MiB) and a mark whose objects are gone.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearWork, diffMarks, objectBytes, placeOf, preparePlace, probeRepo, readPatch, sweepObjects, takeMark, type MarkPlace, type MarkWhy, type RepoAt } from "../../server/changes/git";
import { worktreeGit } from "../../server/worktree/git";
import { GIT_TEST_ENV, commitAll, git, scratch, type Scratch } from "./worktree-repo";

let open: Scratch[] = [];
afterEach(() => {
  for (const s of open) s.cleanup();
  open = [];
});

function repo(files: Record<string, string | Buffer> = {}): Scratch & { place: MarkPlace } {
  const s = scratch();
  open.push(s);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(s.repo, rel, ".."), { recursive: true });
    writeFileSync(join(s.repo, rel), body);
  }
  if (Object.keys(files).length) commitAll(s.repo, "files");
  const dir = join(s.root, "state", "changes", "k3m7q2x4abk3m7q2x4ab");
  return Object.assign(s, { place: placeOf(dir) });
}

const soon = () => performance.now() + 10_000;

async function repoAt(s: Scratch & { place: MarkPlace }, cwd = s.repo): Promise<RepoAt> {
  const p = await probeRepo(s.wg, cwd, soon());
  if (!p.ok) throw new Error(`no repository: ${p.why}`);
  await preparePlace(s.place);
  return p.repo;
}

/**
 * Every file of the repository's .git with its size (and its mtime, but for the objects: git refreshes the time of an
 * object that a mark finds there, as every `git add` does, DESIGN-U1 19): a mark adds, removes and grows none.
 */
function gitFiles(dir: string, out = new Map<string, string>(), base = dir): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) gitFiles(p, out, base);
    else out.set(p.slice(base.length), `${st.size}:${p.includes("/objects/") ? "" : st.mtimeMs}`);
  }
  return out;
}

describe("a mark", () => {
  test("of a clean folder is its commit's tree, and nothing in the repository changes", async () => {
    const s = repo({ "src/a.ts": "a\nb\nc\n", "docs/r.md": "# r\n" });
    const before = gitFiles(join(s.repo, ".git"));
    const r = await repoAt(s);
    expect(r.index).toBe(join(s.repo, ".git", "index"));
    expect(r.objects).toBe(join(s.repo, ".git", "objects"));
    const m = await takeMark(s.wg, r, s.place, soon());
    expect(m!.tree).toBe(git(s.repo, "rev-parse", "HEAD^{tree}").trim());
    expect(gitFiles(join(s.repo, ".git"))).toEqual(before);
    // The copy and the pathspec file are gone (the mark's folder is empty); the marks' objects stay in the chat's own folder.
    expect(readdirSync(s.place.dir).sort()).toEqual(["mark", "objects"]);
    expect(readdirSync(s.place.work)).toEqual([]);
    expect(statSync(s.place.dir).mode & 0o777).toBe(0o700);
    expect(statSync(s.place.objects).mode & 0o777).toBe(0o700);
  });
  test("between two marks: an edit, a new file, a delete, a rename and a binary file; an ignored file is in neither", async () => {
    const s = repo({ "src/a.ts": "a\nb\nc\n", "old.txt": "one\ntwo\nthree\nfour\n", "gone.txt": "x\n", ".gitignore": "node_modules/\n" });
    const r = await repoAt(s);
    const t0 = (await takeMark(s.wg, r, s.place, soon()))!;
    writeFileSync(join(s.repo, "src/a.ts"), "a\nB\nc\nd\n");
    writeFileSync(join(s.repo, "src/b.ts"), "export const b = 1;\n");
    renameSync(join(s.repo, "old.txt"), join(s.repo, "new.txt"));
    unlinkSync(join(s.repo, "gone.txt"));
    writeFileSync(join(s.repo, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    mkdirSync(join(s.repo, "node_modules"));
    writeFileSync(join(s.repo, "node_modules/x.js"), "x\n");
    const t1 = (await takeMark(s.wg, r, s.place, soon()))!;
    const raw = (await diffMarks(s.wg, r, s.place, t0.tree, t1.tree, soon()))!;
    expect(raw.map((x) => [x.status, x.path, x.from ?? null, x.added, x.removed])).toEqual([
      ["D", "gone.txt", null, 0, 1],
      ["A", "logo.bin", null, null, null],
      ["R", "new.txt", "old.txt", 0, 0],
      ["M", "src/a.ts", null, 2, 1],
      ["A", "src/b.ts", null, 1, 0],
    ]);
    // The repository's own index never took the new file.
    expect(git(s.repo, "status", "--porcelain")).toContain("?? src/b.ts");
    expect(await objectBytes(s.wg, r, s.place, soon())).toBeGreaterThan(0);
  });
  test("an untracked file over 8 MiB is left out, its size and times kept", async () => {
    const s = repo({ "a.txt": "a\n" });
    const r = await repoAt(s);
    const t0 = (await takeMark(s.wg, r, s.place, soon()))!;
    writeFileSync(join(s.repo, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 7));
    writeFileSync(join(s.repo, "small.bin"), Buffer.alloc(1024, 7));
    const m = (await takeMark(s.wg, r, s.place, soon()))!;
    expect([...m.large.keys()]).toEqual(["big.bin"]);
    expect(m.large.get("big.bin")!.size).toBe(8 * 1024 * 1024 + 1);
    expect((await diffMarks(s.wg, r, s.place, t0.tree, m.tree, soon()))!.map((x) => x.path)).toEqual(["small.bin"]);
  });
  test("from a subfolder: paths relative to it, and a change outside it is in neither summary", async () => {
    const s = repo({ "app/src/a.ts": "a\n", "other/b.ts": "b\n" });
    const cwd = join(s.repo, "app");
    const r = await repoAt(s, cwd);
    const t0 = (await takeMark(s.wg, r, s.place, soon()))!;
    writeFileSync(join(cwd, "src/a.ts"), "a\nz\n");
    writeFileSync(join(s.repo, "other/b.ts"), "b\nz\n");
    const t1 = (await takeMark(s.wg, r, s.place, soon()))!;
    const raw = (await diffMarks(s.wg, r, s.place, t0.tree, t1.tree, soon()))!;
    expect(raw.map((x) => x.path)).toEqual(["src/a.ts"]);
  });
  test("a repository with a split index: no file of its .git is new or changes size", async () => {
    const s = repo({ "a.txt": "a\n" });
    git(s.repo, "config", "core.splitIndex", "true");
    git(s.repo, "update-index", "--split-index");
    writeFileSync(join(s.repo, "a.txt"), "a\nb\n");
    const sizes = () => new Map([...gitFiles(join(s.repo, ".git"))].map(([k, v]) => [k, v.split(":")[0]]));
    const before = sizes();
    const r = await repoAt(s);
    expect((await takeMark(s.wg, r, s.place, soon()))?.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(sizes()).toEqual(before);
  });
  test("a linked worktree: its own index, the repository's objects", async () => {
    const s = repo({ "a.txt": "a\n" });
    const wt = join(s.root, "wt");
    git(s.repo, "worktree", "add", "-q", wt, "-b", "side");
    const r = await repoAt(s, wt);
    expect(r.index).toBe(join(s.repo, ".git", "worktrees", "wt", "index"));
    expect(r.objects).toBe(join(s.repo, ".git", "objects"));
    const t0 = (await takeMark(s.wg, r, s.place, soon()))!;
    writeFileSync(join(wt, "a.txt"), "a\nw\n");
    const t1 = (await takeMark(s.wg, r, s.place, soon()))!;
    expect((await diffMarks(s.wg, r, s.place, t0.tree, t1.tree, soon()))!.map((x) => x.path)).toEqual(["a.txt"]);
  });
});

describe("no mark", () => {
  test("a folder that is not a repository, no git, a repository whose config could run a program", async () => {
    const s = repo();
    const plain = join(s.root, "plain");
    mkdirSync(plain);
    expect(await probeRepo(s.wg, plain, soon())).toEqual({ ok: false, why: "not_git" });
    expect(await probeRepo(worktreeGit({ PATH: "" }, GIT_TEST_ENV), s.repo, soon())).toEqual({ ok: false, why: "no_git" });
    git(s.repo, "config", "includeIf.gitdir:/srv/.path", "/srv/other.inc");
    expect(await probeRepo(s.wg, s.repo, soon())).toEqual({ ok: false, why: "refused" });
  });
  test("a filter driver that the repository defines never runs", async () => {
    const s = repo({ "a.txt": "a\n" });
    const marker = join(s.root, "ran");
    git(s.repo, "config", "filter.mark.clean", `touch ${marker}; cat`);
    git(s.repo, "config", "filter.mark.required", "true");
    writeFileSync(join(s.repo, ".gitattributes"), "*.txt filter=mark\n");
    writeFileSync(join(s.repo, "b.txt"), "b\n");
    const r = await repoAt(s);
    expect(r.config).toContain("filter.mark.clean=");
    expect((await takeMark(s.wg, r, s.place, soon()))?.tree).toBeDefined();
    expect(existsSync(marker)).toBe(false);
  });
  test("past the deadline: null, and nothing half-made is kept", async () => {
    const s = repo({ "a.txt": "a\n" });
    const r = await repoAt(s);
    expect(await takeMark(s.wg, r, s.place, performance.now() - 1)).toBeNull();
    expect(readdirSync(s.place.dir).sort()).toEqual(["mark", "objects"]);
    expect(readdirSync(s.place.work)).toEqual([]);
    const abort = new AbortController();
    abort.abort();
    expect(await takeMark(s.wg, r, s.place, soon(), abort.signal)).toBeNull();
  });
});

describe("one file's patch", () => {
  test("its hunks; a side over 1 MiB and a patch over 2 MiB are too large; gone objects are gone", async () => {
    const lines = (n: number, c: string) => Array.from({ length: n }, () => c).join("\n") + "\n";
    const s = repo({ "src/a.ts": "a\nb\nc\n", "big.txt": "x\n", "many.txt": lines(524_288, "a") });
    const r = await repoAt(s);
    const t0 = (await takeMark(s.wg, r, s.place, soon()))!;
    writeFileSync(join(s.repo, "src/a.ts"), "a\nB\nc\n");
    writeFileSync(join(s.repo, "big.txt"), "y\n".repeat(600_000));
    writeFileSync(join(s.repo, "many.txt"), lines(524_288, "b"));
    const t1 = (await takeMark(s.wg, r, s.place, soon()))!;
    const marks = { from: t0.tree, to: t1.tree };
    const a = await readPatch(s.wg, r, s.place, marks, { path: "src/a.ts" }, soon());
    expect(a).toEqual({ ok: true, patch: { binary: false, hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, context: "", lines: [" a", "-b", "+B", " c"] }] } });
    expect(await readPatch(s.wg, r, s.place, marks, { path: "big.txt" }, soon())).toEqual({ ok: false, why: "large", bytes: 1_200_000 });
    expect(statSync(join(s.repo, "many.txt")).size).toBe(1024 * 1024);
    expect(await readPatch(s.wg, r, s.place, marks, { path: "many.txt" }, soon())).toEqual({ ok: false, why: "large", bytes: 1024 * 1024 });
    rmSync(s.place.objects, { recursive: true, force: true });
    mkdirSync(s.place.objects, { mode: 0o700 });
    expect((await readPatch(s.wg, r, s.place, marks, { path: "src/a.ts" }, soon())).ok).toBe(false);
  });
  test("a rename with changed lines: one patch under its new name", async () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const s = repo({ "old.ts": body });
    const r = await repoAt(s);
    const t0 = (await takeMark(s.wg, r, s.place, soon()))!;
    unlinkSync(join(s.repo, "old.ts"));
    writeFileSync(join(s.repo, "new.ts"), body.replace("line 10", "line ten"));
    const t1 = (await takeMark(s.wg, r, s.place, soon()))!;
    const raw = (await diffMarks(s.wg, r, s.place, t0.tree, t1.tree, soon()))!;
    expect(raw.map((x) => [x.status, x.path, x.from])).toEqual([["R", "new.ts", "old.ts"]]);
    const p = await readPatch(s.wg, r, s.place, { from: t0.tree, to: t1.tree }, { path: "new.ts", from: "old.ts" }, soon());
    expect(p.ok && p.patch.hunks.flatMap((h) => h.lines).filter((l) => l[0] !== " ")).toEqual(["-line 10", "+line ten"]);
    expect(readFileSync(join(s.repo, "new.ts"), "utf8")).toContain("line ten");
  });
});

describe("review fixes", () => {
  test("a diff's read takes the path literally: [id].tsx is that file, not a pattern that also matches d.tsx", async () => {
    const s = repo({ "pages/[id].tsx": " one\n", "pages/d.tsx": "dee\n" });
    const r = await repoAt(s);
    const t0 = (await takeMark(s.wg, r, s.place, soon()))!;
    writeFileSync(join(s.repo, "pages/[id].tsx"), "ONE\n");
    writeFileSync(join(s.repo, "pages/d.tsx"), "the user own edit\n");
    const t1 = (await takeMark(s.wg, r, s.place, soon()))!;
    const p = await readPatch(s.wg, r, s.place, { from: t0.tree, to: t1.tree }, { path: "pages/[id].tsx" }, soon());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.patch.hunks.map((h) => h.lines)).toEqual([["- one", "+ONE"]]);
  });
  test("a file that became a folder: the old file's diff holds its own section alone", async () => {
    const s = repo({ "x": "file\n", "keep.md": "k\n" });
    const r = await repoAt(s);
    const t0 = (await takeMark(s.wg, r, s.place, soon()))!;
    unlinkSync(join(s.repo, "x"));
    mkdirSync(join(s.repo, "x"));
    writeFileSync(join(s.repo, "x", "inner.ts"), "inner\n");
    const t1 = (await takeMark(s.wg, r, s.place, soon()))!;
    const p = await readPatch(s.wg, r, s.place, { from: t0.tree, to: t1.tree }, { path: "x" }, soon());
    expect(p.ok && p.patch.hunks.map((h) => h.lines)).toEqual([["-file"]]);
  });
  test("a mark's private index and its pathspec file live in changes/<chat>/mark/, emptied before and after", async () => {
    const s = repo({ "a.ts": "a\n" });
    const r = await repoAt(s);
    // What a mark that a kill cut left: the index copy and git's lock.
    writeFileSync(join(s.place.work, "index"), "stale");
    writeFileSync(join(s.place.work, "index.lock"), "stale");
    expect(await takeMark(s.wg, r, s.place, soon())).not.toBeNull();
    expect(readdirSync(s.place.work)).toEqual([]);
    expect(readdirSync(s.place.dir).sort()).toEqual(["mark", "objects"]);
    expect(statSync(s.place.work).mode & 0o777).toBe(0o700);
    writeFileSync(join(s.place.work, "index"), "stale");
    await clearWork(s.place);
    expect(readdirSync(s.place.work)).toEqual([]);
  });
  test("too many untracked files, or too many bytes of them, take no mark (big); a few take one", async () => {
    const s = repo({ "a.ts": "a\n" });
    const r = await repoAt(s);
    mkdirSync(join(s.repo, "data"));
    for (let i = 0; i < 30; i++) writeFileSync(join(s.repo, "data", `f${i}.bin`), Buffer.alloc(40_000, i));
    const why: MarkWhy = {};
    // 30 files of 40 KB: over a cap of 1 MB of bytes, under one of 2 MB.
    expect(await takeMark(s.wg, r, s.place, soon(), undefined, why, { files: 100, bytes: 1_000_000 })).toBeNull();
    expect(why.why).toBe("big");
    expect(await takeMark(s.wg, r, s.place, soon(), undefined, why, { files: 20, bytes: 2_000_000 })).toBeNull();
    expect(why.why).toBe("big");
    expect(await takeMark(s.wg, r, s.place, soon(), undefined, why, { files: 100, bytes: 2_000_000 })).not.toBeNull();
    expect(why.why).toBeUndefined();
    // Nothing of the refused marks was hashed into the chat's objects: only the one mark that was taken wrote any.
  });
  test("a killed git's temporary objects are swept and counted until then", async () => {
    const s = repo({ "a.ts": "a\n" });
    const r = await repoAt(s);
    const before = (await objectBytes(s.wg, r, s.place, soon()))!;
    mkdirSync(join(s.place.objects, "ab"), { recursive: true });
    writeFileSync(join(s.place.objects, "ab", "tmp_obj_Xy12Ab"), Buffer.alloc(64 * 1024, 1));
    expect((await objectBytes(s.wg, r, s.place, soon()))!).toBeGreaterThanOrEqual(before + 64 * 1024);
    expect(await sweepObjects(s.place)).toBe(1);
    expect(existsSync(join(s.place.objects, "ab", "tmp_obj_Xy12Ab"))).toBe(false);
  });
});
