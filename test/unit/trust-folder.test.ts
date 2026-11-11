// R127: what the server checks of a folder before a trust start, and the repository root that the confirm names
// (server/chats/trust-folder.ts; DESIGN-R127 7.1 and 7.3). File reads only: the repositories here are made by git in a
// scratch folder (worktree-repo.ts, with no system or global git config), and the walk itself never runs git.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkFolder, folderRef, homeRefusal, repoOf, repoRootOf } from "../../server/chats/trust-folder";
import { git, scratch, type Scratch } from "./worktree-repo";

let open: Scratch[] = [];
afterEach(() => {
  for (const s of open) s.cleanup();
  open = [];
});
const repo = () => {
  const s = scratch();
  open.push(s);
  return s;
};

describe("repoRootOf and folderRef", () => {
  test("the repository's own folder keys on itself: no root to name", () => {
    const s = repo();
    expect(repoRootOf(s.repo)).toBe(s.repo);
    expect(folderRef(s.repo)).toEqual({ path: s.repo, root: null });
  });

  test("a plain folder inside the repository names the repository", () => {
    const s = repo();
    const sub = join(s.repo, "tasks", "search-index");
    mkdirSync(sub, { recursive: true });
    expect(folderRef(sub)).toEqual({ path: sub, root: s.repo });
  });

  test("a repository nested inside another keys on itself (the owner's case)", () => {
    const s = repo();
    const nested = join(s.repo, "tasks", "remove-negative-qty");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    expect(folderRef(nested)).toEqual({ path: nested, root: null });
  });

  test("a linked worktree names its main checkout", () => {
    const s = repo();
    const wt = join(s.root, "wt");
    git(s.repo, "worktree", "add", "-q", "-b", "kitespan/trust", wt);
    expect(folderRef(wt)).toEqual({ path: wt, root: s.repo });
    const inside = join(wt, "src");
    mkdirSync(inside, { recursive: true });
    expect(folderRef(inside)).toEqual({ path: inside, root: s.repo });
  });

  test("a linked worktree of a bare repository names the bare repository's folder (Claude Code's key: the common dir)", () => {
    const s = repo();
    const bare = join(s.root, "proj.git");
    git(s.root, "clone", "-q", "--bare", s.repo, bare);
    const wt = join(s.root, "proj", "main");
    git(bare, "worktree", "add", "-q", "-b", "kitespan/trust", wt);
    expect(git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir").trim()).toBe(bare);
    expect(folderRef(wt)).toEqual({ path: wt, root: bare });
    const inside = join(wt, "pkg");
    mkdirSync(inside, { recursive: true });
    expect(folderRef(inside)).toEqual({ path: inside, root: bare });
    // The worktree is the top that holds the `.git` file; the key is the bare repository (the home check reads both).
    expect(repoOf(inside)).toEqual({ top: wt, root: bare });
    expect(repoOf(s.repo)).toEqual({ top: s.repo, root: s.repo });
  });

  test("a bare repository's common dir that holds a .git of its own: Claude Code keys on the worktree itself", () => {
    const s = repo();
    const bare = join(s.root, "proj.git");
    git(s.root, "clone", "-q", "--bare", s.repo, bare);
    const wt = join(s.root, "proj", "main");
    git(bare, "worktree", "add", "-q", "-b", "kitespan/trust", wt);
    mkdirSync(join(bare, ".git"));
    expect(folderRef(wt)).toEqual({ path: wt, root: null });
    const inside = join(wt, "pkg");
    mkdirSync(inside, { recursive: true });
    expect(folderRef(inside)).toEqual({ path: inside, root: wt });
  });

  test("a worktree whose admin folder does not point back, or whose commondir is missing, keys on itself", () => {
    const s = repo();
    const wt = join(s.root, "wt");
    git(s.repo, "worktree", "add", "-q", "-b", "kitespan/trust", wt);
    const admin = join(s.repo, ".git", "worktrees", "wt");
    writeFileSync(join(admin, "gitdir"), `${join(s.root, "elsewhere", ".git")}\n`);
    expect(folderRef(wt)).toEqual({ path: wt, root: null });
    writeFileSync(join(admin, "gitdir"), `${join(wt, ".git")}\n`);
    expect(folderRef(wt)).toEqual({ path: wt, root: s.repo });
    rmSync(join(admin, "commondir"));
    expect(folderRef(wt)).toEqual({ path: wt, root: null });
  });

  test("a .git file that is no linked worktree's (a submodule's form) keys on its own folder", () => {
    const s = repo();
    const sub = join(s.root, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, ".git"), `gitdir: ${join(s.repo, ".git", "modules", "sub")}\n`);
    expect(repoRootOf(sub)).toBe(sub);
    expect(folderRef(sub)).toEqual({ path: sub, root: null });
  });

  test("a .git that is a link stops the walk with no root; so does no .git up to the root", () => {
    const s = repo();
    const odd = join(s.root, "odd");
    mkdirSync(join(odd, "inner"), { recursive: true });
    symlinkSync(join(s.repo, ".git"), join(odd, ".git"));
    expect(repoRootOf(join(odd, "inner"))).toBeNull();
    const plain = join(s.root, "plain", "x");
    mkdirSync(plain, { recursive: true });
    expect(repoRootOf(plain)).toBeNull();
    expect(repoRootOf("relative/path")).toBeNull();
  });

  test("a folder that is not there walks up from where it would be", () => {
    const s = repo();
    expect(folderRef(join(s.repo, "gone", "deeper"))).toEqual({ path: join(s.repo, "gone", "deeper"), root: s.repo });
  });
});

describe("checkFolder", () => {
  test("a real folder by its real path; gone; a link at its end or in a part of it; a file", () => {
    const s = repo();
    const dir = join(s.root, "dir");
    mkdirSync(join(dir, "in"), { recursive: true });
    symlinkSync(dir, join(s.root, "ln"));
    writeFileSync(join(s.root, "file"), "x");
    expect(checkFolder(dir)).toEqual({ ok: true });
    expect(checkFolder(join(s.root, "nothing"))).toEqual({ gone: true });
    expect(checkFolder(join(s.root, "file", "below"))).toEqual({ gone: true });
    expect(checkFolder(join(s.root, "ln"))).toEqual({ refused: "link" });
    expect(checkFolder(join(s.root, "ln", "in"))).toEqual({ refused: "link" });
    expect(checkFolder(join(s.root, "file"))).toEqual({ refused: "not_folder" });
    expect(checkFolder(`${dir}/`)).toEqual({ refused: "link" });
  });
});

describe("homeRefusal", () => {
  test("the home folder by either of its names; a folder that holds one, the root among them; a folder under it is fine", () => {
    const homes = ["/srv/you", "/local/disk/you"];
    expect(homeRefusal("/srv/you", homes)).toBe("home");
    expect(homeRefusal("/local/disk/you", homes)).toBe("home");
    expect(homeRefusal("/srv", homes)).toBe("holds_home");
    expect(homeRefusal("/local", homes)).toBe("holds_home");
    expect(homeRefusal("/", homes)).toBe("holds_home");
    expect(homeRefusal("/srv/you/projects/shop", homes)).toBeNull();
    expect(homeRefusal("/srv/yours", homes)).toBeNull();
  });
});
