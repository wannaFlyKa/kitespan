// The gate's worktree rows (build checklist G3, G4, G5; DESIGN.md 4.7 with row 73): `projectConfigRoot` with its one
// exact value, the chat's project folder, only while `cwd` is that project's own kitespan worktree; the worktree case
// of `cwd`; and `extraArgs` refused as before. On a scratch repository with a real linked worktree.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkOptions, GateError, rawOptions, snapshotOptions, WORKTREE_KEYS, type GateContext, type GateWorktree, type RawInput } from "../../server/agents/claude/options";
import { git, scratch } from "../unit/worktree-repo";

const s = scratch();
const other = scratch();
afterAll(() => {
  s.cleanup();
  other.cleanup();
});
const BIN = join(s.root, "bin");
const CLAUDE = join(BIN, "claude");
mkdirSync(BIN);
writeFileSync(CLAUDE, "#!/bin/sh\necho '2.1.312 (Claude Code)'\n");
chmodSync(CLAUDE, 0o755);
const WT = join(s.root, "wt");
git(s.repo, "worktree", "add", "-q", "-b", "kitespan/abcdefgh", WT);
const OTHER_WT = join(other.root, "wt");
git(other.repo, "worktree", "add", "-q", "-b", "kitespan/ijklmnop", OTHER_WT);

const fn = async () => ({ behavior: "deny" as const, message: "x" });
const own: GateWorktree = { path: WT, root: s.repo, own: true };
const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  pinnedPath: CLAUDE,
  knownFolders: [s.repo],
  platformPackages: [],
  allowBypass: false,
  promptSuggestionEnabled: false,
  ledgerSessionId: null,
  sessionExists: false,
  worktree: own,
  ...over,
});
const input = (over: Partial<RawInput> = {}): RawInput => ({
  cwd: WT,
  binary: CLAUDE,
  callbacks: { canUseTool: fn, onElicitation: async () => ({ action: "cancel" as const }), onUserDialog: async () => ({ behavior: "cancelled" as const }), stderr: () => {} },
  resume: null,
  sessionId: null,
  picks: {},
  switches: {},
  worktree: own,
  ...over,
});
const problems = (o: Record<string, unknown>, c: Partial<GateContext> = {}) => checkOptions(o, {}, ctx(c)).join("\n");
const passed = () => snapshotOptions(rawOptions(input(), ctx()).options);

describe("G3: projectConfigRoot, one exact value", () => {
  test("accepted for the chat's own worktree: cwd is the worktree, projectConfigRoot the project's folder", () => {
    const { options } = rawOptions(input(), ctx());
    expect(options.cwd).toBe(WT);
    expect(options.projectConfigRoot).toBe(s.repo);
    expect(checkOptions(snapshotOptions(options), {}, ctx())).toEqual([]);
    expect(WORKTREE_KEYS).toEqual(["projectConfigRoot"]);
  });

  test("not passed for a chat in its project's folder, nor for a terminal session's linked worktree (own false)", () => {
    expect("projectConfigRoot" in rawOptions(input({ cwd: s.repo, worktree: null }), ctx({ worktree: null })).options).toBe(false);
    const linked: GateWorktree = { ...own, own: false };
    const { options } = rawOptions(input({ worktree: linked }), ctx({ worktree: linked }));
    expect("projectConfigRoot" in options).toBe(false);
    expect(checkOptions(snapshotOptions(options), {}, ctx({ worktree: linked }))).toEqual([]);
  });

  test("refused with cwd = the project's folder", () => {
    expect(problems({ ...passed(), cwd: s.repo })).toContain(`"projectConfigRoot" is passed only for the chat's own worktree`);
    expect(problems({ ...passed(), cwd: s.repo }, { worktree: null })).toContain(`"projectConfigRoot" is passed only for the chat's own worktree`);
  });

  test("refused with a folder that is not the chat's project", () => {
    expect(problems({ ...passed(), projectConfigRoot: other.repo }, { knownFolders: [s.repo, other.repo] })).toContain(`"projectConfigRoot" is not the chat's project folder`);
    expect(problems({ ...passed(), projectConfigRoot: WT })).toContain(`"projectConfigRoot" is not the chat's project folder`);
  });

  test("refused with a relative path, or a value that is no path", () => {
    expect(problems({ ...passed(), projectConfigRoot: "repo" })).toContain(`"projectConfigRoot" must be an absolute path`);
    expect(problems({ ...passed(), projectConfigRoot: true })).toContain(`"projectConfigRoot" must be an absolute path`);
  });

  test("refused for a worktree that kitespan did not make for this chat (own false)", () => {
    expect(problems(passed(), { worktree: { ...own, own: false } })).toContain(`"projectConfigRoot" is passed only for the chat's own worktree`);
  });

  test("refused when the project's folder is not in projects.json", () => {
    expect(problems(passed(), { knownFolders: [] })).toContain(`"projectConfigRoot" is not a folder of projects.json`);
  });
});

describe("G4: the worktree case of cwd", () => {
  test("refused for a worktree of another repository", () => {
    const w: GateWorktree = { path: OTHER_WT, root: s.repo, own: false };
    expect(() => rawOptions(input({ cwd: OTHER_WT, worktree: w }), ctx({ worktree: w }))).toThrow(GateError);
    expect(problems({ ...passed(), cwd: OTHER_WT, projectConfigRoot: undefined }, { worktree: w })).toContain(`"cwd" is not a linked worktree of its project's folder`);
  });

  test("refused for a worktree whose root is not in projects.json", () => {
    const w: GateWorktree = { path: OTHER_WT, root: other.repo, own: false };
    const o: Record<string, unknown> = { ...passed(), cwd: OTHER_WT };
    delete o.projectConfigRoot;
    expect(checkOptions(o, {}, ctx({ worktree: w })).join("\n")).toContain(`"cwd" is a worktree of a folder that is not in projects.json`);
  });

  test("refused for a folder that only looks like one, and for a link to the worktree", () => {
    const fake = join(s.root, "fake");
    mkdirSync(fake);
    writeFileSync(join(fake, ".git"), `gitdir: ${join(s.repo, ".git", "worktrees", "wt")}\n`);
    const w: GateWorktree = { path: fake, root: s.repo, own: true };
    expect(problems({ ...passed(), cwd: fake }, { worktree: w })).toContain(`"cwd" is not a linked worktree of its project's folder`);
    const link = join(s.root, "wt-link");
    symlinkSync(WT, link);
    expect(problems({ ...passed(), cwd: link }, { worktree: { ...own, path: link } })).toContain(`"cwd" must be the real path of a folder`);
  });

  test("a worktree that is not the ledger's is refused as any unknown folder", () => {
    expect(problems({ ...passed(), cwd: OTHER_WT })).toContain(`"cwd" is not a folder of projects.json`);
  });
});

describe("G5: extraArgs stays refused", () => {
  test("even as exactly {worktree: <name>}", () => {
    expect(problems({ ...passed(), extraArgs: { worktree: "abcdefgh" } })).toContain(`"extraArgs" conflicts with raw Claude Code`);
  });
});
