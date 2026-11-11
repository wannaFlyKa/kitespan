// Row 73's records, frames and the terminal command (build checklist W2, W3, W4, W5, W11, L28): the ledger's
// `worktree` (checked as `cwd` is), `refused` and `linked`; projects.json's `worktree` flag (off by default); the
// `worktree` client frame and the new code; the chat row's `worktree`; Open in terminal's command for a worktree chat,
// with and without L28's flag.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ERROR_CODES, ERROR_MESSAGES, WORKTREE_ACTS, applyChatsFrame, parseClientFrame, type ChatRow } from "../../shared/protocol";
import { PROJECT_CONFIG_ROOT_IN_TERMINAL, resumeCommand } from "../../server/shell/command";
import { terminalConfigRoot } from "../../server/worktree/host";
import { RecordError, ledgerFrom, projectFrom } from "../../server/store/records";
import { FileStore } from "../../server/store/store";

const CHAT = "abcdefghijklmnopqrst";
const RID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const at = "2026-11-03T08:00:00.000Z";
const W = { path: "/data/kitespan/worktrees/k3m7q2x4ab/abcdefgh", root: "/srv/repo", branch: "kitespan/abcdefgh", baseRef: "refs/heads/main", baseCommit: "a".repeat(40) };
const ledger = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  id: CHAT,
  project: "k3m7q2x4ab",
  cwd: W.path,
  agent: "claude-code",
  sessionId: null,
  title: null,
  picks: { model: null, effort: null, permissionMode: null },
  createdAt: at,
  seenAt: at,
  lastActivityAt: at,
  lastSeq: 0,
  state: "sleeping",
  lastExit: null,
  archivedAt: null,
  worktree: W,
  ...over,
});

describe("the ledger's worktree (W3)", () => {
  test("a good one reads back as it is, with archive's mark and the project-folder mark", () => {
    expect(ledgerFrom(ledger()).worktree).toEqual(W);
    expect(ledgerFrom(ledger({ worktree: { ...W, kept: true } })).worktree).toEqual({ ...W, kept: true });
    expect(ledgerFrom(ledger({ cwd: W.root, worktree: { ...W, left: true } })).worktree).toEqual({ ...W, left: true });
    // Row 100: Archive's removal of a clean one.
    expect(ledgerFrom(ledger({ worktree: { ...W, removed: true } })).worktree).toEqual({ ...W, removed: true });
    // A mark that is not exactly true reads as absent.
    expect(ledgerFrom(ledger({ worktree: { ...W, kept: "yes" } })).worktree).toEqual(W);
    expect(ledgerFrom(ledger({ worktree: { ...W, removed: 1 } })).worktree).toEqual(W);
  });

  test("the chat's folder must be the worktree's (or, after Continue in the project folder, its root)", () => {
    expect(() => ledgerFrom(ledger({ cwd: "/elsewhere" }))).toThrow(RecordError);
    expect(() => ledgerFrom(ledger({ cwd: W.root }))).toThrow(RecordError);
    expect(() => ledgerFrom(ledger({ worktree: { ...W, root: W.path } }))).toThrow(RecordError);
  });

  test("a bad branch, base or path fails the ledger", () => {
    for (const bad of [{ branch: "main" }, { branch: "kitespan/ABCDEFGH" }, { branch: "kitespan/abcdefgh-0" }, { baseRef: "refs/tags/v1" }, { baseRef: "refs/heads/a b" }, { baseCommit: "abc" }, { path: "relative" }, { root: "" }])
      expect(() => ledgerFrom(ledger({ worktree: { ...W, ...bad } }))).toThrow(RecordError);
    expect(ledgerFrom(ledger({ worktree: { ...W, branch: "kitespan/abcdefgh-12", baseRef: "HEAD", baseCommit: "b".repeat(64) } })).worktree?.branch).toBe("kitespan/abcdefgh-12");
  });

  test("refused and linked", () => {
    expect(ledgerFrom(ledger({ refused: "worktree_resume_refused" })).refused).toBe("worktree_resume_refused");
    expect(ledgerFrom(ledger({ refused: "other" })).refused).toBeUndefined();
    const { worktree: _w, ...plain } = ledger({ cwd: "/srv/repo-wt", linked: true });
    expect(ledgerFrom(plain).linked).toBe(true);
    // A chat with a worktree of its own is never linked.
    expect(ledgerFrom(ledger({ linked: true })).linked).toBeUndefined();
  });

  test("the file store writes and reads it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-wt-store-")));
    try {
      const store = new FileStore({ root });
      await store.open();
      await store.writeChat(ledgerFrom(ledger({ worktree: { ...W, kept: true } })));
      await store.flush();
      const next = new FileStore({ root });
      const opened = await next.open();
      expect(opened.chats[0]!.worktree).toEqual({ ...W, kept: true });
      await store.putProject(projectFrom({ id: "k3m7q2x4ab", cwd: "/srv/repo", name: "repo", createdAt: at, lastUsedAt: at, picks: { model: null, effort: null, permissionMode: null }, worktree: true }));
      expect((await store.listProjects())[0]!.worktree).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("projects.json's worktree flag (W2)", () => {
  const p = { id: "k3m7q2x4ab", cwd: "/srv/repo", name: "repo", createdAt: at, lastUsedAt: at, picks: { model: null, effort: null, permissionMode: null } };
  test("off by default; only true turns it on", () => {
    expect(projectFrom(p).worktree).toBeUndefined();
    expect(projectFrom({ ...p, worktree: true }).worktree).toBe(true);
    expect(projectFrom({ ...p, worktree: "yes" }).worktree).toBeUndefined();
    expect(projectFrom({ ...p, worktree: false }).worktree).toBeUndefined();
  });
});

describe("the worktree frame and the chat row (W4, W5, W6)", () => {
  test("each act parses; any other is refused with its rid", () => {
    for (const a of WORKTREE_ACTS) {
      const r = parseClientFrame(JSON.stringify({ t: "worktree", rid: RID, chat: CHAT, act: a }));
      expect(r).toEqual({ ok: true, frame: { t: "worktree", rid: RID, chat: CHAT, act: a } });
    }
    const bad = parseClientFrame(JSON.stringify({ t: "worktree", rid: RID, chat: CHAT, act: "remove" }));
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.rid).toBe(RID);
    expect(parseClientFrame(JSON.stringify({ t: "worktree", rid: RID, chat: CHAT })).ok).toBe(false);
    expect(WORKTREE_ACTS).toEqual(["again", "project", "start"]);
  });

  test("worktree_failed is a code with its fixed line", () => {
    expect(ERROR_CODES).toContain("worktree_failed");
    expect(ERROR_MESSAGES.worktree_failed).toBe("kitespan could not make a worktree for this chat.");
  });

  test("a delta gives a row its worktree, and null takes it away", () => {
    const base: ChatRow = { chat: CHAT, title: null, project: "k3m7q2x4ab", state: "sleeping", needsYou: false, lastActivity: at, archived: false, busy: false };
    const withTree = applyChatsFrame([base], { t: "chats", delta: { chat: CHAT, worktree: { path: W.path, branch: W.branch, kept: false } } });
    expect(withTree[0]!.worktree).toEqual({ path: W.path, branch: W.branch, kept: false });
    expect(applyChatsFrame(withTree, { t: "chats", delta: { chat: CHAT, worktree: null } })[0]!.worktree).toBeNull();
  });
});

