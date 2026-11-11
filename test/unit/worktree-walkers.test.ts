// Row 100: a worktree at `<project folder>/.claude/worktrees/<name>` is inside the project's folder, and nothing that
// reads the project's files reads it: the corpus behind search and the @ picker (git's lists, with the local ignore
// and without it, and with a staged gitlink; the walk skips every dot entry) and a folder's download archive (its own
// rule, isWorktreesFolder). The worktree's own folder, as a worktree chat's, lists its files as before.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWorktreesFolder, probeTarget, walkFolder } from "../../server/http/files";
import { listCorpus } from "../../server/search/build";
import { findGit } from "../../server/search/git";
import { makeWorktree } from "../../server/worktree/ops";
import { GIT_TEST_ENV, commitAll, git, scratch, type Scratch } from "./worktree-repo";

const PROJECT = "k3m7q2x4ab";
const GIT = findGit(process.env.PATH ?? "");
let open: Scratch[] = [];
afterEach(() => {
  for (const s of open) s.cleanup();
  open = [];
});

/** A project with a tracked `.claude/commands` file and one worktree that holds a change, a new file and an ignored one. */
async function project(): Promise<{ s: Scratch; tree: string }> {
  const s = scratch();
  open.push(s);
  mkdirSync(join(s.repo, ".claude", "commands"), { recursive: true });
  writeFileSync(join(s.repo, ".claude", "commands", "hello.md"), "Say hello.\n");
  writeFileSync(join(s.repo, ".gitignore"), "build/\n");
  commitAll(s.repo, "a command");
  const r = await makeWorktree(s.wg, { root: s.repo, data: s.data, projectId: PROJECT, chatId: "abcdefghijklmnopqrst" }, () => {});
  if (!r.ok) throw new Error("no worktree");
  const tree = r.worktree.path;
  writeFileSync(join(tree, "README.md"), "changed in the worktree\n");
  writeFileSync(join(tree, "only-in-worktree.ts"), "export {};\n");
  mkdirSync(join(tree, "build"));
  writeFileSync(join(tree, "build", "out.js"), "1\n");
  return { s, tree };
}

const corpus = (s: Scratch, root: string, git: string | null = GIT) => listCorpus(root, { git, env: { PATH: process.env.PATH ?? "", HOME: s.root }, extraEnv: GIT_TEST_ENV });
const inTrees = (p: string) => p === ".claude/worktrees" || p.startsWith(".claude/worktrees/");

describe("the corpus (server/search)", () => {
  test("git's lists name no worktree file, with the local ignore, without it, and with the worktree staged as a gitlink", async () => {
    const { s } = await project();
    const listed = await corpus(s, s.repo);
    expect(listed.source).toBe("git");
    expect(listed.paths).toEqual(expect.arrayContaining([".claude/commands/hello.md", ".gitignore", "README.md"]));
    expect(listed.paths.filter(inTrees)).toEqual([]);
    // Without the line (the user took it out, or it could not be written).
    writeFileSync(join(s.repo, ".git", "info", "exclude"), "");
    expect(git(s.repo, "status", "--porcelain")).toBe("?? .claude/worktrees/\n");
    expect((await corpus(s, s.repo)).paths.filter(inTrees)).toEqual([]);
    // A `git add -A` stages the worktree as an embedded repository (mode 160000), which the corpus leaves out.
    git(s.repo, "add", "-A");
    expect(git(s.repo, "ls-files", "--stage", ".claude/worktrees")).toMatch(/^160000 /);
    expect((await corpus(s, s.repo)).paths.filter(inTrees)).toEqual([]);
  });

  test("the walk (no git) enters no dot folder, so no worktree either", async () => {
    const { s } = await project();
    const walked = await corpus(s, s.repo, null);
    expect(walked.source).toBe("walk");
    expect(walked.paths).toContain("README.md");
    expect(walked.paths.filter((p) => p.startsWith(".claude"))).toEqual([]);
  });

  test("a worktree chat's corpus is its worktree's files", async () => {
    const { s, tree } = await project();
    const listed = await corpus(s, tree);
    expect(listed.paths).toEqual(expect.arrayContaining(["README.md", "only-in-worktree.ts", ".claude/commands/hello.md"]));
    expect(listed.paths).not.toContain("build/out.js");
  });
});

describe("a folder's download archive (the Files pane)", () => {
  test("the project's folder and its .claude leave .claude/worktrees out; the worktree's own folder has its files", async () => {
    const { s, tree } = await project();
    const rels = async (folder: string) => (await walkFolder(folder)).entries.map((e) => e.rel);
    const top = await rels(s.repo);
    expect(top).toEqual(expect.arrayContaining([".claude", ".claude/commands", ".claude/commands/hello.md", "README.md"]));
    expect(top.filter(inTrees)).toEqual([]);
    expect(await rels(join(s.repo, ".claude"))).toEqual(["", "commands", "commands/hello.md"]);
    expect(await rels(tree)).toEqual(expect.arrayContaining(["README.md", "only-in-worktree.ts", "build/out.js"]));
    // The download route's probe of the project's folder gives the same archive.
    const probe = await probeTarget(s.repo, ".claude");
    expect(probe.exists && probe.target.kind === "folder" && probe.target.entries.map((e) => e.rel)).toEqual(["", "commands", "commands/hello.md"]);
    expect(isWorktreesFolder(join(s.repo, ".claude"), "worktrees")).toBe(true);
    expect(isWorktreesFolder(s.repo, "worktrees")).toBe(false);
  });
});
