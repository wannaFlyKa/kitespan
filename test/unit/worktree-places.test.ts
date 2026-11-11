// Row 100: new worktrees go in `<project folder>/.claude/worktrees/<name>`; those made before it, under kitespan's data
// folder, keep working. The gate's worktree case of `cwd` (G4) takes the chat's own worktree at either place and
// nothing else under `.claude/worktrees`; the boot's sweep reads the records in the making in the data folder for
// either place, undoes what they name, and drops a record that names any other path without touching it.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkOptions, rawOptions, snapshotOptions, type GateContext, type GateWorktree, type RawInput } from "../../server/agents/claude/options";
import { WorktreeHost } from "../../server/worktree/host";
import { removeWorktree } from "../../server/worktree/ops";
import { markMaking } from "../../server/worktree/pending";
import { projectRecords } from "../../server/worktree/place";
import { branches, git, scratch, type Scratch } from "./worktree-repo";

const PROJECT = "k3m7q2x4ab";
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

describe("the gate's worktree case of cwd (G4)", () => {
  test("the chat's own worktree at either place passes; a plain folder under .claude/worktrees does not", () => {
    const s = repo();
    const bin = join(s.root, "bin");
    mkdirSync(bin);
    const claude = join(bin, "claude");
    writeFileSync(claude, "#!/bin/sh\necho '2.1.317 (Claude Code)'\n");
    chmodSync(claude, 0o755);
    const inProject = join(s.repo, ".claude", "worktrees", "abcdefgh");
    git(s.repo, "worktree", "add", "-q", "-b", "kitespan/abcdefgh", inProject);
    const inData = join(projectRecords(s.data, PROJECT)!, "bcdefghi");
    git(s.repo, "worktree", "add", "-q", "-b", "kitespan/bcdefghi", inData);
    const plain = join(s.repo, ".claude", "worktrees", "cdefghij");
    mkdirSync(plain);
    const fn = async () => ({ behavior: "deny" as const, message: "x" });
    const ctx = (w: GateWorktree): GateContext => ({
      pinnedPath: claude,
      knownFolders: [s.repo],
      platformPackages: [],
      allowBypass: false,
      promptSuggestionEnabled: false,
      ledgerSessionId: null,
      sessionExists: false,
      worktree: w,
    });
    const input = (w: GateWorktree): RawInput => ({
      cwd: w.path,
      binary: claude,
      callbacks: { canUseTool: fn, onElicitation: async () => ({ action: "cancel" as const }), onUserDialog: async () => ({ behavior: "cancelled" as const }), stderr: () => {} },
      resume: null,
      sessionId: null,
      picks: {},
      switches: {},
      worktree: w,
    });
    const problems = (w: GateWorktree) => checkOptions(snapshotOptions(rawOptions(input(w), ctx(w)).options), {}, ctx(w));
    expect(problems({ path: inProject, root: s.repo, own: true })).toEqual([]);
    expect(problems({ path: inData, root: s.repo, own: true })).toEqual([]);
    expect(() => problems({ path: plain, root: s.repo, own: true })).toThrow(`"cwd" is not a linked worktree of its project's folder`);
  });
});

