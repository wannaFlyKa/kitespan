// The restart around the registry (DESIGN.md 4.10 steps 3 to 7; build checklist S9 to S13, L7, L12, L14): POST
// /api/restart calls `ask` once its preflight passed.
// - Restart when they finish: the registry drains (no new turn starts; a send is held, Queued; each live chat ends at
//   its next quiet moment), and every page gets one notice, "kitespan restarts when the running turns end.", with
//   Cancel restart and Restart now; a page that says hello while it waits gets it too (`standing`). Cancel undoes it.
//   When every chat sleeps, the close follows.
// - Restart now (or "now" while it waits): the close at once, which interrupts and closes every live chat.
// - The close: every page's notice of that id becomes "Restarting kitespan..." with no buttons (so a page that did not
//   press Restart says Restarting from here, not only from the `bye` up to about 8 s later, and tells the close from a
//   Cancel restart, whose notice is `gone`); a page that says hello meanwhile gets it too. Then every ledger, draft
//   and note written (the registry's shutdown with Restart now's stop lines), no claude child of the server left
//   (SIGKILL to one that is still there after 8 s), every Terminal pane's shell ended. Then the successor first
//   (bin/kitespan, which retries the bind), `bye {reason: "restart"}` and every socket closed with 1001, the release
//   (server.stop(true)), and the health gate: GET /api/health on 127.0.0.1 (a plain socket, no proxy) every 200 ms,
//   1 s per read, for up to 10 s, for an epoch that is not this server's. A good gate ends this server (exit 0); a
//   failed one stops the successor, listens again on the same port, tells every page (RESTART_FAILED_LINE, which stands
//   for a page that says hello until the next ask) and undoes the drain, so the pages come back to this epoch (that
//   notice also ends the close's Restarting line on a page that never got the `bye`); what Restart now cut says that
//   the restart did not happen.
//
// End it here and copy (S16, L16) is the registry's (endHere): its hand-over's length is here.

import { RESTART_FAILED_NOTICE, RESTART_NOTICE, type NoticeAction, type NoticeFrame } from "../../shared/protocol";
import type { DrainAnswer, RestartWhen } from "../http/api-types";
import type { LedgerProc } from "../store/types";
import type { Successor } from "../update/successor";
import { procLives, systemProcs, type ProcTable } from "./stops";

/** The drain notice (4.10 step 3): one line on every page, with its two buttons; its id takes it back. */
export const DRAIN_NOTICE_ID = RESTART_NOTICE;
export const DRAIN_LINE = "kitespan restarts when the running turns end.";
export const DRAIN_ACTIONS: readonly NoticeAction[] = ["cancel_restart", "restart_now"];
/** The close's notice (4.10 step 4): the drain notice's id, this line, no buttons; the page's own Restarting words. */
export const CLOSE_LINE = "Restarting kitespan...";

/**
 * S13: the restart did not happen: one notice to every page (RESTART_FAILED_NOTICE), the restart dialog's own words. It
 * stands until the next ask, so a page that says hello meanwhile (a phone that slept through it) gets it too; a page
 * that got `bye` and comes back to this epoch knows it from its `welcome` as well.
 */
export const RESTART_FAILED_LINE = "kitespan did not restart. Its lines are in server-out.log.";

/** L16: after End it here and copy, the chat is held as handed to the terminal for at most this long. */
export const HAND_OVER_MS = 10 * 60_000;

export const RESTART_LIMITS = {
  /** S11: how long the close waits for the claude children before SIGKILL. */
  childMs: 8_000,
  /** S13: the health gate's reads: one every 200 ms, each at most 1 s, for up to 10 s. */
  healthEveryMs: 200,
  healthPollMs: 1_000,
  healthMs: 10_000,
  /** The 202 of the request that asked goes out before the release closes its connection. */
  releaseAfterMs: 100,
} as const;
export type RestartLimits = { -readonly [K in keyof typeof RESTART_LIMITS]: number };

/** What the registry takes besides RegistryDeps for End it here (tests). */
export interface HandOverDeps {
  handOverMs?: number;
}

/** The registry's part of the restart (server/chats/registry.ts). */
export interface DrainRegistry {
  readonly epoch: string;
  drain(when: RestartWhen): DrainAnswer;
  undrain(): boolean;
  /** Every chat sleeps: no claude process of a chat is starting, running or ending. */
  asleep(): boolean;
  subscribe(fn: () => void): () => void;
  claudeProcs(): Promise<LedgerProc[]>;
  shutdown(opts: { by?: "shutdown" | "restart"; interrupt?: boolean }): Promise<void>;
  reopen(): Promise<void>;
}

