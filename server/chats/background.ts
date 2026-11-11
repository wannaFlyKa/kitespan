// R131 (owner row 131; DESIGN-R131 section 9): the background sessions that a chat starts with `claude --bg`, in the
// registry. Claude Code records no parent link, so the chat's own launch rows are the only tie: the book keeps, per
// chat and in memory only, each short id that a launch row of the chat printed (the newest 64), from its live stream
// and from every history read (so after a restart it comes back when a page reads the chat). Per id it keeps the
// session's state, from two read-only sources:
//
// - the session's record in Claude Code's registry of running sessions, which the registry's D58 look already reads
//   (busy, waiting with what it waits for, or idle);
// - Claude Code's own list (`claude agents --json --all`, through the agent seam), only for what the record cannot say:
//   asked once 5 s after a live launch line whose id has no record yet, when a known id's record turns idle or goes,
//   when a view opens, and after a history read that noted ids with no state; never on a timer. An answer that the
//   driver kept from before the change is followed by one more read once it may run again.
//
// The state of 5.2's table: starting (a live launch line, no record yet), working, needs input, idle (an idle record
// and no list), completed, failed, stopped (also at once when kitespan's own Stop answered so), and gone (Claude Code
// no longer lists it: no line). A `background` event goes into the ring of every chat that holds the id only when what
// that chat's pages show changed; `attached` gives a late page every state. An end (completed or failed) that no page
// saw (neither that session's line nor its view on screen; the chat at its end does not count) is unseen, per chat,
// and the chat row's own field says so. R130: the same moments notify (`moment`: a session that turns to needs input,
// and an end that becomes unseen, while no page sees its line or view), and `gone` says that one needs no more.

import { realpathSync } from "node:fs";
import { holdsPath } from "../../shared/trust";
import { BG_LIMITS, type BgLaunch, type BgRowState, type BgState, type BgStopAnswer, type BgWait, type BgWorker, type ChatEvent } from "../../shared/protocol";
import type { BgList, BgListRow, BgRecord } from "../agents/types";

export const BG_BOOK = {
  /** A live launch line with no record after this long asks Claude Code's list (DESIGN-R131 9.4). */
  launchWaitMs: 5_000,
  /** How long the driver keeps a list's answer: a stale answer is followed by one more read after this. */
  listKeepMs: 5_000,
} as const;

export interface BackgroundBookDeps {
  /** The agent's list for these ids (the seam's listBackground), or null when the agent has none. */
  list: ((ids: ReadonlySet<string>) => Promise<BgList | null>) | null;
  /** The real folders whose sessions a chat's view may read: its project folder, and its worktree. */
  roots: (chat: string) => readonly string[];
  /** Whether a page has that session of the chat on screen: its line or its view. */
  seen: (chat: string, id: string) => boolean;
  /** Put an event in a chat's ring (the registry's emit, if the chat is still there). */
  emit: (chat: string, e: ChatEvent) => void;
  /** The chat's row field may have changed: its delta, if so. */
  changed: (chat: string) => void;
  /** One log line per list run: its time, its exit code and the count of rows kept; nothing else. */
  log: (f: { ms: number; code: number | null; count: number }) => void;
  /**
   * R130: a moment of `chat`'s session that no page sees: it turned to needs input (`needs`), or it ended unseen
   * (`done`, `failed`). Only for a change seen live (a state known before), never for the first state a read learns.
   */
  moment?: (chat: string, id: string, kind: "needs" | "done" | "failed") => void;
  /** R130: Claude Code no longer lists the session, or the chat's book let it go. */
  gone?: (chat: string, id: string) => void;
  now?: () => number;
  launchWaitMs?: number;
  listKeepMs?: number;
  /** A folder's real path, or null (tests); realpathSync by default. */
  realpath?: (p: string) => string | null;
}

/** One launch row of a chat: its tool use, the launch's own name and idle suffix. */
interface Launched {
  toolUse: string;
  name: string | null;
  idle: boolean;
}

