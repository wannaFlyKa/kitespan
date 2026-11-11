// U1 (DESIGN-U1 4, 5 and 9): each chat's turn marks, summaries and diff reads. The registry calls it at a turn's start
// (begin), with each event of the turn (note), at the turn's end (end) and when a turn goes with no end (drop); the
// history read asks it for the chat's cards (cards), and the API for a summary and a file's diff (summary, file).
//
// - A user's turn: the message waits for the start mark before it goes on Claude Code's input (`ready`), at most
//   CHANGES_LIMITS.startMs in all; past that the send goes and the turn has no start mark. An agent's own turn (a task's
//   notification, a queued message that Claude Code starts by itself) has no send to hold: its mark starts at its start
//   and holds only if it was done before the turn's first tool call came. Either way the rule is that one. Once a
//   chat's start mark has passed its deadline, its next messages are not held (their marks run as an agent's do) until
//   a start mark is done in time again.
// - The end mark is taken at every end (an Interrupted or failed turn too), then the summary (summary.ts), within
//   CHANGES_LIMITS.endMs. Without both marks (a folder that is not a repository, no git, a refused config, a mark that
//   was late or failed), the summary is Claude's own edits (`edits`, with its reason).
// - Each chat's marks run one at a time, so the next turn's start mark waits for this turn's end mark. Never on a timer.
// - A chat's changes folder over CHANGES_LIMITS.chatBytes takes no more marks (its turns fall back, `failed`). Its size
//   is measured before the chat's first mark, after each mark that failed (a git killed at a deadline leaves its
//   temporary objects, which are removed first) and after each summary.
// - Two chats in one folder (review): the book keeps every turn of every chat while a turn that overlaps it still waits
//   for its summary, and each chat's `!` commands' run windows (command). A summary gets what the other chats did in
//   its folder meanwhile: their file tools' targets and their command windows (summary.ts counts theirs apart).
// - A summary that holds no file (nothing changed, or only the user's own changes) is not kept and makes no card.

import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { CHANGES_LIMITS, type ChangedFile, type ChangesCard, type ChangesSummary, type ChangesWhy, type EditHunk, type FileDiff } from "../../shared/changes";
import { newChangesId } from "../../shared/ids";
import type { ChatEvent } from "../../shared/protocol";
import { START_ENV } from "../start-env-copy";
import { worktreeGit, type WorktreeGit } from "../worktree/git";
import { TurnActivity, type Span } from "./activity";
import { clearWork, diffMarks, objectBytes, placeOf, preparePlace, probeRepo, readPatch, sweepObjects, takeMark, type Mark, type MarkPlace, type MarkWhy, type RepoAt } from "./git";
import { parsePatch } from "./patch";
import { cardKey, pageRowId } from "./rows";
import type { ChangesStore, TurnRecord } from "./store";
import { editsTally, gitTally, inFolder, type Elsewhere, type Tally } from "./summary";

export interface ChangesLimits {
  startMs: number;
  endMs: number;
  diffMs: number;
  chatBytes: number;
  /** The untracked files a mark may hash (CHANGES_LIMITS.markFiles, markBytes). */
  markFiles: number;
  markBytes: number;
}

export interface ChangesDeps {
  store: ChangesStore;
  /** kitespan's own git (the start environment's, by default). */
  git?: WorktreeGit;
  /** The clock of the tool windows (ms, the same clock as a file's ctime). */
  now?: () => number;
  limits?: Partial<ChangesLimits>;
  /** A counts-only `changes` log line (server/log.ts). */
  log?: (fields: { chat: string; ms: number; count: number | null; ok: boolean; timeout: boolean; capped: boolean }) => void;
}

/** What a turn's start mark gave: the mark, or why there is none, and when it was done (the clock of `now`). */
interface Start {
  mark?: Mark;
  why?: ChangesWhy;
  doneAt: number;
}

