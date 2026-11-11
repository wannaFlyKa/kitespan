// The main checkout's local ignore of its worktrees (owner row 100; server/worktree/ignore.ts), on scratch
// repositories: without it a worktree at `.claude/worktrees/<name>` shows in `git status` and `git add -A` stages it as
// an embedded repository; kitespan asks git first and appends Claude Code's pattern to the repository's own
// `info/exclude` only, never a tracked file; the append never follows a link and refuses a file it cannot trust; the
// worktree is made whatever the ignore step says; a linked worktree of the user's own is never the main checkout here.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IGNORE_LINE, appendExclude, ignoreSkipLine, ignoreWorktrees } from "../../server/worktree/ignore";
import { makeWorktree, remakeWorktree, removeWorktree } from "../../server/worktree/ops";
import { commitAll, git, scratch, type Scratch } from "./worktree-repo";

const PROJECT = "k3m7q2x4ab";
const CHAT = "abcdefghijklmnopqrst";
// Each test runs real git several times; on a machine busy with other suites, Bun's 5 s default was seen to run out.
setDefaultTimeout(20_000);
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
const exclude = (s: Scratch) => join(s.repo, ".git", "info", "exclude");
const make = (s: Scratch, said: string[] = [], chatId = CHAT) =>
  makeWorktree(s.wg, { root: s.repo, data: s.data, projectId: PROJECT, chatId }, (l) => said.push(l));
const lines = (s: Scratch) => readFileSync(exclude(s), "utf8").split("\n").filter((l) => l === IGNORE_LINE).length;

describe("why (git 2.50, the lead's check)", () => {
  test("without the line, the main checkout shows the worktree and an add -A would stage it as an embedded repository", () => {
    const s = repo();
    const path = join(s.repo, ".claude", "worktrees", "abcdefgh");
    git(s.repo, "worktree", "add", "-q", "-b", "control", path);
    expect(git(s.repo, "status", "--porcelain")).toBe("?? .claude/\n");
    expect(git(s.repo, "add", "-A", "--dry-run")).toContain(".claude/worktrees/abcdefgh");
  });
});

