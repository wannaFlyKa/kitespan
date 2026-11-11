// kitespan's own worktree git (build checklist W1, W3, W7, W9, W13, L22 to L26, L30, L33; owner row 100), on scratch
// repositories: no hook and no filter driver of the repository runs (each would write a marker outside the
// repository), a config that could run a program is refused, the place in the project's `.claude/worktrees` and its
// link rule, the names and the base, the real path, the removal rules, a worktree made before row 100 under the data
// folder, and `.worktreeinclude`.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { linkedRootOf, worktreeHere } from "../../server/worktree/check";
import { filterArgs, readRepoConfig, runWorktreeGit, worktreeGit } from "../../server/worktree/git";
import { copyIncludes } from "../../server/worktree/include";
import { WORKTREE_OFF_LINES, branchStays, dropBranch, makeWorktree, remakeWorktree, removeWorktree, worktreeChanges, worktreeOff } from "../../server/worktree/ops";
import { dataHome, projectRecords, worktreeName } from "../../server/worktree/place";
import { GIT_TEST_ENV, branches, commitAll, git, gitOk, scratch, type Scratch } from "./worktree-repo";

const PROJECT = "k3m7q2x4ab";
const CHAT = "abcdefghijklmnopqrst";
let open: Scratch[] = [];
afterEach(() => {
  for (const s of open) s.cleanup();
  open = [];
});
const repo = (opts?: { empty?: boolean }) => {
  const s = scratch(opts);
  open.push(s);
  return s;
};
const quiet = () => {};
const make = (s: Scratch, chatId = CHAT) => makeWorktree(s.wg, { root: s.repo, data: s.data, projectId: PROJECT, chatId }, quiet);
const inRepo = (s: Scratch, name: string) => join(s.repo, ".claude", "worktrees", name);