/** One turn's marks and what its tools did. The registry keeps it on the turn. */
export class TurnChanges {
  readonly activity = new TurnActivity();
  /** Settles when the start mark is done or given up. */
  start!: Promise<Start>;
  /** The message that starts the turn may go: the start mark is done, or its deadline passed. */
  ready!: Promise<void>;
  /** When it ended (the clock of `now`); null while it runs. */
  ended: number | null = null;
  /** Its summary is made (or it went with no end): other chats' summaries no longer wait on it. */
  settled = false;
  constructor(
    readonly by: "user" | "agent",
    readonly chat: string = "",
    readonly cwd: string = "",
    /** When it began (the clock of `now`). */
    readonly began: number = 0,
    /** The folder's real path, for another chat's summary. */
    readonly real: Promise<string | null> = Promise.resolve(null),
  ) {}
}

/** A `!` command's run in a chat's folder: its window, for another chat's summary. */
interface Bang {
  chat: string;
  cwd: string;
  real: Promise<string | null>;
  start: number;
  end: number | null;
}

/** One chat's queue of marks, and its abort (Delete). */
interface ChatQueue {
  tail: Promise<unknown>;
  abort: AbortController;
  /** The changes folder passed its cap: no more marks. */
  over: boolean;
  /** The changes folder's size was measured since the server started. */
  measured: boolean;
  /** A start mark passed its deadline: messages are not held for the next ones until one is done in time. */
  slow: boolean;
}

/** One folder holds the other, or they are the same. */
const holds = (a: string, b: string) => a === b || b.startsWith(a.endsWith("/") ? a : `${a}/`);

/** The card of a summary: at most five files. */
export function cardOf(rec: TurnRecord): ChangesCard {
  return { id: rec.id, at: [...rec.at], how: rec.how, total: rec.total, added: rec.added, removed: rec.removed, files: rec.files.slice(0, CHANGES_LIMITS.eventFiles).map((f) => ({ ...f })) };
}

export type FileRead = { state: "no_turn" } | { state: "no_file" } | { state: "gone" } | { state: "failed" } | { state: "diff"; diff: FileDiff };

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<undefined>((r) => (t = setTimeout(() => r(undefined), ms)))]).finally(() => clearTimeout(t));
};

export class ChangesBook {
  private readonly store: ChangesStore;
  private readonly git: WorktreeGit;
  private readonly now: () => number;
  private readonly limits: ChangesLimits;
  private readonly chats = new Map<string, ChatQueue>();
  /** The marks and summaries queued or running, over every chat. */
  private pending = 0;
  /** Every chat's turns that a turn still waiting for its summary may overlap, and the `!` commands' windows. */
  private readonly turns = new Set<TurnChanges>();
  private readonly bangs = new Set<Bang>();

  constructor(private readonly deps: ChangesDeps) {
    this.store = deps.store;
    this.git = deps.git ?? worktreeGit(START_ENV);
    this.now = deps.now ?? Date.now;
    this.limits = {
      startMs: CHANGES_LIMITS.startMs,
      endMs: CHANGES_LIMITS.endMs,
      diffMs: CHANGES_LIMITS.diffMs,
      chatBytes: CHANGES_LIMITS.chatBytes,
      markFiles: CHANGES_LIMITS.markFiles,
      markBytes: CHANGES_LIMITS.markBytes,
      ...deps.limits,
    };
  }

  private queue(chat: string): ChatQueue {
    let q = this.chats.get(chat);
    if (!q) {
      q = { tail: Promise.resolve(), abort: new AbortController(), over: false, measured: false, slow: false };
      this.chats.set(chat, q);
    }
    return q;
  }

  /** Run `job` after the chat's marks before it (one at a time). */
  private serial<T>(chat: string, job: (q: ChatQueue) => Promise<T>): Promise<T> {
    const q = this.queue(chat);
    this.pending++;
    const run = q.tail.then(() => job(q)).finally(() => this.pending--);
    q.tail = run.catch(() => {});
    return run;
  }

  /** Resolves once no mark or summary is queued or running (a shutdown waits for the turns its close ended). */
  async idle(): Promise<void> {
    for (let round = 0; round < 100 && this.pending > 0; round++) await Promise.all([...this.chats.values()].map((q) => q.tail));
  }

  private get caps() {
    return { files: this.limits.markFiles, bytes: this.limits.markBytes };
  }

  private place(chat: string): MarkPlace {
    return placeOf(this.store.dirOf(chat));
  }