describe("the line (row 100)", () => {
  test("Claude Code's pattern, appended to info/exclude before the add: status is clean and add -A stages nothing", async () => {
    const s = repo();
    const before = readFileSync(exclude(s), "utf8");
    const said: string[] = [];
    const r = await make(s, said);
    expect(r.ok).toBe(true);
    expect(IGNORE_LINE).toBe("**/.claude/worktrees/");
    expect(readFileSync(exclude(s), "utf8")).toBe(`${before}${before.endsWith("\n") ? "" : "\n"}${IGNORE_LINE}\n`);
    expect(git(s.repo, "status", "--porcelain")).toBe("");
    expect(git(s.repo, "add", "-A", "--dry-run")).toBe("");
    expect(git(s.repo, "check-ignore", "-v", "--no-index", ".claude/worktrees/abcdefgh/")).toContain(`.git/info/exclude:`);
    // No tracked file changes, and nothing was said.
    expect(existsSync(join(s.repo, ".gitignore"))).toBe(false);
    expect(said).toEqual([]);
  });

  test("written once: a second worktree and a remake add no second line", async () => {
    const s = repo();
    const a = await make(s);
    await make(s, [], "ddddddddeeeeeeeeffff");
    if (!a.ok) throw new Error("no worktree");
    expect(await removeWorktree(s.wg, a.worktree, false)).toBe(true);
    expect(await remakeWorktree(s.wg, a.worktree, s.data, PROJECT, () => {})).toBe(true);
    expect(lines(s)).toBe(1);
  });

  test("two Starts at once in one project write the line once", async () => {
    const s = repo();
    const [a, b] = await Promise.all([make(s), make(s, [], "ddddddddeeeeeeeeffff")]);
    expect(a.ok && b.ok).toBe(true);
    expect(lines(s)).toBe(1);
  });

  test("a user's later rule that turns the line back is kept: no second line, one line on the terminal", async () => {
    const s = repo();
    writeFileSync(exclude(s), `${IGNORE_LINE}\n!${IGNORE_LINE}\n`);
    const said: string[] = [];
    expect((await make(s, said)).ok).toBe(true);
    expect(readFileSync(exclude(s), "utf8")).toBe(`${IGNORE_LINE}\n!${IGNORE_LINE}\n`);
    expect(said).toEqual([ignoreSkipLine(exclude(s), "it has the line already, and a later rule turns it back")]);
  });

  test("a remake writes the line again when the user took it out", async () => {
    const s = repo();
    const a = await make(s);
    if (!a.ok) throw new Error("no worktree");
    expect(await removeWorktree(s.wg, a.worktree, false)).toBe(true);
    writeFileSync(exclude(s), "# mine\n");
    expect(await remakeWorktree(s.wg, a.worktree, s.data, PROJECT, () => {})).toBe(true);
    expect(readFileSync(exclude(s), "utf8")).toBe(`# mine\n${IGNORE_LINE}\n`);
    expect(git(s.repo, "status", "--porcelain")).toBe("");
  });

  test("a folder that git ignores already (a .gitignore line) gets no line", async () => {
    const s = repo();
    writeFileSync(join(s.repo, ".gitignore"), ".claude/worktrees/\n");
    commitAll(s.repo, "ignore the worktrees");
    const before = readFileSync(exclude(s), "utf8");
    expect(await ignoreWorktrees(s.wg, s.repo, "abcdefgh", () => {})).toBe("ignored");
    expect((await make(s)).ok).toBe(true);
    expect(readFileSync(exclude(s), "utf8")).toBe(before);
    expect(git(s.repo, "status", "--porcelain")).toBe("");
  });

  test("Claude Code's own runtime block counts as ignored", async () => {
    const s = repo();
    const block = "# claude-code-runtime\n**/.claude/scheduled_tasks.lock\n**/.claude/worktrees/\n";
    writeFileSync(exclude(s), block);
    expect(await ignoreWorktrees(s.wg, s.repo, "abcdefgh", () => {})).toBe("ignored");
    expect(readFileSync(exclude(s), "utf8")).toBe(block);
  });

  test("a file with no last newline gets one before the line; a missing info folder and file are made (0644)", async () => {
    const s = repo();
    writeFileSync(exclude(s), "# no newline");
    expect(await ignoreWorktrees(s.wg, s.repo, "abcdefgh", () => {})).toBe("added");
    expect(readFileSync(exclude(s), "utf8")).toBe(`# no newline\n${IGNORE_LINE}\n`);
    const t = repo();
    rmSync(join(t.repo, ".git", "info"), { recursive: true, force: true });
    expect(await ignoreWorktrees(t.wg, t.repo, "abcdefgh", () => {})).toBe("added");
    expect(readFileSync(exclude(t), "utf8")).toBe(`${IGNORE_LINE}\n`);
    expect(lstatSync(exclude(t)).mode & 0o777).toBe(0o644 & ~process.umask());
    expect(lstatSync(join(t.repo, ".git", "info")).isDirectory()).toBe(true);
  });
});