/** What the restart needs of the server around the registry (main.ts gives the real parts; the tests, doubles). */
export interface RestartHost {
  registry: DrainRegistry;
  /** The chat socket's notice to every page. */
  notice(text: string, chat: string | undefined, more: Pick<NoticeFrame, "id" | "actions" | "gone">): void;
  /** `bye`, then every page's socket closed with 1001. */
  bye(reason: "restart"): void;
  /** Every Terminal pane's shell ends. */
  closeShells(): Promise<void>;
  /** About's hourly check of origin: off for the close, on again when the restart did not happen. */
  updates?: { stop(): void; start(): void };
  /** S12: start the successor; throws when it cannot start. */
  spawn(): Successor;
  /** Stop listening, every connection closed (server.stop(true)). */
  release(): Promise<void>;
  /** Listen again on the same port (a restart that did not happen). */
  relisten(): Promise<void>;
  /** One read of GET /api/health on 127.0.0.1: the epoch that answered, or null. */
  health(timeoutMs: number): Promise<string | null>;
  /** The successor runs: one line, then this server ends. */
  done(successor: Successor): void;
  /** The restart did not happen: one line for the terminal (the successor's own lines name the reason). */
  failed(): void;
  /**
   * Row 108: an update runs now (bin/update.sh holds the update lock; this server's own job starts none while a
   * restart drains or closes): the checkout and its build may not match yet, so no successor starts. Absent: none.
   */
  updating?: () => Promise<boolean>;
  procs?: ProcTable;
  limits?: Partial<RestartLimits>;
}

type Phase = "idle" | "waiting" | "closing";

/** The restart: one at a time, from the drain to the end of this server or back to work. */
export class Restart {
  private phase: Phase = "idle";
  /** A shutdown began (halt): nothing goes back to idle. */
  private halted = false;
  /** The close's notice stands: from the close until the restart did not happen. */
  private closeShown = false;
  /** The notice that the last restart did not happen stands: from then until the next drain or close (or a halt). */
  private failedShown = false;
  /** The successor from its start until it passed the health gate or was stopped: a halt stops it. */
  private successor: Successor | null = null;
  private stopWatch: (() => void) | null = null;
  private readonly lim: RestartLimits;

  constructor(private readonly host: RestartHost) {
    this.lim = { ...RESTART_LIMITS, ...host.limits };
  }

  /**
   * A restart's close runs (never a shutdown's): an ask now is that restart. Not once a restart that did not happen goes
   * back to work (back), which no successor follows.
   */
  get closing(): boolean {
    return this.phase === "closing" && !this.halted && this.closeShown;
  }

  /** A restart drains or closes now, or a shutdown began (row 108: no update starts then). */
  get active(): boolean {
    return this.phase !== "idle";
  }

  /**
   * POST /api/restart, after its preflight: the drain, or the close at once. While a restart's close runs (the drain's
   * last turn ended during the preflight, or another page asked), the ask is that restart; a shutdown refuses it, and so
   * does a restart that did not happen while it goes back to work.
   */
  ask(when: RestartWhen): DrainAnswer {
    if (this.phase === "closing") return this.closing ? { ok: true } : { ok: false, code: "restarting" };
    if (this.phase === "waiting") {
      if (when === "now") this.close(true);
      return { ok: true };
    }
    const answer = this.host.registry.drain(when);
    if (!answer.ok) return answer;
    this.failedShown = false;
    if (when === "now" || this.host.registry.asleep()) {
      this.close(when === "now");
      return { ok: true };
    }
    this.phase = "waiting";
    this.host.notice(DRAIN_LINE, undefined, { id: DRAIN_NOTICE_ID, actions: [...DRAIN_ACTIONS] });
    this.stopWatch = this.host.registry.subscribe(() => {
      if (this.phase === "waiting" && this.host.registry.asleep()) this.close(false);
    });
    return { ok: true };
  }

  /** Cancel restart (L14): only while the drain waits. */
  cancel(): boolean {
    if (this.phase !== "waiting" || !this.host.registry.undrain()) return false;
    this.unwatch();
    this.phase = "idle";
    this.host.notice("", undefined, { id: DRAIN_NOTICE_ID, gone: true });
    return true;
  }

  /**
   * SIGTERM or SIGINT: a shutdown, never a restart; a drain that waits ends without its close, and none starts. A close
   * that runs starts no successor from here and never listens again; a successor that has not passed the health gate
   * is stopped now, before the server's own stop ends this process.
   */
  halt(): void {
    this.unwatch();
    this.halted = true;
    this.phase = "closing";
    this.successor?.kill();
    this.successor = null;
  }

  /**
   * The notices that a page which says hello now gets: the drain's while it waits, the close's while it closes, and
   * after a restart that did not happen its notice until the next ask (a phone that slept through it: its ask is not
   * done). None after a halt.
   */
  standing(): Omit<NoticeFrame, "t">[] {
    if (this.phase === "waiting") return [{ text: DRAIN_LINE, id: DRAIN_NOTICE_ID, actions: [...DRAIN_ACTIONS] }];
    if (this.halted) return [];
    if (this.closeShown) return [{ text: CLOSE_LINE, id: DRAIN_NOTICE_ID }];
    return this.failedShown ? [{ text: RESTART_FAILED_LINE, id: RESTART_FAILED_NOTICE }] : [];
  }