interface Session {
  /** Null: not known yet (a history read noted it, and nothing answered for it since). */
  state: BgState | null;
  /** Claude Code no longer lists it. */
  gone: boolean;
  waitingFor: BgWait | null;
  /** Claude Code's own name for it (the record's, else the list's). */
  name: string | null;
  cwd: string | null;
  /** The real path of `cwd`, or null when it cannot be read. */
  real: string | null;
  sessionId: string | null;
  startedAt: number | null;
  /** The record of the last look, as far as the state needs it. */
  record: { status: BgRecord["status"]; pid: number; procStart: string | null } | null;
  /** kitespan's own Stop answered stopped, while this process's record lived (or none did): it stays stopped meanwhile. */
  stopped: { pid: number; procStart: string | null } | "none" | null;
  /** A live launch line of this server's life, when. */
  launchedAt: number | null;
  /** A list answer that began at or after this time is wanted (0: none). */
  needSince: number;
  launchTimer: ReturnType<typeof setTimeout> | null;
}

const FINAL: ReadonlySet<BgState> = new Set(["completed", "failed"]);

function unref(t: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (t as { unref?: () => void }).unref?.();
  return t;
}

/** The list's state in agent view's words (DESIGN-R131 9.3); null for a state kitespan does not know. */
function listState(row: BgListRow): { state: BgState; waitingFor: BgWait | null } | null {
  switch (row.state) {
    case "working":
      return { state: "working", waitingFor: null };
    case "blocked":
      return { state: "needs_input", waitingFor: row.waitingFor };
    case "done":
      return { state: "completed", waitingFor: null };
    case "failed":
      return { state: "failed", waitingFor: null };
    case "stopped":
      return { state: "stopped", waitingFor: null };
    default:
      return null;
  }
}

export class BackgroundBook {
  /** Each chat's launches by short id, oldest first. */
  private readonly chats = new Map<string, Map<string, Launched>>();
  private readonly sessions = new Map<string, Session>();
  /** Each chat's ids whose end no page saw. */
  private readonly unseenOf = new Map<string, Set<string>>();
  /** What each chat's pages were last told of each id ("null": gone), so an event goes only on a change. */
  private readonly sent = new Map<string, Map<string, string>>();
  /** The ids a stop runs for now. */
  private readonly stopping = new Set<string>();
  private listing = false;
  private listAgain = false;
  private listTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;
  private closed = false;