  /** A turn starts in the chat's folder `cwd`: its start mark is taken now (after the chat's marks before it). */
  begin(chat: string, cwd: string, by: "user" | "agent"): TurnChanges {
    const t = new TurnChanges(by, chat, cwd, this.now(), realpath(cwd).catch(() => null));
    this.turns.add(t);
    const deadline = performance.now() + this.limits.startMs;
    // A folder whose start mark came late before: the message goes at once (the mark holds as an agent's does).
    const hold = !this.queue(chat).slow;
    t.start = this.serial(chat, async (q): Promise<Start> => {
      const done = (s: Omit<Start, "doneAt">): Start => {
        // A mark done in time holds the next message again; one that came late (or never: the deadline) does not.
        if (s.mark) q.slow = false;
        else if (s.why === "no_start") q.slow = true;
        return { ...s, doneAt: this.now() };
      };
      if (this.store.isGone(chat) || q.abort.signal.aborted) return done({ why: "failed" });
      if (q.over) return done({ why: "full" });
      if (performance.now() >= deadline) return done({ why: "no_start" });
      const probe = await probeRepo(this.git, cwd, deadline, q.abort.signal);
      if (!probe.ok) return done({ why: probe.why === "failed" ? (performance.now() >= deadline ? "no_start" : "failed") : probe.why });
      const place = this.place(chat);
      try {
        await preparePlace(place);
      } catch {
        return done({ why: "failed" });
      }
      if (!q.measured) {
        // A chat with no objects yet (its first mark) has only its records to count: no git call for it.
        if ((await readdir(place.objects).catch(() => [] as string[])).length === 0) {
          q.measured = true;
          if ((await this.store.ownBytes(chat).catch(() => 0)) > this.limits.chatBytes) q.over = true;
        } else await this.measure(chat, probe.repo, place, deadline, q);
        if (q.over) return done({ why: "full" });
      }
      const why: MarkWhy = {};
      const mark = await takeMark(this.git, probe.repo, place, deadline, q.abort.signal, why, this.caps);
      const late = performance.now() >= deadline;
      if (mark) return done({ mark });
      const out = done({ why: why.why === "big" ? "big" : late ? "no_start" : "failed" });
      await this.afterFailed(chat, probe.repo, place, q);
      return out;
    });
    t.ready = hold ? within(t.start, this.limits.startMs).then(() => {}) : Promise.resolve();
    return t;
  }

  /**
   * A `!` command runs in the chat's folder `cwd` (the registry's runBash): its window, for the summaries of other
   * chats' turns in that folder. Call the result when it ends.
   */
  command(chat: string, cwd: string): () => void {
    const b: Bang = { chat, cwd, real: realpath(cwd).catch(() => null), start: this.now(), end: null };
    this.bangs.add(b);
    return () => {
      if (b.end === null) b.end = this.now();
      this.prune();
    };
  }

  /** A mark failed: the temporary objects of a killed git go, the mark's folder is emptied, the chat's bytes measured. */
  private async afterFailed(chat: string, repo: RepoAt, place: MarkPlace, q: ChatQueue): Promise<void> {
    await sweepObjects(place).catch(() => 0);
    await clearWork(place).catch(() => {});
    await this.measure(chat, repo, place, performance.now() + this.limits.startMs, q);
  }

  /** The turn is done with (its summary made, or it went): turns and `!` windows no unsettled turn overlaps go. */
  private settle(t: TurnChanges): void {
    t.settled = true;
    if (t.ended === null) t.ended = this.now();
    this.prune();
  }

  private prune(): void {
    let oldest = Number.POSITIVE_INFINITY;
    for (const o of this.turns) if (!o.settled) oldest = Math.min(oldest, o.began);
    for (const o of [...this.turns]) if (o.settled && (o.ended ?? 0) < oldest) this.turns.delete(o);
    for (const b of [...this.bangs]) if (b.end !== null && b.end < oldest) this.bangs.delete(b);
    // A turn that never settles (a bug) must not keep every other one: the oldest go past a cap.
    for (const o of this.turns) {
      if (this.turns.size <= 500) break;
      this.turns.delete(o);
    }
    for (const b of this.bangs) {
      if (this.bangs.size <= 500) break;
      this.bangs.delete(b);
    }
  }