describe("what the line does not do (git's own rules)", () => {
  test("a single -f clean never deletes a worktree; clean -ffdx does, and Make it again brings it back from its branch", async () => {
    const s = repo();
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    const w = r.worktree;
    writeFileSync(join(w.path, "work.txt"), "kept on the branch\n");
    const tip = commitAll(w.path, "work");
    git(s.repo, "clean", "-fdx");
    expect(existsSync(join(w.path, "work.txt"))).toBe(true);
    git(s.repo, "clean", "-ffdx");
    expect(existsSync(w.path)).toBe(false);
    // git keeps the registration as prunable; the branch and its commit stay.
    expect(git(s.repo, "worktree", "list", "--porcelain")).toContain("prunable");
    expect(await remakeWorktree(s.wg, w, s.data, PROJECT, () => {})).toBe(true);
    expect(git(w.path, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(git(s.repo, "status", "--porcelain")).toBe("");
  });
});

describe("a skip: one line on the server's terminal, and the worktree is made all the same", () => {
  const cases: [string, (s: Scratch) => string, string][] = [
    [
      "an exclude that is a link",
      (s) => {
        const target = join(s.root, "target-exclude");
        writeFileSync(target, "# elsewhere\n");
        rmSync(exclude(s));
        symlinkSync(target, exclude(s));
        return target;
      },
      "it is a symlink",
    ],
    [
      "an exclude with a second hard link",
      (s) => {
        const other = join(s.root, "hard-link");
        linkSync(exclude(s), other);
        return other;
      },
      "it has more than one hard link",
    ],
    [
      "an exclude over 1 MiB",
      (s) => {
        writeFileSync(exclude(s), `# ${"x".repeat(1024 * 1024)}\n`);
        return exclude(s);
      },
      "it is larger than 1 MiB",
    ],
    [
      "an info folder that is a link",
      (s) => {
        const real = join(s.root, "real-info");
        mkdirSync(real);
        writeFileSync(join(real, "exclude"), "# elsewhere\n");
        rmSync(join(s.repo, ".git", "info"), { recursive: true, force: true });
        symlinkSync(real, join(s.repo, ".git", "info"));
        return join(real, "exclude");
      },
      "its parent folder is a link or not a folder",
    ],
  ];
  for (const [what, set, reason] of cases)
    test(`${what}: "${reason}"`, async () => {
      const s = repo();
      const watched = set(s);
      const was = readFileSync(watched, "utf8");
      const said: string[] = [];
      const r = await make(s, said);
      expect(r.ok).toBe(true);
      expect(said).toEqual([ignoreSkipLine(exclude(s), reason)]);
      expect(readFileSync(watched, "utf8")).toBe(was);
    });

  test("the line's words", () => {
    expect(ignoreSkipLine("/r/.git/info/exclude", "it is a symlink")).toBe(
      "Not adding ignore rules for kitespan's worktrees to /r/.git/info/exclude: it is a symlink. They may show as untracked in git status.",
    );
  });

  test("a git that cannot answer: nothing is written, one line", async () => {
    const s = repo();
    const before = readFileSync(exclude(s), "utf8");
    const said: string[] = [];
    expect(await ignoreWorktrees({ ...s.wg, git: null }, s.repo, "abcdefgh", (l) => said.push(l))).toEqual({ skipped: "git could not say whether the folder is ignored" });
    expect(said).toHaveLength(1);
    expect(readFileSync(exclude(s), "utf8")).toBe(before);
  });

  test("appendExclude opens nothing through a link (the direct call)", () => {
    const s = repo();
    const target = join(s.root, "t");
    writeFileSync(target, "");
    rmSync(exclude(s));
    symlinkSync(target, exclude(s));
    expect(appendExclude(join(s.repo, ".git"), IGNORE_LINE)).toBe("it is a symlink");
    expect(readFileSync(target, "utf8")).toBe("");
  });
});

describe("a linked worktree of the user's own (W12) is never the main checkout", () => {
  test("no worktree is made from it, and no exclude of the repository changes", async () => {
    const s = repo();
    const linked = join(s.root, "users-own");
    git(s.repo, "worktree", "add", "-q", "-b", "users-own", linked);
    const before = readFileSync(exclude(s), "utf8");
    expect(await makeWorktree(s.wg, { root: linked, data: s.data, projectId: PROJECT, chatId: CHAT }, () => {})).toEqual({ ok: false, why: "not_top" });
    expect(readFileSync(exclude(s), "utf8")).toBe(before);
    expect(existsSync(join(linked, ".claude"))).toBe(false);
  });
});