  private unwatch(): void {
    this.stopWatch?.();
    this.stopWatch = null;
  }

  private close(interrupt: boolean): void {
    this.phase = "closing";
    this.unwatch();
    // Every page says Restarting from here, and the buttons go: Cancel can no longer work.
    this.closeShown = true;
    this.host.notice(CLOSE_LINE, undefined, { id: DRAIN_NOTICE_ID });
    // After this tick, so the request that asked gets its 202 first.
    setTimeout(() => {
      this.run(interrupt).catch(() => {
        this.successor?.kill();
        this.successor = null;
        return this.back(true);
      });
    }, 0);
  }

  /** The close; after each wait, a halt (the server's own stop) ends it, and the successor goes with it (halt). */
  private async run(interrupt: boolean): Promise<void> {
    const { registry } = this.host;
    const procs = this.host.procs ?? systemProcs;
    if (this.halted) return;
    this.host.updates?.stop();
    const deadline = Date.now() + this.lim.childMs;
    const before = await registry.claudeProcs();
    await registry.shutdown({ by: "restart", interrupt });
    await ensureGone(procs, [...before, ...(await registry.claudeProcs())], deadline - Date.now());
    await this.host.closeShells().catch(() => {});
    if (this.halted) return;
    // The preflight looked before the drain, which may have waited long: bin/update.sh may have begun since.
    if (await (this.host.updating?.() ?? Promise.resolve(false)).catch(() => false)) {
      await this.back(false);
      return;
    }
    if (this.halted) return;
    let successor: Successor;
    try {
      successor = this.host.spawn();
    } catch {
      await this.back(false);
      return;
    }
    this.successor = successor;
    await Bun.sleep(this.lim.releaseAfterMs);
    if (this.halted) return;
    this.host.bye("restart");
    await this.host.release();
    const passed = !this.halted && (await healthGate((ms) => this.host.health(ms), registry.epoch, successor.exited, this.lim));
    if (this.halted) return;
    this.successor = null;
    if (passed) {
      this.host.done(successor);
      return;
    }
    successor.kill();
    await this.back(true);
  }

  /**
   * The restart did not happen: listen again (when released), take work again, and the update check runs again. A
   * halt (the server's own stop) does none of it: that shutdown ends this server.
   */
  private async back(released: boolean): Promise<void> {
    // Before the port is back: a page that comes back to this server never gets the close's line again, but the
    // failure's.
    this.closeShown = false;
    if (this.halted) return;
    this.failedShown = true;
    this.host.failed();
    if (released) await this.host.relisten();
    if (this.halted) return;
    this.host.notice(RESTART_FAILED_LINE, undefined, { id: RESTART_FAILED_NOTICE });
    await this.host.registry.reopen();
    this.host.updates?.start();
    this.phase = "idle";
  }
}

/**
 * S11: wait until none of these claude processes lives (each known by its pid and start, so a pid that the system gave
 * again never counts), for at most `waitMs`; then SIGKILL each one that is left, and wait up to 1 s for it to go.
 * Returns how many got SIGKILL.
 */
export async function ensureGone(procs: ProcTable, list: readonly LedgerProc[], waitMs: number): Promise<number> {
  const seen = new Set<number>();
  let left = list.filter((p) => !seen.has(p.pid) && seen.add(p.pid));
  const alive = async (ps: readonly LedgerProc[]) => (await Promise.all(ps.map(async (p) => ((await procLives(procs, p)) ? p : null)))).filter((p): p is LedgerProc => p !== null);
  const end = Date.now() + Math.max(0, waitMs);
  for (;;) {
    left = await alive(left);
    if (left.length === 0) return 0;
    if (Date.now() >= end) break;
    await Bun.sleep(Math.min(50, Math.max(1, end - Date.now())));
  }
  for (const p of left) procs.kill(p.pid, "SIGKILL");
  const killed = left.length;
  const gone = Date.now() + 1_000;
  while (Date.now() < gone && (left = await alive(left)).length > 0) await Bun.sleep(20);
  return killed;
}

/**
 * S13: read the health route until an epoch that is not `own` answers (true), for at most `healthMs`; false when it
 * never does, or at once when the successor exits.
 */
export async function healthGate(
  read: (timeoutMs: number) => Promise<string | null>,
  own: string,
  exited: Promise<number>,
  lim: Pick<RestartLimits, "healthEveryMs" | "healthPollMs" | "healthMs">,
): Promise<boolean> {
  let dead = false;
  void exited.then(() => (dead = true));
  const end = Date.now() + lim.healthMs;
  while (!dead && Date.now() < end) {
    const epoch = await read(Math.max(1, Math.min(lim.healthPollMs, end - Date.now()))).catch(() => null);
    if (epoch !== null && epoch !== own) return true;
    if (dead) break;
    await Bun.sleep(Math.max(1, Math.min(lim.healthEveryMs, end - Date.now())));
  }
  return false;
}
