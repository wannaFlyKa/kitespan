// The chat registry's side of row 73 (DESIGN.md 9.4 "Worktrees"; build checklist W3 to W13): what a chat's ledger says
// about its folder, for the agent's start (the gate's worktree case, G3 and G4), the check before every start (W4),
// a refused start's line (W5), the chat list's row (W6), and the git work of archive, unarchive and delete (W7 to
// W9), one at a time per worktree. The registry calls these; it never runs git itself.

import { homedir } from "node:os";
import type { ChatWorktree, ErrorCode, StartupReason } from "../../shared/protocol";
import type { AgentSettings } from "../agents/types";
import { START_ENV } from "../start-env-copy";
import type { ChatLedger, LedgerWorktree, ProjectRecord } from "../store/types";
import { worktreeHere } from "./check";
import { worktreeGit, type WorktreeGit } from "./git";
import { copyIncludes } from "./include";
import {
  addFinished,
  archiveRemove,
  branchStays,
  dropBranch,
  ignoredWork,
  makeWorktree,
  remakeWorktree,
  removeWorktree,
  sayOnStderr,
  undoAdd,
  worktreeChanges,
  worktreeOff,
  type MakeResult,
  type Say,
  type WorktreeOff,
} from "./ops";
import { makingLeft, sweepMaking, unmarkMaking } from "./pending";
import { dataHome, projectRecordsThere } from "./place";

/** What main.ts may plug in; the tests give a scratch git config and a mkdtemp data folder. */
export interface WorktreeHostDeps {
  /** kitespan's own worktree git (git.ts); the start environment's by default. */
  worktreeGit?: WorktreeGit;
  /**
   * The data folder that `kitespan/worktrees` goes in: the records in the making, and the worktrees made before row 100
   * (L23); `$XDG_DATA_HOME` or `~/.local/share` by default.
   */
  worktreeData?: string;
  /** The server's terminal line of a local ignore that was not written (ignore.ts); stderr by default. */
  worktreeSay?: Say;
}

/** The chat's worktree as the agent's start gets it (OpenInput.worktree), or null: the chat runs in its project's folder. */
export function openWorktree(ledger: ChatLedger, projectCwd: string | null): { path: string; root: string; own: boolean } | null {
  const w = ledger.worktree;
  if (w && !w.left) return { path: w.path, root: w.root, own: true };
  // W12: Continue here of a terminal session that ran in a linked worktree of the project's folder.
  if (ledger.linked && projectCwd !== null && ledger.cwd !== projectCwd) return { path: ledger.cwd, root: projectCwd, own: false };
  return null;
}

/**
 * W4 (L35): the chat's folder before a start, by file reads: its own worktree is gone (or no longer its project's
 * linked worktree, or Archive removed it and nothing made it again: whatever is at its path is not it),
 * `worktree_gone`; the linked worktree of a terminal session is gone, `cwd_unavailable`; else null.
 */
export function startCheck(ledger: ChatLedger, projectCwd: string | null): ErrorCode | null {
  const at = openWorktree(ledger, projectCwd);
  if (!at) return null;
  if (at.own && ledger.worktree?.removed) return "worktree_gone";
  if (worktreeHere(at.path, at.root)) return null;
  return at.own ? "worktree_gone" : "cwd_unavailable";
}

/** W5: the line that a start-up refusal of Claude Code gets; null for one that keeps the plain exit line. */
export function startupCode(reason: StartupReason, ledger: ChatLedger): ErrorCode | null {
  if (reason === "worktree_unverified" || reason === "worktree_resume_refused") return reason;
  if (reason === "cwd_unavailable") return ledger.worktree && !ledger.worktree.left ? "worktree_gone" : "cwd_unavailable";
  return null;
}

/** The folder whose Claude Code settings and short reads a chat uses: its project's for its own worktree (G3). */
export function configFolder(ledger: ChatLedger): string {
  const w = ledger.worktree;
  return w && !w.left ? w.root : ledger.cwd;
}

/**
 * L28: the folder that Open in terminal's command passes as `--project-config-root` (while
 * PROJECT_CONFIG_ROOT_IN_TERMINAL is on): the project's, only while the chat runs in its own worktree (G3); else null.
 */
export function terminalConfigRoot(ledger: ChatLedger): string | null {
  const at = openWorktree(ledger, null);
  return at?.own && at.path === ledger.cwd ? at.root : null;
}

/** The folder that the chat's session functions read (`dir`): where Claude Code filed its transcript (sessionDir). */
export function sessionFolder(ledger: ChatLedger): string {
  return ledger.sessionDir ?? ledger.cwd;
}

/** The chat list's `worktree` (W6): the chat's folder when it is a worktree, its branch now, and archive's mark. */
export function rowWorktree(ledger: ChatLedger, projectCwd: string | null, branch: string | null): ChatWorktree | null {
  const at = openWorktree(ledger, projectCwd);
  if (!at) return null;
  const own = at.own ? ledger.worktree! : null;
  return { path: at.path, branch: branch ?? own?.branch ?? null, kept: own?.kept === true };
}

/** One worktree's git work, one call after another per path (two chats may share one, Continue in a copy, L27). */
export class WorktreeHost {
  readonly git: WorktreeGit;
  readonly data: string;
  private readonly say: Say;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(deps: WorktreeHostDeps = {}) {
    this.git = deps.worktreeGit ?? worktreeGit();
    this.data = deps.worktreeData ?? dataHome(START_ENV, homedir());
    this.say = deps.worktreeSay ?? sayOnStderr;
  }