  /**
   * What other chats did in this turn's folder while it ran: the targets of their file tools (relative to `cwd`), and
   * the windows of their commands (their Bash calls, their `!` commands) when their folder and this one hold each other.
   */
  private async elsewhereOf(t: TurnChanges, cwd: string, real: string | null): Promise<Elsewhere> {
    const from = t.began;
    const to = t.ended ?? this.now();
    const targets = new Set<string>();
    const spans: Span[] = [];
    const mine = real ?? cwd;
    const related = async (other: string, otherReal: Promise<string | null>) => {
      const r = (await otherReal) ?? other;
      return holds(mine, r) || holds(r, mine);
    };
    const overlaps = (start: number, end: number | null) => start <= to && (end ?? Number.POSITIVE_INFINITY) >= from;
    for (const o of this.turns) {
      if (o.chat === t.chat || !overlaps(o.began, o.ended)) continue;
      for (const p of o.activity.namedDuring(from, to)) {
        const rel = inFolder(isAbsolute(p) ? p : resolve(o.cwd, p), cwd, real);
        if (rel) targets.add(rel);
      }
      if (await related(o.cwd, o.real)) spans.push(...o.activity.commandSpans());
    }
    for (const b of this.bangs) {
      if (b.chat === t.chat || !overlaps(b.start, b.end)) continue;
      if (await related(b.cwd, b.real)) spans.push({ start: b.start, end: b.end });
    }
    const slack = CHANGES_LIMITS.slackMs;
    return { targets, inWindow: (c) => spans.some((s) => c >= s.start - slack && c <= (s.end ?? Number.POSITIVE_INFINITY) + slack) };
  }

  /** One event of the turn's process. */
  note(t: TurnChanges, e: ChatEvent): void {
    t.activity.note(e, this.now());
  }

  /**
   * The turn ended: its end mark and its summary, kept in the store. `ids`: the history ids of its first rows (the
   * notes' TurnNote `ids`). Resolves with the card, or null when the turn changed nothing that is its own (or `ids` is
   * empty, or the chat was deleted).
   */
  end(chat: string, cwd: string, t: TurnChanges, ids: readonly string[]): Promise<ChangesCard | null> {
    t.ended = this.now();
    t.activity.close(t.ended);
    const at = ids.slice(0, 2).map(pageRowId);
    const job = this.serial(chat, async (q) => {
      const began = performance.now();
      const deadline = began + this.limits.endMs;
      const start = await t.start;
      let tally: Tally | null = null;
      let marks: { from: string; to: string } | null = null;
      let why: ChangesWhy | undefined = start.why;
      let timeout = false;
      let capped = false;
      const real = await realpath(cwd).catch(() => null);
      if (start.mark && (t.activity.firstCall === null || start.doneAt <= t.activity.firstCall) && !q.over && !this.store.isGone(chat)) {
        const got = await this.gitSummary(chat, cwd, real, t, start.mark, deadline, q);
        if ("tally" in got) {
          tally = got.tally;
          marks = got.marks;
        } else {
          why = got.why === "big" ? "big" : "failed";
          timeout = got.timeout;
          capped = got.capped;
        }
      } else if (start.mark) why = q.over ? "full" : "no_start";
      let hunks: Record<string, EditHunk[]> | undefined;
      if (!tally) {
        const e = editsTally(t.activity, cwd, real);
        tally = e;
        hunks = Object.fromEntries(e.hunks);
      }
      const ms = performance.now() - began;
      if (!at.length || tally.total === 0 || this.store.isGone(chat)) {
        this.deps.log?.({ chat, ms, count: 0, ok: marks !== null, timeout, capped });
        return null;
      }
      const rec: TurnRecord = {
        id: newChangesId(),
        at,
        how: marks ? "git" : "edits",
        ...(marks ? { from: marks.from, to: marks.to } : { why: why ?? "failed" }),
        total: tally.total,
        added: tally.added,
        removed: tally.removed,
        others: tally.others,
        ...(tally.elsewhere > 0 ? { elsewhere: tally.elsewhere } : {}),
        files: tally.files.slice(0, CHANGES_LIMITS.files),
        made: new Date().toISOString(),
      };
      let kept = false;
      try {
        kept = await this.store.add(chat, rec, marks ? undefined : hunks);
      } catch {
        kept = false;
      }
      this.deps.log?.({ chat, ms, count: rec.total, ok: marks !== null, timeout, capped });
      return kept ? cardOf(rec) : null;
    });
    void job.then(
      () => this.settle(t),
      () => this.settle(t),
    );
    return job;
  }