  constructor(private readonly deps: BackgroundBookDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private realOf(p: string): string | null {
    if (this.deps.realpath) return this.deps.realpath(p);
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // What the chat's rows printed

  /**
   * The launch lines of one tool row of `chat`, from its live stream (`live`) or from a history the server read. A
   * live line is a new start (or a wake of a stopped session): Starting until a record shows, and Claude Code's list 5 s
   * on if none does. A history line of an id with no state yet waits for the history read's end (afterHistory).
   */
  note(chat: string, toolUse: string, launches: readonly BgLaunch[], live: boolean): void {
    if (this.closed || launches.length === 0) return;
    let m = this.chats.get(chat);
    if (!m) this.chats.set(chat, (m = new Map()));
    for (const l of launches) {
      m.delete(l.id);
      m.set(l.id, { toolUse, name: l.name, idle: l.idle });
      let s = this.sessions.get(l.id);
      if (!s) {
        s = { state: null, gone: false, waitingFor: null, name: null, cwd: null, real: null, sessionId: null, startedAt: null, record: null, stopped: null, launchedAt: null, needSince: 0, launchTimer: null };
        this.sessions.set(l.id, s);
      }
      if (live) this.launched(l.id, s);
    }
    while (m.size > BG_LIMITS.perChat) this.drop(chat, m.keys().next().value!);
    for (const l of launches) this.publish(l.id);
  }

  /** A live launch line: a new start, or a wake of a stopped session. */
  private launched(id: string, s: Session): void {
    s.gone = false;
    s.stopped = null;
    s.launchedAt = this.now();
    if (!s.record) this.set(id, s, "starting", null);
    else this.fromRecord(id, s, s.record, null);
    if (s.launchTimer) clearTimeout(s.launchTimer);
    s.launchTimer = unref(
      setTimeout(() => {
        s.launchTimer = null;
        if (this.closed || this.sessions.get(id) !== s || s.record) return;
        if (s.state === "starting") this.want(id, s, s.launchedAt ?? this.now());
      }, this.deps.launchWaitMs ?? BG_BOOK.launchWaitMs),
    );
  }

  /** A history read of `chat` ended: the ids it noted that have no state yet ask Claude Code's list once. */
  afterHistory(chat: string): void {
    const m = this.chats.get(chat);
    if (!m) return;
    for (const id of m.keys()) {
      const s = this.sessions.get(id);
      if (s && s.state === null && !s.gone && !s.record && s.needSince === 0) this.want(id, s, this.now());
    }
  }

  /** An id leaves a chat's book (the cap); a session that no chat holds any more is forgotten. */
  private drop(chat: string, id: string): void {
    if (this.chats.get(chat)?.has(id)) this.deps.gone?.(chat, id);
    this.chats.get(chat)?.delete(id);
    this.unseenOf.get(chat)?.delete(id);
    this.sent.get(chat)?.delete(id);
    if (![...this.chats.values()].some((m) => m.has(id))) {
      const s = this.sessions.get(id);
      if (s?.launchTimer) clearTimeout(s.launchTimer);
      this.sessions.delete(id);
    }
  }

  /** The chat is gone (Delete, Remove): its launches go with it. */
  forget(chat: string): void {
    for (const id of [...(this.chats.get(chat)?.keys() ?? [])]) this.drop(chat, id);
    this.chats.delete(chat);
    this.unseenOf.delete(chat);
    this.sent.delete(chat);
  }

  /** The shutdown (or a restart's close): no timer is left, and nothing more is read. */
  close(): void {
    this.closed = true;
    for (const s of this.sessions.values()) {
      if (s.launchTimer) clearTimeout(s.launchTimer);
      s.launchTimer = null;
    }
    if (this.listTimer) clearTimeout(this.listTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.listTimer = null;
    this.retryTimer = null;
    this.listing = false;
    this.listAgain = false;
  }

  /** The restart did not happen (S13): the book works again; what it knew stays. */
  reopen(): void {
    this.closed = false;
  }

  /** Every id that a chat's book holds (the records and the list are asked for these only). */
  ids(): ReadonlySet<string> {
    return new Set(this.sessions.keys());
  }

  /** Whether a launch row of `chat` printed `id` (Open in terminal and Stop name only such an id). */
  has(chat: string, id: string): boolean {
    return this.chats.get(chat)?.has(id) === true;
  }

  // -------------------------------------------------------------------------------------------------------------
  // The two sources

  /** One look at Claude Code's registry of running sessions (the registry's D58 check): the records of the book's ids. */
  records(recs: readonly BgRecord[]): void {
    if (this.closed) return;
    const byId = new Map<string, BgRecord>();
    for (const r of recs) if (this.sessions.has(r.jobId) && !byId.has(r.jobId)) byId.set(r.jobId, r);
    for (const [id, s] of this.sessions) {
      const rec = byId.get(id) ?? null;
      const prev = s.record;
      s.record = rec ? { status: rec.status, pid: rec.pid, procStart: rec.procStart } : null;
      if (rec) {
        if (rec.name) s.name = rec.name;
        // A folder whose real path could not be read yet is read again.
        if (rec.cwd && (rec.cwd !== s.cwd || s.real === null)) {
          s.cwd = rec.cwd;
          s.real = this.realOf(rec.cwd);
        }
        s.sessionId = rec.sessionId;
        if (rec.startedAt !== null) s.startedAt = rec.startedAt;
        this.fromRecord(id, s, rec, prev);
      } else if (prev) {
        // The record went: the process ended (or was stopped). Claude Code's list tells completed, failed, stopped.
        this.want(id, s, this.now());
      }
      this.publish(id);
    }
  }

  /** The state a record says, and whether the list must say more (it turned idle, or a new process is idle). */
  private fromRecord(id: string, s: Session, rec: Pick<BgRecord, "status" | "pid" | "procStart"> & { waitingFor?: BgWait | null }, prev: Session["record"]): void {
    const same = (a: { pid: number; procStart: string | null }) => a.pid === rec.pid && a.procStart === rec.procStart;
    // kitespan's own Stop answered stopped: the record of that very process changes nothing until it goes.
    if (s.stopped && s.stopped !== "none" && same(s.stopped)) return;
    s.stopped = null;
    s.gone = false;
    if (rec.status === "busy") this.set(id, s, "working", null);
    else if (rec.status === "waiting") this.set(id, s, "needs_input", rec.waitingFor ?? null);
    else if (!prev || prev.status !== "idle" || !same(prev)) this.want(id, s, this.now());
  }

  /** Claude Code's list is wanted for `id`: an answer that began at or after `since`. */
  private want(id: string, s: Session, since: number): void {
    s.needSince = Math.max(s.needSince, since);
    this.scheduleList();
  }

  /** One list run soon (the wants of one moment go together). */
  private scheduleList(delayMs = 0): void {
    if (this.closed || !this.deps.list) return;
    if (this.listing) {
      this.listAgain = true;
      return;
    }
    if (this.listTimer) return;
    this.listTimer = unref(
      setTimeout(() => {
        this.listTimer = null;
        void this.runList();
      }, delayMs),
    );
  }

  /** A view of `id` opened (its first read): the list once (the driver keeps an answer about 5 s). */
  viewOpened(id: string): void {
    const s = this.sessions.get(id);
    if (s && !this.closed) this.want(id, s, this.now());
  }

  private async runList(): Promise<void> {
    const list = this.deps.list;
    if (!list || this.closed) return;
    this.listing = true;
    const ids = new Set(this.sessions.keys());
    let answer: BgList | null = null;
    try {
      answer = await list(ids);
    } catch {
      answer = null;
    }
    this.listing = false;
    if (this.closed) return;
    if (answer?.ran) this.deps.log({ ms: answer.ran.ms, code: answer.ran.code, count: answer.rows.length });
    let staleFor = 0;
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (!s) continue;
      if (answer && answer.at < s.needSince) {
        // A kept answer from before the change: one more read once the driver runs again.
        staleFor = Math.max(staleFor, answer.at);
        continue;
      }
      s.needSince = 0;
      this.fromList(id, s, answer ? (answer.rows.find((r) => r.id === id) ?? "missing") : "unreadable");
      this.publish(id);
    }
    if (staleFor) this.retry(staleFor + (this.deps.listKeepMs ?? BG_BOOK.listKeepMs) + 50);
    if (this.listAgain) {
      this.listAgain = false;
      this.scheduleList();
    }
  }

  /** One more list read at `at` (ms since the epoch); the latest wanted time wins. */
  private retry(at: number): void {
    if (this.closed) return;
    if (this.retryTimer && at <= this.retryAt) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryAt = at;
    this.retryTimer = unref(
      setTimeout(
        () => {
          this.retryTimer = null;
          this.scheduleList();
        },
        // Never sooner than 50 ms, so a clock that says the kept answer is old already cannot make a busy loop.
        Math.max(50, at - this.now()),
      ),
    );
  }

  /** What Claude Code's list says of `id` (a row, not listed, or the list cannot be read), by 9.3's table. */
  private fromList(id: string, s: Session, entry: BgListRow | "missing" | "unreadable"): void {
    if (typeof entry === "object") {
      if (!s.name && entry.name) s.name = entry.name;
      if (!s.cwd && entry.cwd) {
        s.cwd = entry.cwd;
        s.real = this.realOf(entry.cwd);
      }
      if (!s.sessionId && entry.sessionId) s.sessionId = entry.sessionId;
      if (s.startedAt === null && entry.startedAt !== null) s.startedAt = entry.startedAt;
    }
    const rec = s.record;
    // A busy or waiting record is newer than any list.
    if (rec && rec.status !== "idle" && !(s.stopped && s.stopped !== "none")) return;
    if (s.stopped) {
      // kitespan's own Stop answered stopped: it stays so, or goes once Claude Code no longer lists it.
      if (entry === "missing" && !rec) this.goneNow(id, s);
      return;
    }
    if (entry === "unreadable") {
      if (rec) this.set(id, s, "idle", null);
      return;
    }
    if (entry === "missing") {
      if (rec) this.set(id, s, "idle", null);
      else if (s.state === "starting" && s.launchedAt !== null && this.now() - s.launchedAt < (this.deps.launchWaitMs ?? BG_BOOK.launchWaitMs)) return;
      else this.goneNow(id, s);
      return;
    }
    const mapped = listState(entry);
    if (mapped) this.set(id, s, mapped.state, mapped.waitingFor);
    else if (rec) this.set(id, s, "idle", null);
  }

  private goneNow(id: string, s: Session): void {
    if (s.gone) return;
    s.gone = true;
    s.waitingFor = null;
    for (const chat of this.holders(id)) {
      this.unseenOf.get(chat)?.delete(id);
      this.deps.gone?.(chat, id);
    }
  }

  /** A new state of `id`: an end (completed, failed) that no page sees now waits to be seen, per chat. */
  private set(id: string, s: Session, state: BgState, waitingFor: BgWait | null, byUser = false): void {
    const was = s.gone ? null : s.state;
    s.gone = false;
    s.state = state;
    s.waitingFor = state === "needs_input" ? waitingFor : null;
    if (was === state) return;
    for (const chat of this.holders(id)) {
      const unseen = this.unseenOf.get(chat);
      if (!FINAL.has(state)) unseen?.delete(id);
      else if (!byUser && was !== null && !FINAL.has(was) && !this.deps.seen(chat, id)) {
        if (unseen) unseen.add(id);
        else this.unseenOf.set(chat, new Set([id]));
        this.deps.moment?.(chat, id, state === "completed" ? "done" : "failed");
      }
      if (state === "needs_input" && was !== null && !this.deps.seen(chat, id)) this.deps.moment?.(chat, id, "needs");
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // kitespan's own Stop

  /** A stop of `id` runs now (one at a time per id: a second press gets `busy`). */
  stopBegins(id: string): boolean {
    if (this.stopping.has(id)) return false;
    this.stopping.add(id);
    return true;
  }

  /**
   * The stop's answer: stopped at once (the user's own act, which sets nothing unseen) for a session that had not
   * ended, while a completed or failed one keeps its end; gone; or a list read.
   */
  stopEnded(id: string, answer: BgStopAnswer | null): void {
    this.stopping.delete(id);
    const s = this.sessions.get(id);
    if (!s || this.closed || answer === null) return;
    if (answer === "stopped") {
      // A session that had completed or failed keeps its end: Claude Code's list still says done or failed after a stop
      // (the lead's live run, 2.1.318); only a session that had not ended becomes Stopped.
      if (!(s.state && FINAL.has(s.state) && !s.gone)) this.set(id, s, "stopped", null, true);
      s.stopped = s.record ? { pid: s.record.pid, procStart: s.record.procStart } : "none";
    } else if (answer === "not_found") this.goneNow(id, s);
    else this.want(id, s, this.now());
    this.publish(id);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Seen (R116's rule, D49)

  /**
   * A page has `id` on screen (its line under the launch row, or its view): that session's end is seen (the chat's own
   * end is not). The chat on screen at its end sees none of its sessions' ends: a line may be far up or folded away.
   */
  seenView(chat: string, id: string): void {
    if (!this.unseenOf.get(chat)?.delete(id)) return;
    this.publishTo(chat, id);
    this.deps.changed(chat);
  }

  // -------------------------------------------------------------------------------------------------------------
  // What pages get

  private holders(id: string): string[] {
    const out: string[] = [];
    for (const [chat, m] of this.chats) if (m.has(id)) out.push(chat);
    return out;
  }

  /** The view rule (6.6): the session's real folder is a root of the chat's, or under one. */
  private inside(chat: string, s: Session): boolean {
    if (!s.real) return false;
    return this.deps.roots(chat).some((r) => {
      const root = this.realOf(r);
      return root !== null && holdsPath(root, s.real!);
    });
  }

  /** The worker as `chat`'s pages see it: undefined while nothing is known, null once gone. */
  workerOf(chat: string, id: string): BgWorker | null | undefined {
    const s = this.sessions.get(id);
    const l = this.chats.get(chat)?.get(id);
    if (!s || !l) return undefined;
    if (s.gone) return null;
    if (s.state === null) return undefined;
    return {
      state: s.state,
      ...(s.state === "needs_input" && s.waitingFor ? { waitingFor: s.waitingFor } : {}),
      ...(l.idle ? { idleLaunch: true as const } : {}),
      name: l.name ?? s.name,
      folder: s.real ?? s.cwd,
      view: this.inside(chat, s),
      startedAt: s.startedAt,
      ...(this.unseenOf.get(chat)?.has(id) ? { unseen: true as const } : {}),
    };
  }

  /** An event to every chat whose pages see `id` differently now; each one's row field after it. */
  private publish(id: string): void {
    for (const chat of this.holders(id)) if (this.publishTo(chat, id)) this.deps.changed(chat);
  }

  private publishTo(chat: string, id: string): boolean {
    const w = this.workerOf(chat, id);
    if (w === undefined) return false;
    const json = JSON.stringify(w);
    let m = this.sent.get(chat);
    if (!m) this.sent.set(chat, (m = new Map()));
    if (m.get(id) === json) return false;
    // Gone before any page was told of it: nothing to take away.
    if (w === null && !m.has(id)) return false;
    m.set(id, json);
    this.deps.emit(chat, { k: "background", id, worker: w });
    return true;
  }

  /** `attached.background`: each id of the chat with a state now; undefined when none has. */
  attached(chat: string): Record<string, BgWorker> | undefined {
    const m = this.chats.get(chat);
    if (!m) return undefined;
    const out: Record<string, BgWorker> = {};
    for (const id of m.keys()) {
      const w = this.workerOf(chat, id);
      if (w) out[id] = w;
    }
    return Object.keys(out).length ? out : undefined;
  }

  /** The chat row's own field (9.5): a session that needs input, else one that failed unseen, else one done unseen. */
  rowState(chat: string): BgRowState | null {
    const m = this.chats.get(chat);
    if (!m) return null;
    const unseen = this.unseenOf.get(chat);
    let failed = false;
    let done = false;
    for (const id of m.keys()) {
      const s = this.sessions.get(id);
      if (!s || s.gone) continue;
      if (s.state === "needs_input") return "needs_input";
      if (unseen?.has(id)) {
        if (s.state === "failed") failed = true;
        else if (s.state === "completed") done = true;
      }
    }
    return failed ? "failed" : done ? "done" : null;
  }

  /** What the view's read needs of `id` in `chat`: its session and folder, and whether the view may show it. */
  viewOf(chat: string, id: string): { sessionId: string | null; cwd: string | null; known: boolean; view: boolean } | null {
    const s = this.sessions.get(id);
    if (!s || !this.has(chat, id) || s.gone) return null;
    return { sessionId: s.sessionId, cwd: s.cwd, known: s.real !== null, view: this.inside(chat, s) };
  }
}
