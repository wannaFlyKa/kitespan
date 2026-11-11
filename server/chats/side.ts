// The side chat on the server (owner rows 124 and 125; DESIGN-R124 sections 9 and 10): one side thread per chat,
// kitespan's own state (store/side.ts), the same on every device and kept across a restart, never in Claude Code's
// transcript. A side question is asked on the chat's live process through the agent seam (AgentChat.sideQuestion);
// the registry gives that process (a sleeping chat wakes with no turn). Each change of the thread goes into the chat's
// ring as a `side`, `side_gone` or `side_clear` event with the thread's new `rev`, so every page shows the same thread,
// and is written at once.
//
// - One side question per chat at a time: another id while one runs is `busy`; a resend of the id that runs joins it,
//   and a resend of an answered id answers it again.
// - History: the answered exchanges that Claude Code answered (not the synthetic ones), oldest first, the newest 20,
//   as `{question, response}`.
// - Stop takes the question out of the thread (`side_gone`); every other cut (the process ended, Archive, a shutdown,
//   kitespan's own 12-minute bound) fails it, as does an answer that never came. A Delete leaves nothing behind.
// - The thread keeps at most 20 answered exchanges (the oldest goes when a 21st lands) and at most one more, the last,
//   that asks or failed; a new question replaces a failed one. The file is at most 1 MiB (the oldest answered go
//   first). At the first read after a boot, an exchange that was asking reads as failed.

import { SIDE_LIMITS, capText, type ChatEvent, type ErrorCode, type SideExchange, type SideRead } from "../../shared/protocol";
import type { AgentChat, SideProgress, SideTurn } from "../agents/types";
import type { LogError, LogEvent, LogFields } from "../log";
import { SIDE_FILE_BYTES, type SideRecord } from "../store/side";
import type { Store } from "../store/types";
import type { Outcome } from "./types";

export interface SideHost {
  store: Pick<Store, "readSide" | "writeSide">;
  now(): Date;
  /** Number the event in the chat's ring and give it to every viewer (the registry's emit). */
  emit(chat: string, e: ChatEvent): void;
  /** A side question began or settled: the idle rule and the cap look again. */
  changed(chat: string): void;
  /** The ack code of an error that the agent's side question threw (the registry's driverErrorCode). */
  codeOf(e: unknown): ErrorCode;
  log(ev: LogEvent, f: LogFields): void;
  error(err: LogError, chat: string | null): void;
  /** kitespan's own bound on one side question (tests); SIDE_LIMITS.deadlineMs by default. */
  deadlineMs?: number;
}

/**
 * Why a side question in flight was cut: `stop` (Stop) takes it out of the thread; `deleted` (Delete) leaves nothing;
 * every other one fails it.
 */
export type SideCut = "stop" | "ended" | "archived" | "deleted" | "shutdown" | "deadline";

/** What opens the chat's live process for a side question (the registry's): the process, or why there is none. */
export type SideOpen = (signal: AbortSignal) => Promise<AgentChat | ErrorCode>;

interface Thread {
  rev: number;
  exchanges: SideExchange[];
}

interface Run {
  id: string;
  abort: AbortController;
  /** The process that the question went to, once it went. */
  chat: AgentChat | null;
  done: Promise<Outcome>;
}

const ok = (result: unknown): Outcome => ({ ok: true, result });
const fail = (code: ErrorCode): Outcome => ({ ok: false, code });
const CUT_CODES: Record<Exclude<SideCut, "stop" | "deleted">, ErrorCode> = { ended: "failed", archived: "archived", shutdown: "failed", deadline: "failed" };
const isCut = (v: unknown): v is SideCut => typeof v === "string" && (v === "stop" || v === "deleted" || Object.hasOwn(CUT_CODES, v));
const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/** The history a question goes with: the answered, not synthetic exchanges but `id`, oldest first, the newest 20. */
export function sideHistory(exchanges: readonly SideExchange[], id: string): SideTurn[] {
  return exchanges
    .filter((x) => x.state === "answered" && x.synthetic !== true && x.id !== id)
    .slice(-SIDE_LIMITS.kept)
    .map((x) => ({ question: x.question, response: x.answer ?? "" }));
}

/**
 * The thread with `x` in it: the answered exchanges but `x`, then `x` (an answered one joins them; one that asks or
 * failed is the last, in a failed one's place), the newest 20 answered kept, and the oldest answered left out while the
 * file would be over 1 MiB. Without `x`: the thread less exchange `drop`.
 */
export function sidePut(exchanges: readonly SideExchange[], x: SideExchange | null, drop?: string): SideExchange[] {
  let list = x ? [...exchanges.filter((y) => y.id !== x.id && y.state === "answered"), x] : exchanges.filter((y) => y.id !== drop);
  const over = list.filter((y) => y.state === "answered").length - SIDE_LIMITS.kept;
  if (over > 0) {
    let n = over;
    list = list.filter((y) => !(y.state === "answered" && n-- > 0));
  }
  while (list.length > 1 && bytesOf({ v: 1, id: "a".repeat(20), rev: Number.MAX_SAFE_INTEGER, exchanges: list }) > SIDE_FILE_BYTES) list = list.slice(1);
  return list;
}

