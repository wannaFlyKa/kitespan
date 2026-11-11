// About's update lines (DESIGN.md 4.10; build checklist S3, S4; owner row 108): "Update available" from origin, and
// "Restart to apply" or "The update did not finish" from the build stamp, read again each time About asks (no file
// watcher: the read is cheap and only About shows it). The running server's HEAD is read once, at start.
// `welcome.update` carries origin's line; a change of it is one notice (main.ts).
//
// The schedule (row 108), from the setting "Check for updates" (settings.json `updates.check`, the same on every
// device): Manually runs no check by itself, at start or on a timer; Daily and Every 3 hours check when the last check
// is older than that (its time is kept in the state folder's update.json, so a restart does not check again at once),
// then on that interval, each time with a few minutes of random spread. A change of the setting takes effect at once
// (reload), and so does a Check now, which every mode has: the next check counts from it. update.json also keeps
// origin's commit that the last check read, so a new process (a restart, a crash, a reboot) shows the same line at
// once: the ancestor rule again against that commit, with local reads only (remote.ts keptRemote), and no check of
// origin before it is due.
//
// An installed kitespan (DESIGN-I1 3.1, 3.2, 3.5; kind.ts): a release install has the same setting, schedule,
// update.json and Check now, with its own read (release.ts), and update.json keeps the newest version that the last
// check read (`release`) in origin's place; a Homebrew install never checks (no read, no timer). For both, the build
// line is the next start's root (kind.ts nextRoot, read again at each look): "Restart to apply" when it is another
// version's folder with its page and stamp (any head), "The update did not finish" when it is another and not whole.

import { lstatSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { UpdateKind } from "../../shared/protocol";
import { RELEASE_VERSION } from "../../shared/release";
import { isUpdateRefusal, UPDATE_CHECK_DEFAULT, UPDATE_CHECK_EVERY_MS, UPDATE_REFUSAL_LINES, UPDATE_WORDS, type UpdateCheck, type UpdateRefusal } from "../../shared/update";
import type { Logger } from "../log";
import { ownUid, readJson, writeAtomic } from "../store/files";
import { gitHead, type GitOptions } from "./git";
import { versionAt, type InstallKindName } from "./kind";
import { checkRemote, keptRemote, originCommitOf, type OriginCommit, type RemoteCheck, type RemoteKind } from "./remote";
import { buildKind, readStamp, type BuildKind } from "./stamp";

export const CHECK_LIMITS = {
  /** The most random spread added to a check on the interval. */
  spreadMs: 5 * 60_000,
} as const;

/** The notice that a change of the update line sends (its id replaces the last one on every page). */
export const UPDATE_NOTICE_ID = "update";

/** The state folder's record of the last check. */
export const UPDATE_STATE = "update.json";

/** The words of origin's line (the notice) and the restart's refusal for a build that did not finish. */
export const UPDATE_LINES = {
  available: UPDATE_WORDS.availableNotice,
  diverged: UPDATE_REFUSAL_LINES.diverged,
  unfinished: "The update did not finish. Update again first.",
} as const;

export interface UpdateFacts {
  update: RemoteKind;
  build: BuildKind;
  /** How this kitespan was installed (kind.ts). */
  kind: InstallKindName;
  /** A release install: the newest release the last check read, while it shows Update available; else null. */
  latest: string | null;
  /** A release or brew install: the version that the next start runs, when that is another folder; else null. */
  next: string | null;
}

/** The last check: when it ran, whether it read origin, and why it could not look (no upstream, ...). */
export interface LastCheck {
  at: string;
  ok: boolean;
  why: UpdateRefusal | null;
}

export interface Updates {
  /** The running server's HEAD, read at start; null outside a git checkout or without git. */
  readonly runningHead: string | null;
  /** Origin's line as the last check found it ("none" before the first one ends). */
  readonly remote: RemoteKind;
  /** The last check, or null when none ever ran. */
  readonly last: LastCheck | null;
  /** A check runs now. */
  readonly checking: boolean;
  /** When the timer runs the next check (ms since the epoch), or null: none is set (Manually, or stopped). */
  readonly next: number | null;
  /** Resolves when the schedule has settled after start() or reload() (tests). */
  settled(): Promise<void>;
  /** welcome.update. */
  welcome(): { available: boolean; kind: UpdateKind };
  /** About's lines now: origin's from the last check, the build's read again. */
  facts(): Promise<UpdateFacts>;
  /** One check now (Check now, a job's end); resolves with origin's line. The next check on the timer counts from it. */
  check(): Promise<RemoteKind>;
  /**
   * An update's steps ended well: origin's commit that its fetch read is in HEAD, so origin's line is none at once (a
   * check that began before says nothing about it; the one that follows the job reads origin again).
   */
  fastForwarded(): void;
  /** The schedule from the setting: the last check's time read first; a check at once when it is due. */
  start(): void;
  /** No check on the timer (the restart's close, a shutdown); start() again resumes it. */
  stop(): void;
  /** The setting changed: the schedule again at once. */
  reload(): void;
  /** Each change of origin's line. */
  onChange(fn: (kind: RemoteKind) => void): () => void;
}

export interface UpdatesOptions {
  /** The checkout's top folder (the repository root). */
  root: string;
  /** The build folder, where build.json is. */
  dist: string;
  /** Dev mode serves web/ itself: no build line. */
  dev: boolean;
  git: GitOptions;
  log?: Pick<Logger, "log"> | null;
  /** The setting now (settings.json); default Daily. */
  setting?: () => Promise<UpdateCheck>;
  /** The state folder, for update.json; absent: the last check is kept in memory only. */
  state?: string;
  /** The check itself (tests; a release install's read); default checkRemote of the checkout. */
  checkOnce?: () => Promise<RemoteCheck & { release?: string }>;
  /** Origin's line from a kept commit, at start (tests); default keptRemote of the checkout. */
  localOnce?: (kept: OriginCommit) => Promise<RemoteCheck>;
  /** How this kitespan was installed (kind.ts); default a checkout. brew: no check ever. */
  kind?: InstallKindName;
  /** A release or brew install: the root that the next start runs, read again at each look (kind.ts nextRoot). */
  next?: () => string | null;
  /** A release install: the line again from the version that update.json kept, with no read (release.ts). */
  release?: { local(latest: string): RemoteCheck & { release?: string } };
  now?: () => number;
  /** 0 to 1, for the spread (tests). */
  random?: () => number;
}

const FAILED_READ: RemoteCheck = { kind: "none", failed: true };

function lastFrom(v: unknown): LastCheck | null {
  const o = v as { v?: unknown; at?: unknown; ok?: unknown; why?: unknown } | null;
  if (!o || typeof o !== "object" || o.v !== 1 || typeof o.at !== "string" || !Number.isFinite(Date.parse(o.at)) || typeof o.ok !== "boolean") return null;
  return { at: new Date(Date.parse(o.at)).toISOString(), ok: o.ok, why: isUpdateRefusal(o.why) ? o.why : null };
}

/** A build folder with its page and a stamp that reads (any head: the head is a checkout's notion). */
function wholeBuild(dist: string): boolean {
  try {
    if (!lstatSync(join(dist, "index.html")).isFile()) return false;
  } catch {
    return false;
  }
  return readStamp(dist) !== null;
}

export async function createUpdates(o: UpdatesOptions): Promise<Updates> {
  const kind: InstallKindName = o.kind ?? "checkout";
  // An install holds no checkout: no git runs for it (a folder above it may be another repository).
  const runningHead = kind === "checkout" ? await gitHead(o.root, o.git) : null;
  const ownRoot = (() => {
    if (kind === "checkout") return o.root;
    try {
      return realpathSync(o.root);
    } catch {
      return o.root;
    }
  })();
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  const setting = o.setting ?? (async () => UPDATE_CHECK_DEFAULT);
  const checkOnce: () => Promise<RemoteCheck & { release?: string }> = o.checkOnce ?? (() => checkRemote(o.root, o.git));
  const localOnce = o.localOnce ?? ((k: OriginCommit) => keptRemote(o.root, o.git, k));
  let remote: RemoteKind = "none";
  let last: LastCheck | null = null;
  /** Origin's commit that the last check read (update.json), or null. */
  let kept: OriginCommit | null = null;
  /** A release install: the newest version that the last check read (update.json `release`), or null. */
  let keptRelease: string | null = null;
  let lastRead = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let on = false;
  /** Each arm() bumps it, so an arm that a later one overtook (its setting read was slow) sets no timer. */
  let armed = 0;
  let inFlight: Promise<RemoteKind> | null = null;
  /** fastForwarded() bumps it: a check that began before then leaves origin's line as it is. */
  let moved = 0;
  const listeners = new Set<(kind: RemoteKind) => void>();
  const changed = (kind: RemoteKind) => {
    if (kind === remote) return;
    remote = kind;
    for (const fn of listeners) fn(remote);
  };

  const readLast = async () => {
    if (lastRead || !o.state) return;
    lastRead = true;
    try {
      const r = await readJson(join(o.state, UPDATE_STATE), 4096, ownUid());
      if (r.kind === "ok") {
        last = lastFrom(r.value) ?? last;
        if (last) kept = originCommitOf((r.value as { origin?: unknown }).origin);
        const rel = (r.value as { release?: unknown }).release;
        if (last) keptRelease = typeof rel === "string" && RELEASE_VERSION.test(rel) ? rel : null;
      }
    } catch {
      // none kept: the first check is due
    }
  };
  const writeLast = async () => {
    if (!o.state || !last) return;
    try {
      await writeAtomic(o.state, UPDATE_STATE, `${JSON.stringify({ v: 1, ...last, ...(kept ? { origin: kept } : {}), ...(keptRelease ? { release: keptRelease } : {}) })}\n`, 4096, ownUid());
    } catch {
      o.log?.log("error", { err: "store_write" });
    }
  };

  let nextAt: number | null = null;
  let arming: Promise<void> = Promise.resolve();
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    nextAt = null;
  };

  /** The next check from the setting and the last check's time: at once when it is due, else at its time plus spread. */
  async function armOnce(): Promise<void> {
    const mine = ++armed;
    clear();
    if (!on || kind === "brew") return;
    await readLast();
    let pick: UpdateCheck;
    try {
      pick = await setting();
    } catch {
      pick = UPDATE_CHECK_DEFAULT;
    }
    if (mine !== armed || !on || pick === "manual") return;
    const every = UPDATE_CHECK_EVERY_MS[pick];
    const due = last ? Date.parse(last.at) + every : now();
    const wait = due <= now() ? 0 : due - now() + Math.floor(random() * CHECK_LIMITS.spreadMs);
    nextAt = now() + wait;
    timer = setTimeout(() => {
      timer = null;
      nextAt = null;
      void check();
    }, wait);
    timer.unref?.();
  }
  const arm = (): Promise<void> => (arming = armOnce());

  const check = (): Promise<RemoteKind> => {
    // Homebrew's own `brew outdated` says it: no read ever.
    if (kind === "brew") return Promise.resolve(remote);
    const since = moved;
    inFlight ??= checkOnce()
      .catch((): RemoteCheck & { release?: string } => ({ kind: "none", failed: true }))
      .then(async (r) => {
        if (r.failed) o.log?.log("error", { err: "update" });
        last = { at: new Date(now()).toISOString(), ok: !r.failed, why: r.why ?? null };
        if (since === moved) {
          kept = r.origin ?? null;
          keptRelease = r.release ?? null;
        }
        lastRead = true;
        await writeLast();
        if (since === moved) changed(r.kind);
        return remote;
      })
      .finally(() => {
        inFlight = null;
        void arm();
      });
    return inFlight;
  };

  // A new process shows the line that the last check found, read again against this checkout's HEAD now.
  await readLast();
  if (kept && kind === "checkout") {
    const r = await localOnce(kept).catch((): RemoteCheck => FAILED_READ);
    if (!r.failed) remote = r.kind;
  } else if (keptRelease && kind === "release" && o.release) {
    try {
      const r = o.release.local(keptRelease);
      if (!r.failed) remote = r.kind;
    } catch {
      // the line waits for the next check
    }
  }

  return {
    runningHead,
    get remote() {
      return remote;
    },
    get last() {
      return last;
    },
    get checking() {
      return inFlight !== null;
    },
    get next() {
      return nextAt;
    },
    async settled() {
      await arming;
    },
    welcome: () => ({ available: remote === "available", kind: remote }),
    async facts() {
      await readLast();
      if (kind === "checkout") {
        const checkout = await gitHead(o.root, o.git);
        return { update: remote, build: buildKind({ dev: o.dev, stamp: readStamp(o.dist), checkout, running: runningHead }), kind, latest: null, next: null };
      }
      let t: string | null = null;
      try {
        t = o.next?.() ?? null;
      } catch {
        t = null;
      }
      const other = t !== ownRoot;
      const build: BuildKind = o.dev || !other ? "none" : t !== null && wholeBuild(join(t, "dist", "web")) ? "apply" : "unfinished";
      const next = t !== null && other ? (versionAt(t) ?? (kind === "release" ? basename(t) : null)) : null;
      const latest = kind === "release" && remote === "available" ? keptRelease : null;
      return { update: remote, build, kind, latest, next };
    },
    check,
    fastForwarded() {
      moved++;
      changed("none");
    },
    start() {
      if (on || kind === "brew") return;
      on = true;
      void arm();
    },
    stop() {
      on = false;
      armed++;
      clear();
    },
    reload() {
      void arm();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