  private async gitSummary(
    chat: string,
    cwd: string,
    real: string | null,
    t: TurnChanges,
    start: Mark,
    deadline: number,
    q: ChatQueue,
  ): Promise<{ tally: Tally; marks: { from: string; to: string } } | { timeout: boolean; capped: boolean; why?: MarkWhy["why"] }> {
    const signal = q.abort.signal;
    const failed = () => ({ timeout: performance.now() >= deadline, capped: false });
    const probe = await probeRepo(this.git, cwd, deadline, signal);
    if (!probe.ok) return failed();
    const place = this.place(chat);
    const why: MarkWhy = {};
    const end = await takeMark(this.git, probe.repo, place, deadline, signal, why, this.caps);
    if (!end) {
      const f = failed();
      await this.afterFailed(chat, probe.repo, place, q);
      // A listing past its cap is the one output a mark cuts (why `big`).
      return { ...f, capped: why.why === "big", why: why.why };
    }
    const raw = await diffMarks(this.git, probe.repo, place, start.tree, end.tree, deadline, signal);
    if (!raw) {
      const f = failed();
      await this.afterFailed(chat, probe.repo, place, q);
      return f;
    }
    const ctimes = new Map<string, number | null>();
    const paths = [...new Set([...raw.filter((r) => r.status !== "D").map((r) => r.path), ...end.large.keys(), ...start.large.keys()])];
    for (let i = 0; i < paths.length; i += 64) {
      if (performance.now() > deadline) return failed();
      const batch = paths.slice(i, i + 64);
      const st = await Promise.all(batch.map((p) => lstat(join(cwd, p)).catch(() => null)));
      batch.forEach((p, j) => ctimes.set(p, st[j] ? st[j]!.ctimeMs : null));
    }
    const targets = new Set<string>();
    for (const p of t.activity.targets) {
      const rel = inFolder(p, cwd, real);
      if (rel) targets.add(rel);
    }
    const elsewhere = await this.elsewhereOf(t, cwd, real);
    const tally = gitTally(raw, { activity: t.activity, targets, ctimes, startLarge: start.large, endLarge: end.large, elsewhere });
    await this.measure(chat, probe.repo, place, deadline, q);
    return { tally, marks: { from: start.tree, to: end.tree } };
  }

  /** The chat's changes folder in bytes (its objects, garbage too, and its records); past the cap, no more marks (DESIGN-U1 5). */
  private async measure(chat: string, repo: RepoAt, place: MarkPlace, deadline: number, q: ChatQueue): Promise<void> {
    const objects = await objectBytes(this.git, repo, place, deadline);
    const own = await this.store.ownBytes(chat).catch(() => 0);
    if (objects === null) return;
    q.measured = true;
    if (objects + own > this.limits.chatBytes) q.over = true;
  }

  /** A turn that went with no end (its process closed at kitespan's ask, a restart): its start mark is not used. */
  drop(t: TurnChanges): void {
    // Its start mark's objects stay (a later mark may share them); nothing else was kept.
    if (t.ended === null) t.ended = this.now();
    t.activity.close(t.ended);
    this.settle(t);
  }

  /** Delete: the chat's marks stop (their git is ended) and its changes folder goes. */
  async forget(chat: string): Promise<void> {
    const q = this.chats.get(chat);
    q?.abort.abort();
    this.chats.delete(chat);
    for (const t of [...this.turns]) if (t.chat === chat) this.turns.delete(t);
    for (const b of [...this.bangs]) if (b.chat === chat) this.bangs.delete(b);
    this.prune();
    await q?.tail;
    await this.store.remove(chat);
  }