describe("the boot's sweep of the records in the making", () => {
  test("a left add at either place is undone; a record that names another path goes and leaves that path alone", async () => {
    const s = repo();
    const records = projectRecords(s.data, PROJECT)!;
    const head = git(s.repo, "rev-parse", "HEAD").trim();
    // A dead server's adds that no ledger holds: one at row 100's place, one where the first build put them.
    const at = (path: string, name: string) => ({ path, root: s.repo, branch: `kitespan/${name}`, baseRef: "refs/heads/main", baseCommit: head });
    const inProject = at(join(s.repo, ".claude", "worktrees", "abcdefgh"), "abcdefgh");
    const inData = at(join(records, "bcdefghi"), "bcdefghi");
    for (const w of [inProject, inData]) {
      git(s.repo, "worktree", "add", "-q", "--no-track", "-b", w.branch, w.path, head);
      expect(await markMaking(w, records)).toBe(true);
    }
    // A record that names a folder at neither place (not one that kitespan writes).
    const stray = join(s.root, "stray", "cdefghij");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "keep.txt"), "mine\n");
    writeFileSync(join(records, "cdefghij.making"), JSON.stringify({ v: 1, path: stray, root: s.repo, branch: "kitespan/cdefghij", commit: head }));
    const host = new WorktreeHost({ worktreeGit: s.wg, worktreeData: s.data, worktreeSay: () => {} });
    expect(await host.sweep([{ id: PROJECT, cwd: s.repo }], () => false)).toBe(2);
    expect(existsSync(inProject.path)).toBe(false);
    expect(existsSync(inData.path)).toBe(false);
    expect(branches(s.repo)).toEqual(["main"]);
    expect(readdirSync(records)).toEqual([]);
    expect(existsSync(join(stray, "keep.txt"))).toBe(true);
    // The project's .claude/worktrees stays (kitespan never removes it).
    expect(existsSync(join(s.repo, ".claude", "worktrees"))).toBe(true);
  });

  // A project's folder that is not there at boot (a disk that is not mounted yet, modelled by a rename): its worktree's
  // path is gone too, but that is not the add undone, so the record stays for a later boot.
  test("a project's folder that is away keeps a new chat's record; with the folder back, the next sweep undoes the add", async () => {
    const s = repo();
    const records = projectRecords(s.data, PROJECT)!;
    const head = git(s.repo, "rev-parse", "HEAD").trim();
    const w = { path: join(s.repo, ".claude", "worktrees", "abcdefgh"), root: s.repo, branch: "kitespan/abcdefgh", baseRef: "refs/heads/main", baseCommit: head };
    expect(await markMaking(w, records)).toBe(true);
    // A Start's add that a kill -9 cut: git's entry is still locked as "initializing".
    git(s.repo, "worktree", "add", "-q", "--no-track", "-b", w.branch, w.path, head);
    git(s.repo, "worktree", "lock", "--reason", "initializing", w.path);
    const away = join(s.root, "repo-away");
    renameSync(s.repo, away);
    const host = new WorktreeHost({ worktreeGit: s.wg, worktreeData: s.data, worktreeSay: () => {} });
    expect(await host.sweep([{ id: PROJECT, cwd: s.repo }], () => false)).toBe(0);
    expect(readdirSync(records)).toEqual(["abcdefgh.making"]);
    renameSync(away, s.repo);
    expect(await host.sweep([{ id: PROJECT, cwd: s.repo }], () => false)).toBe(1);
    expect(existsSync(w.path)).toBe(false);
    expect(branches(s.repo)).toEqual(["main"]);
    expect(git(s.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(readdirSync(records)).toEqual([]);
  });

  test("a remake's record stays while its project's folder is away; with the folder back, its cut checkout is undone", async () => {
    const s = repo();
    const records = projectRecords(s.data, PROJECT)!;
    const head = git(s.repo, "rev-parse", "HEAD").trim();
    const w = { path: join(s.repo, ".claude", "worktrees", "abcdefgh"), root: s.repo, branch: "kitespan/abcdefgh", baseRef: "refs/heads/main", baseCommit: head };
    git(s.repo, "branch", w.branch, head);
    expect(await markMaking(w, records, true)).toBe(true);
    git(s.repo, "worktree", "add", "-q", w.path, w.branch);
    git(s.repo, "worktree", "lock", "--reason", "initializing", w.path);
    const away = join(s.root, "repo-away");
    renameSync(s.repo, away);
    const host = new WorktreeHost({ worktreeGit: s.wg, worktreeData: s.data, worktreeSay: () => {} });
    // The chat's ledger holds the worktree (owned), but its add did not finish.
    expect(await host.sweep([{ id: PROJECT, cwd: s.repo }], () => true)).toBe(0);
    expect(readdirSync(records)).toEqual(["abcdefgh.making"]);
    renameSync(away, s.repo);
    expect(await host.sweep([{ id: PROJECT, cwd: s.repo }], () => true)).toBe(1);
    expect(existsSync(w.path)).toBe(false);
    // A remake's branch is the chat's: it stays.
    expect(branches(s.repo)).toEqual([w.branch, "main"].sort());
    expect(readdirSync(records)).toEqual([]);
  });

  test("a removal while the project's folder is away says the worktree did not go", async () => {
    const s = repo();
    const head = git(s.repo, "rev-parse", "HEAD").trim();
    const w = { path: join(s.repo, ".claude", "worktrees", "abcdefgh"), root: s.repo, branch: "kitespan/abcdefgh", baseRef: "refs/heads/main", baseCommit: head };
    git(s.repo, "worktree", "add", "-q", "--no-track", "-b", w.branch, w.path, head);
    const away = join(s.root, "repo-away");
    renameSync(s.repo, away);
    expect(await removeWorktree(s.wg, w, true)).toBe(false);
    renameSync(away, s.repo);
    expect(existsSync(join(w.path, "README.md"))).toBe(true);
  });
});
