// The corpus cache (DESIGN.md 9.3; build checklist B3, B5): one corpus per real path of a chat's folder, so chats of
// one folder share it. It is built on the first read, one build per root at a time. A read of a corpus older than
// 10 s starts one rebuild and waits for it at most 250 ms; when it is not done by then, the read answers the corpus it
// has, and the rebuild lands for the next read. A rebuild that lists the same paths keeps its build (the same `v`),
// so the page's copy stands. A root is dropped after 10 minutes with no read, or by LRU past 4 roots or 300,000 paths.
// Memory only: nothing is written to the state folder or to the repository.
//
// One `corpus` log line per build: the chat that asked, git's exit code (null for the walk), the time, ok, timeout and
// capped. Never the root, a path, a name or a query; nothing per keystroke.

import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { CORPUS_LIMITS, type CorpusListReply, type CorpusSearchReply, type CorpusSource } from "../../shared/corpus";
import { Corpus, Scan, TOP_ROWS, warmScorer } from "../../shared/match";
import type { Logger } from "../log";
import { listCorpus, type CorpusListing } from "./build";

export const CORPUS_CACHE = {
  /** A corpus older than this is rebuilt on its next read. */
  staleMs: 10_000,
  /** How long a read waits for that rebuild before it answers the corpus it has. */
  waitMs: 250,
  /** A root with no read for this long is dropped. */
  idleMs: 10 * 60_000,
  /** The roots kept, and their paths together. */
  roots: 4,
  paths: 300_000,
  /** How often the idle roots are looked for. */
  sweepMs: 60_000,
} as const;

/** The list reply's JSON size (UTF-8 bytes) and its gzip body (level 6; null over the JSON cap): one per build. */
export interface ListBody {
  jsonBytes: number;
  gzip: Uint8Array<ArrayBuffer> | null;
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));
const gzipAsync = promisify(gzip);

const V_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
/** A build's id: 12 random letters and digits (shared/corpus.ts CORPUS_V). */
export function newCorpusV(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let v = "";
  for (const b of bytes) v += V_CHARS[b % V_CHARS.length];
  return v;
}

/** One build of a root's corpus, with what the routes make from it once: the body, the prepared corpus. */
export class CorpusBuild {
  readonly v: string;
  readonly source: CorpusSource;
  readonly complete: boolean;
  readonly paths: readonly string[];
  readonly total: number;
  /** The paths' characters (UTF-16 units), summed. */
  readonly chars: number;
  /** When the build, or a rebuild that found the same paths, ended (the cache's clock). */
  checkedAt: number;
  private body: Promise<ListBody> | null = null;
  private prepared: Promise<Corpus> | null = null;

  constructor(listing: Pick<CorpusListing, "source" | "paths" | "complete">, at: number, v: string = newCorpusV()) {
    this.v = v;
    this.source = listing.source;
    this.complete = listing.complete;
    this.paths = listing.paths;
    this.total = listing.paths.length;
    let chars = 0;
    for (const p of listing.paths) chars += p.length;
    this.chars = chars;
    this.checkedAt = at;
  }

  /** The same listing: a rebuild that found this keeps this build. */
  sameAs(l: Pick<CorpusListing, "source" | "paths" | "complete">): boolean {
    if (l.source !== this.source || l.complete !== this.complete || l.paths.length !== this.total) return false;
    for (let i = 0; i < this.total; i++) if (l.paths[i] !== this.paths[i]) return false;
    return true;
  }

  /** The list reply with every path. */
  listReply(): CorpusListReply {
    return { v: this.v, source: this.source, complete: this.complete, total: this.total, chars: this.chars, paths: this.paths as string[] };
  }

  /**
   * The list reply's JSON as UTF-8, made in steps of 20,000 paths that yield to the event loop between them (at
   * 100,000 paths, one JSON.stringify holds the loop for 8 to 27 ms). The same text as JSON.stringify(listReply()).
   */
  async listJson(): Promise<Uint8Array<ArrayBuffer>> {
    const step = CORPUS_LIMITS.yieldEvery;
    const parts: Buffer[] = [Buffer.from(JSON.stringify({ ...this.listReply(), paths: [] }).slice(0, -2))];
    for (let i = 0; i < this.total; i += step) {
      if (i > 0) {
        await yieldNow();
        parts.push(Buffer.from(","));
      }
      parts.push(Buffer.from(JSON.stringify(this.paths.slice(i, i + step)).slice(1, -1)));
    }
    parts.push(Buffer.from("]}"));
    return Buffer.concat(parts);
  }