describe("Open in terminal for a worktree chat (W11, L28)", () => {
  const id = "0b1e2a3c-4d5e-4f60-8172-93a4b5c6d7e8";
  test("the command changes to the worktree and names the project folder (L28, on after the lead's live check LV-W4)", () => {
    expect(PROJECT_CONFIG_ROOT_IN_TERMINAL).toBe(true);
    expect(resumeCommand({ cwd: W.path, sessionId: id, processOpen: false, configRoot: W.root })).toEqual({ case: "plain", command: `cd ${W.path} && claude --resume ${id} --project-config-root /srv/repo` });
    expect(resumeCommand({ cwd: W.path, sessionId: id, processOpen: false, configRoot: W.root }, false)).toEqual({ case: "plain", command: `cd ${W.path} && claude --resume ${id}` });
  });
  test("with the flag on: --project-config-root <project folder>, quoted when it must be, also for the fork", () => {
    expect(resumeCommand({ cwd: W.path, sessionId: id, processOpen: false, configRoot: W.root }, true).command).toBe(`cd ${W.path} && claude --resume ${id} --project-config-root /srv/repo`);
    expect(resumeCommand({ cwd: W.path, sessionId: id, processOpen: true, configRoot: "/srv/my repo" }, true).command).toBe(`cd ${W.path} && claude --resume ${id} --project-config-root '/srv/my repo' --fork-session`);
    // A chat in its project's folder, or one with no project folder known, gets none.
    expect(resumeCommand({ cwd: W.root, sessionId: id, processOpen: false, configRoot: W.root }, true).command).toBe(`cd /srv/repo && claude --resume ${id}`);
    expect(resumeCommand({ cwd: W.path, sessionId: id, processOpen: false }, true).command).toBe(`cd ${W.path} && claude --resume ${id}`);
  });
  test("the pane's chat gets its project folder as configRoot from its ledger, for its own worktree only (main.ts)", () => {
    const own = ledgerFrom(ledger({ worktree: W }), CHAT);
    expect(terminalConfigRoot(own)).toBe(W.root);
    expect(resumeCommand({ cwd: own.cwd, sessionId: id, processOpen: false, configRoot: terminalConfigRoot(own) }, true).command).toBe(`cd ${W.path} && claude --resume ${id} --project-config-root /srv/repo`);
    // W4 Continue in the project folder (left), a chat in its project's folder, and W12's linked worktree get none.
    expect(terminalConfigRoot(ledgerFrom(ledger({ cwd: W.root, worktree: { ...W, left: true } }), CHAT))).toBeNull();
    expect(terminalConfigRoot(ledgerFrom(ledger({ cwd: W.root, worktree: undefined }), CHAT))).toBeNull();
    expect(terminalConfigRoot(ledgerFrom(ledger({ cwd: "/srv/repo-other", worktree: undefined, linked: true }), CHAT))).toBeNull();
  });
});