  /** At the start: empty every chat's mark folder (what a mark that a crash or a kill cut left). */
  async sweep(): Promise<void> {
    for (const chat of await this.store.chatDirs().catch(() => [] as string[])) await clearWork(this.place(chat)).catch(() => {});
  }

  /** The chat's cards for history, by their turn's first rows (cardKey). */
  async cards(chat: string): Promise<Map<string, ChatEvent>> {
    const out = new Map<string, ChatEvent>();
    let list: TurnRecord[];
    try {
      list = await this.store.read(chat);
    } catch {
      return out;
    }
    for (const rec of list) out.set(cardKey(rec.at), { k: "changes", ...cardOf(rec) });
    return out;
  }

  /** The whole summary, or null when none of that id is kept. */
  async summary(chat: string, id: string): Promise<ChangesSummary | null> {
    const rec = await this.store.get(chat, id).catch(() => null);
    if (!rec) return null;
    return { ...cardOf(rec), files: rec.files.map((f) => ({ ...f })), ...(rec.why ? { why: rec.why } : {}), others: rec.others, ...(rec.elsewhere ? { elsewhere: rec.elsewhere } : {}) };
  }

  /** One file's diff in a turn (DESIGN-U1 9), read from the chat's folder `cwd`. */
  async file(chat: string, cwd: string, id: string, path: string): Promise<FileRead> {
    const rec = await this.store.get(chat, id).catch(() => null);
    if (!rec) return { state: "no_turn" };
    const f = rec.files.find((x) => x.path === path);
    if (!f) return { state: "no_file" };
    const began = performance.now();
    const deadline = began + this.limits.diffMs;
    const base = baseOf(f);
    const done = (r: FileRead): FileRead => {
      this.deps.log?.({ chat, ms: performance.now() - began, count: null, ok: r.state === "diff", timeout: r.state === "failed" && performance.now() >= deadline, capped: r.state === "diff" && (r.diff.large !== undefined || r.diff.cut !== undefined) });
      return r;
    };
    if (rec.how === "edits") {
      const all = await this.store.edits(chat, id).catch(() => ({}) as Record<string, never>);
      const text = (all[path] ?? []).map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`).join("\n");
      const p = parsePatch(text, { maxLines: CHANGES_LIMITS.lines, lineChars: CHANGES_LIMITS.lineChars });
      return done({ state: "diff", diff: { ...base, hunks: p.hunks, ...(p.cut ? { cut: p.cut } : {}), edits: true } });
    }
    if (f.large) {
      const st = await lstat(join(cwd, path)).catch(() => null);
      return done({ state: "diff", diff: { ...base, large: { bytes: st?.isFile() ? st.size : CHANGES_LIMITS.largeFileBytes }, hunks: [] } });
    }
    if (f.binary) return done({ state: "diff", diff: { ...base, hunks: [] } });
    if (!rec.from || !rec.to) return done({ state: "gone" });
    // The chat's folder went (moved, or its worktree removed): the marks cannot be read from it.
    if (!(await lstat(cwd).then((st) => st.isDirectory(), () => false))) return done({ state: "gone" });
    const probe = await probeRepo(this.git, cwd, deadline);
    if (!probe.ok) return done({ state: probe.why === "failed" ? "failed" : "gone" });
    const r = await readPatch(this.git, probe.repo, this.place(chat), { from: rec.from, to: rec.to }, { path, ...(f.from ? { from: f.from } : {}) }, deadline);
    if (r.ok) {
      const { patch } = r;
      return done({ state: "diff", diff: { ...base, ...(patch.binary ? { binary: true as const } : {}), hunks: patch.hunks, ...(patch.cut ? { cut: patch.cut } : {}) } });
    }
    if (r.why === "large") return done({ state: "diff", diff: { ...base, large: { bytes: r.bytes }, hunks: [] } });
    return done({ state: r.why });
  }
}

/** A file's diff's own facts, from its row. */
function baseOf(f: ChangedFile): FileDiff {
  return {
    path: f.path,
    status: f.status,
    ...(f.from ? { from: f.from } : {}),
    added: f.added,
    removed: f.removed,
    ...(f.binary ? { binary: true as const } : {}),
    ...(f.notebook ? { notebook: true as const } : {}),
    hunks: [],
  };
}