  /**
   * The list reply's JSON size and its gzip body, made on the first ask and shared by every ask after it. The gzip
   * runs on zlib's thread pool (at 100,000 paths, Bun.gzipSync held the loop for about 95 ms, and every chat's stream
   * with it). A failure is not kept: the next ask makes the body again.
   */
  listBody(): Promise<ListBody> {
    if (!this.body) {
      const made = (async (): Promise<ListBody> => {
        const json = await this.listJson();
        if (json.byteLength > CORPUS_LIMITS.jsonBytes) return { jsonBytes: json.byteLength, gzip: null };
        return { jsonBytes: json.byteLength, gzip: await gzipAsync(json, { level: 6 }) };
      })();
      this.body = made;
      made.catch(() => {
        if (this.body === made) this.body = null;
      });
    }
    return this.body;
  }

  /**
   * The paths prepared for the matcher, in steps that yield to the event loop, then the scorer run once over them
   * (warmScorer, as the page does), so the first query is not the scorer's first run; one preparation per build.
   */
  corpus(): Promise<Corpus> {
    if (!this.prepared) {
      this.prepared = (async () => {
        const c = new Corpus(this.paths, this.v);
        while (!c.prepare(CORPUS_LIMITS.yieldEvery)) await yieldNow();
        warmScorer(c);
        return c;
      })();
    }
    return this.prepared;
  }
}

/** The answer for a folder that is not there (or not a folder): no paths, and no root to keep. */
const NONE_V = "none";

interface Held {
  root: string;
  build: CorpusBuild | null;
  building: Promise<CorpusBuild> | null;
  lastRead: number;
}

export interface CorpusCacheOptions {
  /** One build of a root (listCorpus by default). */
  list?: (root: string) => Promise<CorpusListing>;
  /** The real path of a chat's folder (realpath by default); null when it cannot be resolved. */
  realRoot?: (cwd: string) => Promise<string | null>;
  log?: Pick<Logger, "log"> | null;
  now?: () => number;
  limits?: Partial<Omit<typeof CORPUS_CACHE, "sweepMs">>;
  /** Look for idle roots on a timer (default true; tests call sweep()). */
  timer?: boolean;
}

/** What the API routes use. */
export interface CorpusService {
  /** The corpus of a chat's folder, for the list route: built if none, rebuilt when stale (waiting at most 250 ms). */
  read(cwd: string, chat: string | null): Promise<CorpusBuild>;
  /** The best rows for `q` from the corpus held (built once if none, never rebuilt); null when `signal` aborted. */
  search(cwd: string, chat: string | null, q: string, signal?: AbortSignal | null): Promise<CorpusSearchReply | null>;
}