  /** The record in the making of `w` goes (pending.ts), from the project's folder of the data folder. */
  private async unmark(w: LedgerWorktree, projectId: string): Promise<void> {
    const records = projectRecordsThere(this.data, projectId);
    if (records) await unmarkMaking(w, records);
  }

  private serial<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const was = this.chains.get(path) ?? Promise.resolve();
    const run = was.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(path, tail);
    void tail.then(() => {
      if (this.chains.get(path) === tail) this.chains.delete(path);
    });
    return run;
  }

  /** W2 (L29, L33): why the project's folder gets no worktree now, its settings' WorktreeCreate hook included. */
  async off(root: string, settings: () => Promise<AgentSettings>): Promise<WorktreeOff | null> {
    const why = await worktreeOff(this.git, root);
    if (why) return why;
    const s = await settings().catch(() => null);
    return s?.worktreeHook ? "hook" : null;
  }

  /**
   * W3: the new chat's worktree, with its `.worktreeinclude` files (L30); refused with the same reasons as `off`. Its
   * record in the making stays until `settled` (the chat's ledger holds it) or `discard`.
   */
  async make(project: ProjectRecord, chatId: string, settings: () => Promise<AgentSettings>): Promise<MakeResult> {
    const s = await settings().catch(() => null);
    if (s?.worktreeHook) return { ok: false, why: "hook" };
    const r = await makeWorktree(this.git, { root: project.cwd, data: this.data, projectId: project.id, chatId }, this.say);
    if (r.ok) await copyIncludes(this.git, r.worktree).catch(() => {});
    return r;
  }

  /** W3: the new chat's ledger holds its worktree now, so the record in the making of the project's goes. */
  settled(w: LedgerWorktree, projectId: string): Promise<void> {
    return this.unmark(w, projectId);
  }

  /**
   * W3's mention_gone, and a Start that a shutdown overtook: the worktree that it had just made, which no chat ever ran
   * in, goes again with its branch (undoAdd), and then its record in the making.
   */
  discard(w: LedgerWorktree, projectId: string): Promise<void> {
    return this.serial(w.path, async () => {
      if (await undoAdd(this.git, { path: w.path, root: w.root, branch: w.branch, commit: w.baseCommit })) await this.unmark(w, projectId);
    });
  }

  /**
   * The boot's look for worktrees left in the making by a server that died during a Start, an Unarchive or a Make it
   * again (pending.ts): one that a ledger holds (`owned`) is kept, a remake's only once its add finished; any other
   * goes as `discard` does (a remake's branch stays). How many went.
   */
  sweep(projects: readonly { id: string; cwd: string }[], owned: (path: string) => boolean): Promise<number> {
    return sweepMaking(
      this.data,
      projects,
      owned,
      (m) => this.serial(m.path, () => undoAdd(this.git, m)),
      (m) => this.serial(m.path, () => addFinished(this.git, m)),
    );
  }

  /**
   * Row 99: an environment's Remove sweeps its records in the making as the boot does (`owned`: the worktrees that its
   * chats' ledgers held), since no later boot reads a removed project's. True when no record of it is left.
   */
  async sweepProject(project: { id: string; cwd: string }, owned: (path: string) => boolean): Promise<boolean> {
    await this.sweep([project], owned);
    return !makingLeft(this.data, project.id);
  }

  /** W4 Make it again from its branch, W8 Unarchive: true when the worktree is there afterwards. */
  again(w: LedgerWorktree, projectId: string): Promise<boolean> {
    return this.serial(w.path, () => remakeWorktree(this.git, w, this.data, projectId, this.say));
  }

  /**
   * W7 (L25): a clean worktree goes and its branch stays; one with changes, or with files that git ignores other than
   * unchanged copies of the project's own (ignoredWork), stays on disk (`kept`). Null when there was nothing to do (no
   * worktree there, one there that Archive's earlier removal says is not the chat's, its state could not be read, which
   * keeps it, a removal that git refused, or `still` says the archive was undone before its turn came).
   */
  archive(w: LedgerWorktree, still: () => boolean = () => true): Promise<"removed" | "kept" | null> {
    return this.serial(w.path, async () => {
      if (!still() || w.removed) return null;
      const n = await worktreeChanges(this.git, w);
      if (n === null) return null;
      if (n > 0) return "kept";
      const ignored = await ignoredWork(this.git, w);
      if (ignored === null) return null;
      if (ignored) return "kept";
      return archiveRemove(this.git, w);
    });
  }

  /**
   * W9 (L26), after the user's confirm: the worktree goes (with its changes; never one at the path after Archive's
   * removal, which is not the chat's), and its branch unless it holds its own commits.
   */
  delete(w: LedgerWorktree, folder: boolean): Promise<void> {
    return this.serial(w.path, async () => {
      if (folder && !w.removed && !(await removeWorktree(this.git, w, true))) return;
      await dropBranch(this.git, w);
    });
  }

  /**
   * Archive's and Delete's facts (W7, W9): how many files have changes (null: not there), whether it holds files that
   * git ignores, which Archive keeps as it keeps changes (null: not there or not read), and whether the branch stays.
   * After Archive's removal the chat's worktree is not there, whatever is at its path.
   */
  async facts(w: LedgerWorktree): Promise<{ changes: number | null; ignored: boolean | null; branchStays: boolean }> {
    const gone = w.left || w.removed;
    const changes = gone ? null : await worktreeChanges(this.git, w);
    const ignored = gone ? null : await ignoredWork(this.git, w);
    return { changes, ignored, branchStays: await branchStays(this.git, w) };
  }
}
