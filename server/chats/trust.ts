// R127 (owner rows 126, 127, 129; DESIGN-R127 sections 7 and 8): Trust this folder in the registry. The book keeps, in
// memory only, the refused rows that the server matched in each chat (live, and in every history it read), and the
// state of each refused folder on this server: a trust start runs (`trusting`), or its answer. A live refusal of a
// folder clears its answer, so the next press asks again; nothing is written to disk, so after a restart the line
// offers again and Claude Code's own answer comes back (it says true for a folder it trusts already).
//
// `trust()` is one `trust_folder` after the registry's own check of the chat (it exists, is not archived, no restart
// drains): the row and its path, the path's text, the folder on disk, the home folder, one start per folder, an answer
// of this boot; then the agent's trust start, once. Each state goes to every chat that holds a refused row of the folder
// (the registry puts a `trust` event in each one's ring), and one log line per answer holds the path and the answer.

import type { ChatEvent, ErrorCode, TrustAnswer, TrustRefusal, TrustState } from "../../shared/protocol";
import { trustPathProblem } from "../../shared/trust";
import { checkFolder, homeRefusal, repoOf } from "./trust-folder";

/** At most this many refused rows are kept per chat (the newest); the line rides the newest row of a folder anyway. */
export const TRUST_ROWS_PER_CHAT = 64;

export interface TrustBookDeps {
  /** The agent's trust start, or null when the agent has none (`unsupported`). */
  start: ((path: string, signal: AbortSignal) => Promise<{ recorded: boolean }>) | null;
  /** The home folder by its names (server/home.ts). */
  homes: () => readonly string[];
  /** Put an event in a chat's ring, for every page of it (the registry's emit, if the chat is still there). */
  emit: (chat: string, e: ChatEvent) => void;
  /** One log line: the folder's path and the answer (DESIGN 4.9 guard 5's one exception, R127; never an environment). */
  log: (path: string, answer: TrustAnswer) => void;
  /** The ack code of an error that the agent's start threw (the registry's driverErrorCode). */
  codeOf: (e: unknown) => ErrorCode;
}

export type TrustOutcome = { ok: true; answer: TrustAnswer } | { ok: false; code: ErrorCode; reason?: TrustRefusal };

export class TrustBook {
  /** Each chat's refused rows: tool-use id to the folder its refusal names, oldest first. */
  private readonly rows = new Map<string, Map<string, string>>();
  /** Each refused folder's state on this server. */
  private readonly states = new Map<string, TrustState>();
  /** The trust start that runs for a folder, by its path. */
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly deps: TrustBookDeps) {}

  /** Whether the agent has a trust start (welcome's `capabilities.trustFolder`). */
  get supported(): boolean {
    return this.deps.start !== null;
  }

  /**
   * A refused row of `chat`, seen in its live stream (`live`) or in a history that the server read. A live refusal of a
   * folder clears the folder's answer (Claude Code refused it again, so a press asks again), unless a start runs; every
   * chat that holds a refused row of it hears so (a `trust` event with no state), so each open page offers again, as a
   * page that attaches now does (D49).
   */
  note(chat: string, toolUse: string, path: string, live: boolean): void {
    let m = this.rows.get(chat);
    if (!m) this.rows.set(chat, (m = new Map()));
    m.delete(toolUse);
    m.set(toolUse, path);
    while (m.size > TRUST_ROWS_PER_CHAT) m.delete(m.keys().next().value!);
    if (live && !this.running.has(path) && this.states.delete(path)) this.tell(path, null);
  }

  /** The folder that a refused row of `chat` names, or null (no such row in what the server read). */
  rowPath(chat: string, toolUse: string): string | null {
    return this.rows.get(chat)?.get(toolUse) ?? null;
  }

  /** `attached.trust`: the state of each folder of the chat's refused rows that has one; undefined when none has. */
  stateMap(chat: string): Record<string, TrustState> | undefined {
    const m = this.rows.get(chat);
    if (!m) return undefined;
    const out: Record<string, TrustState> = {};
    for (const path of m.values()) {
      const s = this.states.get(path);
      if (s) out[path] = s;
    }
    return Object.keys(out).length ? out : undefined;
  }

  /** The chat is gone (Delete, Remove): its rows go with it. */
  forget(chat: string): void {
    this.rows.delete(chat);
  }

  /** The shutdown: every trust start in flight ends (each answers failed). */
  abortAll(): void {
    for (const ac of this.running.values()) ac.abort();
  }

  /** One `trust_folder` of `chat`, after the registry's check of the chat itself. */
  async trust(chat: string, toolUse: string, path: string): Promise<TrustOutcome> {
    // 2. A refused row that the server matched in this chat, naming this very path.
    if (this.rowPath(chat, toolUse) !== path) return { ok: false, code: "stale" };
    if (!this.deps.start) return { ok: false, code: "unsupported" };
    // 3. The path's text: absolute, at most 4,096 bytes, no control character.
    const text = trustPathProblem(path);
    if (text === "too_long") return { ok: false, code: "trust_refused", reason: "too_long" };
    if (text !== null) return { ok: false, code: "bad_request" };
    // 4. On disk: there, a folder, its real path (no link anywhere in it). A folder that is not there is an answer.
    const disk = checkFolder(path);
    if ("gone" in disk) return this.answered(path, "gone");
    if ("refused" in disk) return { ok: false, code: "trust_refused", reason: disk.refused };
    // 5. Never the home folder, nor one that holds it; nor a folder whose repository root (the key that Claude Code
    // records the trust on, and the one the confirm names) is or holds it; nor one in a worktree that is or holds it
    // (that root's one trust covers every worktree of it, the home folder among them).
    const homes = this.deps.homes();
    const repo = repoOf(path);
    const home =
      homeRefusal(path, homes) ??
      (repo && repo.root !== path ? homeRefusal(repo.root, homes) : null) ??
      (repo && repo.top !== path && homeRefusal(repo.top, homes) ? "holds_home" : null);
    if (home) return { ok: false, code: "trust_refused", reason: home };
    // 6. One trust start per folder at a time.
    if (this.running.has(path)) return { ok: false, code: "busy" };
    // 7. This boot trusted it already, and no refusal of it came since.
    const was = this.states.get(path);
    if (was === "trusted" || was === "already") return this.answered(path, "already");

    const ac = new AbortController();
    this.running.set(path, ac);
    this.setState(path, "trusting");
    try {
      const r = await this.deps.start(path, ac.signal);
      return this.answered(path, r.recorded === true ? "trusted" : "not_recorded");
    } catch (e) {
      const code = this.deps.codeOf(e);
      const out = this.answered(path, "failed");
      // No claude to start is its own code; every other throw (the cap, an exit, the close) is the answer `failed`.
      return code === "no_claude" ? { ok: false, code } : out;
    } finally {
      if (this.running.get(path) === ac) this.running.delete(path);
    }
  }

  private answered(path: string, answer: TrustAnswer): TrustOutcome {
    this.setState(path, answer);
    this.deps.log(path, answer);
    return { ok: true, answer };
  }

  /** The folder's state now, to every chat that holds a refused row of it. */
  private setState(path: string, state: TrustState): void {
    this.states.set(path, state);
    this.tell(path, state);
  }

  /** A `trust` event to every chat that holds a refused row of `path`: its state, or null (no answer: offered). */
  private tell(path: string, state: TrustState | null): void {
    for (const [chat, m] of this.rows) {
      let holds = false;
      for (const p of m.values()) if (p === path) holds = true;
      if (holds) this.deps.emit(chat, { k: "trust", path, state });
    }
  }
}