export class CorpusCache implements CorpusService {
  /** The roots in the order of their last read, the oldest first. */
  private readonly held = new Map<string, Held>();
  private readonly list: (root: string) => Promise<CorpusListing>;
  private readonly realRoot: (cwd: string) => Promise<string | null>;
  private readonly log: Pick<Logger, "log"> | null;
  private readonly now: () => number;
  private readonly limits: Omit<typeof CORPUS_CACHE, "sweepMs">;
  private readonly useTimer: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CorpusCacheOptions = {}) {
    this.list = opts.list ?? ((root) => listCorpus(root));
    this.realRoot = opts.realRoot ?? ((cwd) => realpath(cwd).catch(() => null));
    this.log = opts.log ?? null;
    this.now = opts.now ?? Date.now;
    this.limits = { ...CORPUS_CACHE, ...opts.limits };
    this.useTimer = opts.timer ?? true;
  }

  /** The roots held now, the oldest read first (tests). */
  roots(): string[] {
    return [...this.held.keys()];
  }

  async read(cwd: string, chat: string | null): Promise<CorpusBuild> {
    const h = await this.hold(cwd);
    if (!h) return new CorpusBuild({ source: "none", paths: [], complete: true }, this.now(), NONE_V);
    if (!h.build) return this.rebuild(h, chat);
    if (this.now() - h.build.checkedAt <= this.limits.staleMs) return h.build;
    const old = h.build;
    const next = this.rebuild(h, chat);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), this.limits.waitMs)));
    const won = await Promise.race([next, late]).finally(() => clearTimeout(timer));
    return won ?? old;
  }

  async search(cwd: string, chat: string | null, q: string, signal: AbortSignal | null = null): Promise<CorpusSearchReply | null> {
    if (signal?.aborted) return null;
    const h = await this.hold(cwd);
    const build = !h ? new CorpusBuild({ source: "none", paths: [], complete: true }, this.now(), NONE_V) : (h.build ?? (await this.rebuild(h, chat)));
    if (signal?.aborted) return null;
    const corpus = await build.corpus();
    if (signal?.aborted) return null;
    const scan = new Scan(corpus, q, { limit: TOP_ROWS });
    // The scan yields every 20,000 paths, so a chat's stream waits a few milliseconds at most.
    while (!scan.step(CORPUS_LIMITS.yieldEvery)) {
      await yieldNow();
      if (signal?.aborted) return null;
    }
    const r = scan.result(q);
    return { v: build.v, total: build.total, count: r.count, rows: r.rows.map((x) => ({ path: x.path, nameRanges: x.nameRanges })) };
  }

  /** Drop the roots with no read for 10 minutes (a build that runs keeps its root). */
  sweep(): void {
    const now = this.now();
    for (const [root, h] of this.held) if (!h.building && now - h.lastRead > this.limits.idleMs) this.held.delete(root);
    this.idleTimer();
  }

  close(): void {
    this.held.clear();
    this.idleTimer();
  }

  /** The root's entry, read now (it moves to the end of the LRU order); null when the folder cannot be resolved. */
  private async hold(cwd: string): Promise<Held | null> {
    const root = await this.realRoot(cwd);
    if (root === null) return null;
    let h = this.held.get(root);
    if (h) this.held.delete(root);
    else h = { root, build: null, building: null, lastRead: 0 };
    h.lastRead = this.now();
    this.held.set(root, h);
    this.idleTimer();
    return h;
  }

  /** One build of the root at a time: a second ask shares the build that runs. */
  private rebuild(h: Held, chat: string | null): Promise<CorpusBuild> {
    if (h.building) return h.building;
    const run = (async () => {
      const listing = await this.list(h.root);
      this.logBuild(listing, chat);
      const prev = h.build;
      let build: CorpusBuild;
      if (prev && prev.sameAs(listing)) {
        prev.checkedAt = this.now();
        build = prev;
      } else build = new CorpusBuild(listing, this.now());
      if (this.held.get(h.root) === h) h.build = build;
      this.evict();
      return build;
    })();
    h.building = run;
    void run.finally(() => {
      if (h.building === run) h.building = null;
    }).catch(() => {});
    return run;
  }

  /** LRU past the root or path limit: the oldest read goes first, and the newest stays. */
  private evict(): void {
    let paths = 0;
    for (const h of this.held.values()) paths += h.build?.total ?? 0;
    for (const [root, h] of this.held) {
      if (this.held.size <= 1 || (this.held.size <= this.limits.roots && paths <= this.limits.paths)) break;
      this.held.delete(root);
      paths -= h.build?.total ?? 0;
    }
  }

  private logBuild(l: CorpusListing, chat: string | null): void {
    try {
      this.log?.log("corpus", { chat, code: l.code, ms: l.ms, ok: l.source !== "none", timeout: l.timeout, capped: l.capped });
      if (l.spawnFailed) this.log?.log("error", { chat, err: "corpus" });
    } catch {
      // the log never stops a read
    }
  }

  /** The sweep timer runs while a root is held, and never keeps the process alive. */
  private idleTimer(): void {
    if (!this.useTimer) return;
    if (this.held.size > 0 && !this.timer) {
      this.timer = setInterval(() => this.sweep(), CORPUS_CACHE.sweepMs);
      this.timer.unref?.();
    } else if (this.held.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