/** A thread as the file holds it, with an exchange that was asking when the server stopped read as failed. */
function threadOf(rec: SideRecord | null): Thread {
  if (!rec) return { rev: 0, exchanges: [] };
  return {
    rev: rec.rev,
    exchanges: rec.exchanges.map((x) => (x.state === "asking" ? { id: x.id, question: x.question, at: x.at, state: "failed", error: "failed" } : x)),
  };
}

export class SideThreads {
  private readonly threads = new Map<string, Thread>();
  private readonly loads = new Map<string, Promise<Thread>>();
  private readonly runs = new Map<string, Run>();
  /** Deleted chats: nothing of theirs is read, written or sent again (chat ids are never used again). */
  private readonly gone = new Set<string>();
  /** Each chat's file writes, one after another. */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly host: SideHost) {}

  /** A side question runs in the chat (the idle rule and the cap keep its process). */
  running(chat: string): boolean {
    return this.runs.has(chat);
  }

  /** `get side`: the thread, at most SIDE_LIMITS.readBytes of JSON (the oldest exchanges left out of a larger one). */
  async read(chat: string): Promise<SideRead> {
    const t = await this.load(chat);
    const out: SideRead = { rev: t.rev, exchanges: t.exchanges.map((x) => structuredClone(x)) };
    while (out.exchanges.length > 1 && bytesOf(out) > SIDE_LIMITS.readBytes) out.exchanges.shift();
    return out;
  }

  /**
   * A side question `id` with `text` (already checked: sideQuestionText). `open` gives the chat's live process. The
   * outcome is the question's ack: `{answered}`, `{stopped: true}`, or the code of why it did not finish.
   */
  ask(chat: string, id: string, text: string, open: SideOpen): Promise<Outcome> {
    const was = this.runs.get(chat);
    if (was) return was.id === id ? was.done : Promise.resolve(fail("busy"));
    const run: Run = { id, abort: new AbortController(), chat: null, done: Promise.resolve(fail("failed")) };
    this.runs.set(chat, run);
    const t0 = performance.now();
    run.done = this.run(chat, run, text, open)
      .catch(() => {
        this.host.error("unknown", chat);
        return fail("failed");
      })
      .then((o) => {
        if (this.runs.get(chat) === run) this.runs.delete(chat);
        this.host.log("side", { chat, ok: o.ok, ms: performance.now() - t0 });
        this.host.changed(chat);
        return o;
      });
    this.host.changed(chat);
    return run.done;
  }

  /** Stop on side question `id`: true once it is out of the thread; false when it had settled (or another one runs). */
  async stop(chat: string, id: string): Promise<boolean> {
    const run = this.runs.get(chat);
    if (!run || run.id !== id || run.abort.signal.aborted) return false;
    run.abort.abort("stop" satisfies SideCut);
    const o = await run.done;
    return o.ok && (o.result as { stopped?: unknown } | null)?.stopped === true;
  }

  /** Clear: the thread empties for every page. False while a side question runs. */
  async clear(chat: string): Promise<boolean> {
    if (this.runs.has(chat)) return false;
    const t = await this.load(chat);
    if (this.runs.has(chat)) return false;
    if (t.exchanges.length === 0 || this.gone.has(chat)) return true;
    t.exchanges = [];
    t.rev++;
    this.host.emit(chat, { k: "side_clear", rev: t.rev });
    await this.save(chat, t);
    return true;
  }

  /** Cut the chat's side question in flight, if one runs (`agent`: only the one that went to that process). */
  abort(chat: string, why: SideCut, agent?: AgentChat): void {
    const run = this.runs.get(chat);
    if (!run || run.abort.signal.aborted || (agent && run.chat !== agent)) return;
    run.abort.abort(why);
  }

  /** Every side question in flight is cut (a shutdown). */
  abortAll(why: SideCut): void {
    for (const chat of [...this.runs.keys()]) this.abort(chat, why);
  }

  /** Delete: the chat's question in flight leaves nothing behind, and its thread is forgotten. */
  forget(chat: string): void {
    this.gone.add(chat);
    this.abort(chat, "deleted");
    this.threads.delete(chat);
    this.loads.delete(chat);
  }

  /** Every side question in flight has settled (tests, a shutdown's wait). */
  async idle(): Promise<void> {
    await Promise.all([...this.runs.values()].map((r) => r.done));
    await Promise.all([...this.writes.values()]);
  }

  // -------------------------------------------------------------------------------------------------------------

  private load(chat: string): Promise<Thread> {
    const t = this.threads.get(chat);
    if (t) return Promise.resolve(t);
    let p = this.loads.get(chat);
    if (!p) {
      p = this.host.store
        .readSide(chat)
        .catch(() => {
          this.host.error("store_read", chat);
          return null;
        })
        .then((rec) => {
          const t = this.threads.get(chat) ?? threadOf(rec);
          if (!this.gone.has(chat)) this.threads.set(chat, t);
          this.loads.delete(chat);
          return t;
        });
      this.loads.set(chat, p);
    }
    return p;
  }

  /** The thread's file, now (a copy of the thread as it is at the call), after the chat's writes before it. */
  private save(chat: string, t: Thread): Promise<void> {
    const rec: SideRecord = { v: 1, id: chat, rev: t.rev, exchanges: t.exchanges.map((x) => structuredClone(x)) };
    const p = (this.writes.get(chat) ?? Promise.resolve())
      .then(() => (this.gone.has(chat) ? undefined : this.host.store.writeSide(rec)))
      .catch(() => this.host.error("store_write", chat));
    this.writes.set(chat, p);
    void p.then(() => {
      if (this.writes.get(chat) === p) this.writes.delete(chat);
    });
    return p;
  }

  /** One change of the thread: `x` in it (or exchange `drop` out of it), the rev one higher, the event, the file. */
  private change(chat: string, t: Thread, x: SideExchange | null, drop?: string): Promise<void> {
    if (this.gone.has(chat)) return Promise.resolve();
    t.exchanges = sidePut(t.exchanges, x, drop);
    t.rev++;
    this.host.emit(chat, x ? { k: "side", rev: t.rev, x: structuredClone(x) } : { k: "side_gone", rev: t.rev, id: drop! });
    return this.save(chat, t);
  }

  private async run(chat: string, run: Run, text: string, open: SideOpen): Promise<Outcome> {
    const signal = run.abort.signal;
    const timer = setTimeout(() => run.abort.abort("deadline" satisfies SideCut), this.host.deadlineMs ?? SIDE_LIMITS.deadlineMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const t = await this.load(chat);
      if (this.gone.has(chat)) return fail("not_found");
      const was = t.exchanges.find((x) => x.id === run.id);
      if (was?.state === "answered") return ok({ answered: structuredClone(was) });
      const asking: SideExchange = { id: run.id, question: text, at: this.host.now().toISOString(), state: "asking" };
      void this.change(chat, t, asking);
      // The ask goes with the thread as it was before this question.
      const history = sideHistory(t.exchanges, run.id);
      let got: Raced<AgentChat | ErrorCode>;
      try {
        got = await raced(open(signal), signal);
      } catch {
        got = { cut: false, value: "failed" };
      }
      if (got.cut) return this.cut(chat, t, asking, signal.reason);
      if (typeof got.value === "string") return this.failed(chat, t, asking, got.value);
      run.chat = got.value;
      let cur = asking;
      let settled = false;
      const onProgress = (p: SideProgress) => {
        if (p.status !== "api_retry" || settled || signal.aborted || this.runs.get(chat) !== run) return;
        cur = { ...cur, retry: { attempt: p.attempt, max: p.max, delayMs: p.delayMs } };
        void this.change(chat, t, cur);
      };
      let answer: Awaited<ReturnType<AgentChat["sideQuestion"]>>;
      try {
        answer = await got.value.sideQuestion(text, { history, signal, onProgress });
      } catch (e) {
        settled = true;
        if (signal.aborted) return this.cut(chat, t, cur, signal.reason);
        return this.failed(chat, t, cur, this.host.codeOf(e));
      }
      settled = true;
      if (answer === null) return this.failed(chat, t, cur, "failed");
      const done: SideExchange = {
        id: run.id,
        question: text,
        at: asking.at,
        state: "answered",
        answer: capText(answer.response, SIDE_LIMITS.answer),
        ...(answer.synthetic ? { synthetic: true as const } : {}),
        ...(answer.fallback ? { fallback: answer.fallback } : {}),
      };
      if (this.gone.has(chat)) return fail("not_found");
      await this.change(chat, t, done);
      return ok({ answered: structuredClone(done) });
    } finally {
      clearTimeout(timer);
    }
  }

  /** A cut question: Stop takes it out of the thread; Delete leaves nothing; every other cut fails it. */
  private async cut(chat: string, t: Thread, x: SideExchange, why: unknown): Promise<Outcome> {
    const reason: SideCut = isCut(why) ? why : "ended";
    if (reason === "deleted" || this.gone.has(chat)) return fail("not_found");
    if (reason === "stop") {
      await this.change(chat, t, null, x.id);
      return ok({ stopped: true });
    }
    return this.failed(chat, t, x, CUT_CODES[reason]);
  }

  private async failed(chat: string, t: Thread, x: SideExchange, code: ErrorCode): Promise<Outcome> {
    if (this.gone.has(chat)) return fail("not_found");
    await this.change(chat, t, { id: x.id, question: x.question, at: x.at, state: "failed", error: code });
    return fail(code);
  }
}

type Raced<T> = { cut: true } | { cut: false; value: T };

/** `p`'s value, or `cut` once `signal` aborted first. */
function raced<T>(p: Promise<T>, signal: AbortSignal): Promise<Raced<T>> {
  if (signal.aborted) return Promise.resolve({ cut: true });
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ cut: true });
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? { cut: true } : { cut: false, value });
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