describe("no program of the repository runs (W1)", () => {
  test("a post-checkout hook writes no marker at worktree add, though a plain checkout runs it", async () => {
    const s = repo();
    const marker = join(s.root, "hook-marker");
    const hook = join(s.repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\n`);
    chmodSync(hook, 0o755);
    const r = await make(s);
    expect(r.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    // The control: git's own add runs the hook.
    git(s.repo, "worktree", "add", "-q", join(s.root, "control"), "-b", "control");
    expect(existsSync(marker)).toBe(true);
  });

  test("a filter driver of the repository's config writes no marker, and the file is checked out as it is", async () => {
    const s = repo();
    const marker = join(s.root, "filter-marker");
    writeFileSync(join(s.repo, ".gitattributes"), "*.txt filter=mark\n");
    writeFileSync(join(s.repo, "a.txt"), "plain text\n");
    commitAll(s.repo, "with a filter");
    git(s.repo, "config", "filter.mark.smudge", `sh -c 'echo ran >> ${marker}; cat'`);
    git(s.repo, "config", "filter.mark.clean", `sh -c 'echo ran >> ${marker}; cat'`);
    git(s.repo, "config", "filter.mark.required", "true");
    // The control first: git's own add runs the smudge filter.
    git(s.repo, "worktree", "add", "-q", join(s.root, "control"), "-b", "control");
    expect(existsSync(marker)).toBe(true);
    writeFileSync(marker, "");
    const r = await make(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readFileSync(join(r.worktree.path, "a.txt"), "utf8")).toBe("plain text\n");
    // A status with a changed file would run the clean filter too.
    writeFileSync(join(r.worktree.path, "a.txt"), "changed\n");
    expect(await worktreeChanges(s.wg, r.worktree)).toBe(1);
    expect(readFileSync(marker, "utf8")).toBe("");
    expect(filterArgs(["mark"])).toEqual(["-c", "filter.mark.smudge=", "-c", "filter.mark.clean=", "-c", "filter.mark.process=", "-c", "filter.mark.required=false"]);
  });

  test("an inherited GIT_DIR does not move kitespan's git to another repository", async () => {
    const s = repo();
    const other = repo();
    const wg = worktreeGit({ ...process.env, GIT_DIR: join(other.repo, ".git"), GIT_WORK_TREE: other.repo }, GIT_TEST_ENV);
    expect(Object.keys(wg.env).filter((k) => k === "GIT_DIR" || k === "GIT_WORK_TREE")).toEqual([]);
    expect(wg.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
    expect(wg.env.GIT_TERMINAL_PROMPT).toBe("0");
    const r = await makeWorktree(wg, { root: s.repo, data: s.data, projectId: PROJECT, chatId: CHAT }, quiet);
    expect(r.ok).toBe(true);
    expect(branches(s.repo)).toContain("kitespan/abcdefgh");
    expect(branches(other.repo)).toEqual(["main"]);
  });
});

describe("a config that could run a program gets no worktree (W1)", () => {
  for (const [what, set] of [
    ["includeIf", (r: string) => git(r, "config", "includeIf.gitdir:/nowhere/.path", "/nowhere/config")],
    ["a custom LFS transfer", (r: string) => git(r, "config", "lfs.customtransfer.x.path", "/bin/true")],
    ["a standalone LFS transfer agent", (r: string) => git(r, "config", "lfs.standalonetransferagent", "x")],
    [
      "a filter name with =",
      (r: string) => {
        const cfg = join(r, ".git", "config");
        writeFileSync(cfg, `${readFileSync(cfg, "utf8")}[filter "a=b"]\n\tsmudge = cat\n`);
      },
    ],
  ] as const)
    test(`${what} is refused, with its one reason`, async () => {
      const s = repo();
      set(s.repo);
      expect((await readRepoConfig(s.wg, s.repo))?.refused).toBe(true);
      expect(await worktreeOff(s.wg, s.repo)).toBe("config");
      const r = await make(s);
      expect(r).toEqual({ ok: false, why: "config" });
      expect(branches(s.repo)).toEqual(["main"]);
      expect(existsSync(join(s.data, "kitespan"))).toBe(false);
      expect(existsSync(join(s.repo, ".claude"))).toBe(false);
    });

  test("an includeIf in a file the config includes is refused too", async () => {
    const s = repo();
    const extra = join(s.root, "extra.config");
    writeFileSync(extra, '[includeIf "gitdir:/nowhere/"]\n\tpath = /nowhere/config\n');
    git(s.repo, "config", "include.path", extra);
    expect(await worktreeOff(s.wg, s.repo)).toBe("config");
  });
});

describe("where Worktree is off (L33)", () => {
  test("a folder that is no git repository, a repository's subfolder or linked worktree, a repository with no commit", async () => {
    const s = repo();
    const plain = join(s.root, "plain");
    mkdirSync(plain);
    mkdirSync(join(s.repo, "sub"));
    const linked = join(s.root, "linked");
    git(s.repo, "worktree", "add", "-q", "-b", "users-own", linked);
    expect(await worktreeOff(s.wg, plain)).toBe("not_git");
    // In a repository, but not the top folder of its main checkout: a reason of its own, with true words.
    expect(await worktreeOff(s.wg, join(s.repo, "sub"))).toBe("not_top");
    expect(await worktreeOff(s.wg, linked)).toBe("not_top");
    expect(WORKTREE_OFF_LINES.not_top).toBe("kitespan makes worktrees only from the top folder of a repository's main checkout.");
    expect(await worktreeOff(s.wg, s.repo)).toBeNull();
    const e = repo({ empty: true });
    expect(await worktreeOff(e.wg, e.repo)).toBe("no_commit");
    expect(await worktreeOff({ ...s.wg, git: null }, s.repo)).toBe("not_git");
  });
});

describe("the add (W3, L22, L23, L24, W13, row 100)", () => {
  test("from the main checkout's local HEAD, in the project's .claude/worktrees, on kitespan/<8 symbols>, at its real path", async () => {
    const s = repo();
    const r = await make(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.worktree;
    expect(w).toEqual({ path: inRepo(s, "abcdefgh"), root: s.repo, branch: "kitespan/abcdefgh", baseRef: "refs/heads/main", baseCommit: s.head! });
    expect(git(w.path, "rev-parse", "HEAD").trim()).toBe(s.head!);
    expect(git(w.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("kitespan/abcdefgh");
    // --no-track: the branch has no upstream.
    expect(gitOk(w.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(false);
    expect(worktreeHere(w.path, s.repo)).toBe(true);
    expect(linkedRootOf(w.path)).toBe(s.repo);
    // Nothing new in the user's checkout (the local ignore, worktree-ignore.test.ts), and the record in the making is
    // in the data folder, never in the repository.
    expect(git(s.repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(s.data, "kitespan", "worktrees", PROJECT, "abcdefgh.making"))).toBe(true);
    expect(existsSync(`${w.path}.making`)).toBe(false);
  });

  test("the two folders are made with the umask's mode when missing, and stay after the worktree goes", async () => {
    const s = repo();
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    const mask = process.umask();
    for (const p of [join(s.repo, ".claude"), join(s.repo, ".claude", "worktrees")]) expect(lstatSync(p).mode & 0o777).toBe(0o777 & ~mask);
    expect(await removeWorktree(s.wg, r.worktree, false)).toBe(true);
    expect(lstatSync(join(s.repo, ".claude", "worktrees")).isDirectory()).toBe(true);
  });

  test("a taken folder or branch gives -2, then -3", async () => {
    const s = repo();
    git(s.repo, "branch", "kitespan/abcdefgh");
    mkdirSync(inRepo(s, "abcdefgh-2"), { recursive: true });
    const r = await make(s);
    expect(r.ok && r.worktree.branch).toBe("kitespan/abcdefgh-3");
    expect(r.ok && r.worktree.path).toBe(inRepo(s, "abcdefgh-3"));
    expect(worktreeName(CHAT, 1)).toBe("abcdefgh");
  });

  test("a name whose record in the making is in the data folder is taken", async () => {
    const s = repo();
    const records = projectRecords(s.data, PROJECT)!;
    writeFileSync(join(records, "abcdefgh.making"), "{}");
    const r = await make(s);
    expect(r.ok && r.worktree.path).toBe(inRepo(s, "abcdefgh-2"));
  });

  test("two chats get two worktrees on two branches", async () => {
    const s = repo();
    const a = await make(s, "aaaaaaaabbbbbbbbcccc");
    const b = await make(s, "ddddddddeeeeeeeeffff");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.worktree.path).not.toBe(b.worktree.path);
    expect(branches(s.repo)).toEqual(["kitespan/aaaaaaaa", "kitespan/dddddddd", "main"]);
  });

  test("a data folder reached through a link gets the record at its real path (W13)", async () => {
    const s = repo();
    const real = join(s.root, "real-data");
    mkdirSync(real);
    const link = join(s.root, "data-link");
    symlinkSync(real, link);
    const r = await makeWorktree(s.wg, { root: s.repo, data: link, projectId: PROJECT, chatId: CHAT }, quiet);
    expect(r.ok && r.worktree.path).toBe(inRepo(s, "abcdefgh"));
    expect(existsSync(join(real, "kitespan", "worktrees", PROJECT, "abcdefgh.making"))).toBe(true);
    expect(dataHome({ XDG_DATA_HOME: "relative/path" }, "/srv/u")).toBe("/srv/u/.local/share");
    expect(dataHome({ XDG_DATA_HOME: "/x/data" }, "/srv/u")).toBe("/x/data");
  });

  test("a link in place of a folder that kitespan makes in its data folder refuses the worktree", async () => {
    const s = repo();
    mkdirSync(join(s.data, "kitespan"), { recursive: true });
    const elsewhere = join(s.root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(s.data, "kitespan", "worktrees"));
    expect(projectRecords(s.data, PROJECT)).toBeNull();
    expect(await make(s)).toEqual({ ok: false, why: "failed" });
    expect(branches(s.repo)).toEqual(["main"]);
    expect(existsSync(join(s.repo, ".claude"))).toBe(false);
  });
});

describe("the link rule (row 100)", () => {
  const elsewhere = (s: Scratch) => {
    const p = join(s.root, "elsewhere");
    mkdirSync(p, { recursive: true });
    return p;
  };
  for (const [what, set] of [
    ["a .claude that is a link", (s: Scratch) => symlinkSync(elsewhere(s), join(s.repo, ".claude"))],
    [
      "a .claude/worktrees that is a link",
      (s: Scratch) => {
        mkdirSync(join(s.repo, ".claude"));
        symlinkSync(elsewhere(s), join(s.repo, ".claude", "worktrees"));
      },
    ],
    ["a .claude that is a file", (s: Scratch) => writeFileSync(join(s.repo, ".claude"), "x")],
    [
      "a .claude/worktrees that is a file",
      (s: Scratch) => {
        mkdirSync(join(s.repo, ".claude"));
        writeFileSync(join(s.repo, ".claude", "worktrees"), "x");
      },
    ],
    ["a dangling link in place of .claude", (s: Scratch) => symlinkSync(join(s.root, "nowhere"), join(s.repo, ".claude"))],
  ] as const)
    test(`${what} gets no worktree, with its one line, and nothing is made behind it`, async () => {
      const s = repo();
      set(s);
      expect(await worktreeOff(s.wg, s.repo)).toBe("link");
      expect(await make(s)).toEqual({ ok: false, why: "link" });
      expect(branches(s.repo)).toEqual(["main"]);
      expect(existsSync(join(s.root, "elsewhere", "worktrees"))).toBe(false);
      expect(existsSync(join(s.root, "elsewhere", "abcdefgh"))).toBe(false);
      expect(existsSync(join(s.repo, ".git", "info", "exclude")) && readFileSync(join(s.repo, ".git", "info", "exclude"), "utf8").includes("worktrees")).toBe(false);
    });

  test("its line, in the style of the others", () => {
    expect(WORKTREE_OFF_LINES.link).toBe("This repository's .claude or .claude/worktrees is a symbolic link or not a folder, so kitespan makes no worktree here.");
  });

  test("a link in place of the worktree's own folder is skipped for the next name, and its target stays as it was", async () => {
    const s = repo();
    mkdirSync(join(s.repo, ".claude", "worktrees"), { recursive: true });
    const target = elsewhere(s);
    symlinkSync(target, inRepo(s, "abcdefgh"));
    expect(await worktreeOff(s.wg, s.repo)).toBeNull();
    const r = await make(s);
    expect(r.ok && r.worktree.path).toBe(inRepo(s, "abcdefgh-2"));
    expect(existsSync(join(target, "README.md"))).toBe(false);
  });

  test("a .claude folder of the repository's own (tracked files in it) is fine", async () => {
    const s = repo();
    mkdirSync(join(s.repo, ".claude", "commands"), { recursive: true });
    writeFileSync(join(s.repo, ".claude", "commands", "hello.md"), "Say hello.\n");
    commitAll(s.repo, "a command");
    const r = await make(s);
    expect(r.ok && r.worktree.path).toBe(inRepo(s, "abcdefgh"));
    expect(git(s.repo, "status", "--porcelain")).toBe("");
  });

  // The top of another git working tree at .claude or .claude/worktrees: the worktree would land in that repository,
  // which the project's own local ignore does not reach (its status would show it, and its `add -A` would stage it).
  const ownRepo = (at: string) => {
    mkdirSync(at, { recursive: true });
    git(at, "init", "-q");
    writeFileSync(join(at, "settings.json"), "{}\n");
    commitAll(at, "shared settings");
  };
  for (const [what, set, nested] of [
    [
      "a .claude that is a submodule",
      (s: Scratch) => {
        const shared = join(s.root, "shared-claude");
        ownRepo(shared);
        git(s.repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", shared, ".claude");
        commitAll(s.repo, "add .claude as a submodule");
      },
      ".claude",
    ],
    [
      "a .claude that is a clone the project ignores",
      (s: Scratch) => {
        writeFileSync(join(s.repo, ".gitignore"), ".claude/\n");
        commitAll(s.repo, "ignore .claude");
        ownRepo(join(s.repo, ".claude"));
      },
      ".claude",
    ],
    ["a .claude/worktrees that is a repository of its own", (s: Scratch) => ownRepo(join(s.repo, ".claude", "worktrees")), ".claude/worktrees"],
  ] as const)
    test(`${what} gets no worktree, with its one line, and that repository is not changed`, async () => {
      const s = repo();
      set(s);
      const before = git(s.repo, "status", "--porcelain");
      expect(await worktreeOff(s.wg, s.repo)).toBe("nested");
      expect(await make(s)).toEqual({ ok: false, why: "nested" });
      expect(branches(s.repo)).toEqual(["main"]);
      expect(existsSync(inRepo(s, "abcdefgh"))).toBe(false);
      expect(git(join(s.repo, nested), "status", "--porcelain")).toBe("");
      expect(git(s.repo, "status", "--porcelain")).toBe(before);
    });

  test("a .claude that became another repository's working tree since: Make it again refuses, and makes nothing there", async () => {
    const s = repo();
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    expect(await removeWorktree(s.wg, r.worktree, false)).toBe(true);
    git(join(s.repo, ".claude"), "init", "-q");
    expect(await remakeWorktree(s.wg, r.worktree, s.data, PROJECT, quiet)).toBe(false);
    expect(existsSync(r.worktree.path)).toBe(false);
  });

  test("the nested line, in the style of the others", () => {
    expect(WORKTREE_OFF_LINES.nested).toBe("This repository's .claude or .claude/worktrees is another git repository, so kitespan makes no worktree here.");
  });
});

describe("a worktree at the path that Archive freed (row 100)", () => {
  test("Make it again takes one there only on the chat's own branch; one on another branch is taken, and stays as it is", async () => {
    const s = repo();
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    const w = { ...r.worktree, removed: true as const };
    expect(await removeWorktree(s.wg, w, false)).toBe(true);
    // Another tool's worktree at the freed name (the CLI's `claude -w <name>` uses worktree-<name>).
    git(s.repo, "worktree", "add", "-q", "-b", "worktree-abcdefgh", w.path);
    expect(await remakeWorktree(s.wg, w, s.data, PROJECT, quiet)).toBe(false);
    expect(git(w.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("worktree-abcdefgh");
    // Without Archive's mark (the chat's own worktree, whose branch Claude Code may have switched) it is the chat's.
    expect(await remakeWorktree(s.wg, r.worktree, s.data, PROJECT, quiet)).toBe(true);
    git(s.repo, "worktree", "remove", w.path);
    git(s.repo, "worktree", "add", "-q", w.path, w.branch);
    expect(await remakeWorktree(s.wg, w, s.data, PROJECT, quiet)).toBe(true);
  });
});

describe("archive, unarchive and delete (W7, W8, W9, L25, L26)", () => {
  test("a clean worktree goes without --force; one with changes stays until --force", async () => {
    const s = repo();
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    const w = r.worktree;
    expect(await worktreeChanges(s.wg, w)).toBe(0);
    writeFileSync(join(w.path, "new.txt"), "x");
    writeFileSync(join(w.path, "README.md"), "changed\n");
    expect(await worktreeChanges(s.wg, w)).toBe(2);
    expect(await removeWorktree(s.wg, w, false)).toBe(false);
    expect(existsSync(join(w.path, "new.txt"))).toBe(true);
    expect(await removeWorktree(s.wg, w, true)).toBe(true);
    expect(existsSync(w.path)).toBe(false);
    // The branch stays with the worktree's removal.
    expect(branches(s.repo)).toContain("kitespan/abcdefgh");
    expect(await worktreeChanges(s.wg, w)).toBeNull();
  });

  test("a rename counts once", async () => {
    const s = repo();
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    git(r.worktree.path, "mv", "README.md", "READ.md");
    expect(await worktreeChanges(s.wg, r.worktree)).toBe(1);
  });

  test("a link in place of the worktree is never handed to git, and nothing behind it goes", async () => {
    const s = repo();
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    const w = r.worktree;
    const moved = join(s.root, "moved");
    renameSync(w.path, moved);
    symlinkSync(moved, w.path);
    expect(linkedRootOf(w.path)).toBeNull();
    expect(await removeWorktree(s.wg, w, true)).toBe(false);
    expect(existsSync(join(moved, "README.md"))).toBe(true);
  });

  test("made again from its branch (W8), with the branch's commits", async () => {
    const s = repo();
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    const w = r.worktree;
    writeFileSync(join(w.path, "work.txt"), "kept on the branch\n");
    const tip = commitAll(w.path, "work");
    expect(await removeWorktree(s.wg, w, false)).toBe(true);
    expect(await remakeWorktree(s.wg, w, s.data, PROJECT, quiet)).toBe(true);
    // Its record in the making (pending.ts) went once the add was done.
    expect(existsSync(join(s.data, "kitespan", "worktrees", PROJECT, "abcdefgh.making"))).toBe(false);
    expect(git(w.path, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(readFileSync(join(w.path, "work.txt"), "utf8")).toBe("kept on the branch\n");
    // A gone branch cannot be made again.
    expect(await removeWorktree(s.wg, w, false)).toBe(true);
    git(s.repo, "branch", "-D", w.branch);
    expect(await remakeWorktree(s.wg, w, s.data, PROJECT, quiet)).toBe(false);
  });

  test("a remake in the project's folder keeps the link rule, and one at neither place is refused", async () => {
    const s = repo();
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    const w = r.worktree;
    expect(await removeWorktree(s.wg, w, false)).toBe(true);
    renameSync(join(s.repo, ".claude"), join(s.root, "moved-claude"));
    symlinkSync(join(s.root, "moved-claude"), join(s.repo, ".claude"));
    expect(await remakeWorktree(s.wg, w, s.data, PROJECT, quiet)).toBe(false);
    expect(existsSync(join(s.root, "moved-claude", "worktrees", "abcdefgh"))).toBe(false);
    const stray = { ...w, path: join(s.root, "stray", "abcdefgh") };
    expect(await remakeWorktree(s.wg, stray, s.data, PROJECT, quiet)).toBe(false);
    expect(existsSync(stray.path)).toBe(false);
  });

  test("a worktree made before row 100, under the data folder, is archived, made again and deleted at its own path", async () => {
    const s = repo();
    // As the first iteration 4 build made it: the data folder's project folder, the branch, the add.
    const dir = projectRecords(s.data, PROJECT)!;
    const path = join(dir, "abcdefgh");
    git(s.repo, "worktree", "add", "-q", "--no-track", "-b", "kitespan/abcdefgh", path, "HEAD");
    const w = { path, root: s.repo, branch: "kitespan/abcdefgh", baseRef: "refs/heads/main", baseCommit: s.head! };
    expect(worktreeHere(path, s.repo)).toBe(true);
    expect(await worktreeChanges(s.wg, w)).toBe(0);
    expect(await removeWorktree(s.wg, w, false)).toBe(true);
    expect(await remakeWorktree(s.wg, w, s.data, PROJECT, quiet)).toBe(true);
    expect(worktreeHere(path, s.repo)).toBe(true);
    expect(existsSync(join(s.repo, ".claude"))).toBe(false);
    expect(await removeWorktree(s.wg, w, true)).toBe(true);
    expect(await dropBranch(s.wg, w)).toBe(true);
    expect(branches(s.repo)).toEqual(["main"]);
  });

  test("the branch goes only when no commit of its own would go with it (L26)", async () => {
    const s = repo();
    const a = await make(s, "aaaaaaaabbbbbbbbcccc");
    const b = await make(s, "ddddddddeeeeeeeeffff");
    if (!a.ok || !b.ok) throw new Error("no worktree");
    writeFileSync(join(a.worktree.path, "mine.txt"), "x");
    commitAll(a.worktree.path, "a commit of its own");
    expect(await branchStays(s.wg, a.worktree)).toBe(true);
    expect(await branchStays(s.wg, b.worktree)).toBe(false);
    await removeWorktree(s.wg, a.worktree, true);
    await removeWorktree(s.wg, b.worktree, true);
    expect(await dropBranch(s.wg, a.worktree)).toBe(false);
    expect(await dropBranch(s.wg, b.worktree)).toBe(true);
    expect(branches(s.repo)).toEqual(["kitespan/aaaaaaaa", "main"]);
    // Once another branch has its commit, it may go.
    git(s.repo, "branch", "keep", "kitespan/aaaaaaaa");
    expect(await dropBranch(s.wg, a.worktree)).toBe(true);
  });
});

describe(".worktreeinclude (L30)", () => {
  test("a gitignored file that matches is copied; a tracked or unignored one, or a link, is not", async () => {
    const s = repo();
    writeFileSync(join(s.repo, ".gitignore"), ".env\nlocal/\nlink.env\n");
    writeFileSync(join(s.repo, ".worktreeinclude"), ".env\nlocal/\nnotes.txt\nlink.env\n");
    commitAll(s.repo, "ignore rules");
    writeFileSync(join(s.repo, ".env"), "TOKEN=fixture\n");
    mkdirSync(join(s.repo, "local"));
    writeFileSync(join(s.repo, "local", "conf.json"), "{}\n");
    writeFileSync(join(s.repo, "notes.txt"), "not ignored\n");
    symlinkSync(join(s.repo, ".env"), join(s.repo, "link.env"));
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    // makeWorktree alone copies nothing; the registry's host copies after the add.
    expect(existsSync(join(r.worktree.path, ".env"))).toBe(false);
    expect(await copyIncludes(s.wg, r.worktree)).toBe(2);
    expect(readFileSync(join(r.worktree.path, ".env"), "utf8")).toBe("TOKEN=fixture\n");
    expect(existsSync(join(r.worktree.path, "local", "conf.json"))).toBe(true);
    expect(existsSync(join(r.worktree.path, "notes.txt"))).toBe(false);
    expect(existsSync(join(r.worktree.path, "link.env"))).toBe(false);
    // A file that is there already is left as it is.
    expect(await copyIncludes(s.wg, r.worktree)).toBe(0);
  });

  test("a second worktree copies the main checkout's files only, never the first worktree's inside .claude/worktrees", async () => {
    const s = repo();
    writeFileSync(join(s.repo, ".gitignore"), ".env\n");
    writeFileSync(join(s.repo, ".worktreeinclude"), ".env\n**/.env\n.claude/\n");
    commitAll(s.repo, "ignore rules");
    writeFileSync(join(s.repo, ".env"), "TOKEN=main\n");
    const a = await make(s, "aaaaaaaabbbbbbbbcccc");
    if (!a.ok) throw new Error("no worktree");
    expect(await copyIncludes(s.wg, a.worktree)).toBe(1);
    writeFileSync(join(a.worktree.path, ".env"), "TOKEN=first worktree\n");
    mkdirSync(join(a.worktree.path, "sub"));
    writeFileSync(join(a.worktree.path, "sub", ".env"), "TOKEN=first worktree\n");
    const b = await make(s, "ddddddddeeeeeeeeffff");
    if (!b.ok) throw new Error("no worktree");
    expect(await copyIncludes(s.wg, b.worktree)).toBe(1);
    expect(readFileSync(join(b.worktree.path, ".env"), "utf8")).toBe("TOKEN=main\n");
    expect(existsSync(join(b.worktree.path, ".claude", "worktrees"))).toBe(false);
  });
});

describe("the runner", () => {
  test("no git: nothing runs", async () => {
    const s = repo();
    expect(await runWorktreeGit({ ...s.wg, git: null }, s.repo, ["status"])).toEqual({ code: null, out: "", records: 0 });
  });
  test("a deadline ends git and its process group", async () => {
    const s = repo();
    // A stand-in for a git that hangs: a script whose child sleeps. The deadline's SIGKILL goes to the whole group.
    const slow = join(s.root, "slow-git");
    writeFileSync(slow, "#!/bin/sh\nsleep 30\n");
    chmodSync(slow, 0o755);
    const t0 = performance.now();
    const r = await runWorktreeGit({ ...s.wg, git: slow, callMs: 150 }, s.repo, ["status"]);
    expect(r.code).toBeNull();
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});
