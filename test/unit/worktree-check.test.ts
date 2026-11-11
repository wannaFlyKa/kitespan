// The check before every start of a worktree chat (build checklist W4) and the gate's reads of it (G4): file reads
// only. A real linked worktree passes, also with git's relative paths; a gone one, a link to one, a worktree of
// another repository and a folder that only looks like one fail.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { linkedRootOf, worktreeHere } from "../../server/worktree/check";
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

describe("W4: a linked worktree of the project's folder, by file reads", () => {
  test("a worktree that git added passes; the main checkout itself is no linked worktree", () => {
    const s = repo();
    const wt = join(s.root, "wt");
    git(s.repo, "worktree", "add", "-q", "-b", "kitespan/abcdefgh", wt);
    expect(linkedRootOf(wt)).toBe(s.repo);
    expect(worktreeHere(wt, s.repo)).toBe(true);
    expect(linkedRootOf(s.repo)).toBeNull();
    expect(worktreeHere(s.repo, s.repo)).toBe(false);
  });

  test("git's relative paths (worktree.useRelativePaths) pass too", () => {
    const s = repo();
    const wt = join(s.root, "rel");
    git(s.repo, "-c", "worktree.useRelativePaths=true", "worktree", "add", "-q", "-b", "kitespan/rel", wt);
    expect(worktreeHere(wt, s.repo)).toBe(true);
  });

  test("a gone worktree, a moved one and a link to one fail", () => {
    const s = repo();
    const wt = join(s.root, "wt");
    git(s.repo, "worktree", "add", "-q", "-b", "x", wt);
    const moved = join(s.root, "moved");
    renameSync(wt, moved);
    expect(worktreeHere(wt, s.repo)).toBe(false);
    // Its admin folder's gitdir still names the old place.
    expect(worktreeHere(moved, s.repo)).toBe(false);
    symlinkSync(moved, wt);
    expect(worktreeHere(wt, s.repo)).toBe(false);
  });

  test("a worktree of another repository is not this project's", () => {
    const s = repo();
    const other = repo();
    const wt = join(other.root, "wt");
    git(other.repo, "worktree", "add", "-q", "-b", "x", wt);
    expect(worktreeHere(wt, other.repo)).toBe(true);
    expect(worktreeHere(wt, s.repo)).toBe(false);
  });

  test("a folder that only looks like one: a .git file that points in, with no gitdir that points back", () => {
    const s = repo();
    const fake = join(s.root, "fake");
    mkdirSync(fake);
    const admin = join(s.repo, ".git", "worktrees", "fake");
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(fake, ".git"), `gitdir: ${admin}\n`);
    expect(worktreeHere(fake, s.repo)).toBe(false);
    writeFileSync(join(admin, "gitdir"), `${join(s.root, "elsewhere", ".git")}\n`);
    expect(worktreeHere(fake, s.repo)).toBe(false);
    // A .git file that points outside `<root>/.git/worktrees`.
    writeFileSync(join(fake, ".git"), `gitdir: ${join(s.repo, ".git")}\n`);
    expect(worktreeHere(fake, s.repo)).toBe(false);
    // A .git link instead of a file.
    const linked = join(s.root, "linked");
    mkdirSync(linked);
    symlinkSync(join(fake, ".git"), join(linked, ".git"));
    expect(linkedRootOf(linked)).toBeNull();
  });
});
