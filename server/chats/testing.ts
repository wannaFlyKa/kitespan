// Test doubles of the two seams the registry stands on: a scripted AgentDriver (no SDK, no process, no model) and an
// in-memory Store. The unit and protocol tests of the registry and the chat socket use them; the server never
// imports this file.

import { MODE_IDS, emptyDraft, type BgStopAnswer, type ChatEvent, type DraftBox, type DraftState, type CommandInfo, type ConnectorInfo, type ContextInfo, type EffortId, type ModeId, type ModelInfo, type RequestFrame } from "../../shared/protocol";
import type {
  AgentCapabilities,
  AgentChat,
  AgentDriver,
  AgentSettings,
  BgList,
  BgListRow,
  BgRecord,
  BinaryProbe,
  Card,
  CardAnswer,
  HistoryPageRequest,
  OpenInput,
  SessionInfo,
  SessionOpen,
  SideAnswer,
  SideProgress,
  SideTurn,
  TranscriptUsage,
} from "../agents/types";
import {
  SETTINGS_DEFAULTS,
  type ChatLedger,
  type DraftRecord,
  type LastOptionsRecord,
  type NotesRecord,
  type ProjectRecord,
  type QueueRecord,
  type Settings,
  type SideRecord,
  type Store,
  type StoreDirs,
  type StoreOpenResult,
  type UploadRecord,
} from "../store/types";
import { emptyNotes, notesForSave } from "../store/notes";
import { sideRecordOf } from "../store/side";
import type { ChatRegistry } from "./registry";
import type { BashResult, BashRunner, Outcome, RequestContext, RingItem, Viewer } from "./types";

const clone = <T>(v: T): T => structuredClone(v);

/** One scripted Claude Code process: the test pushes its events and reads what the registry called. */
export class FakeChat implements AgentChat {
  /** The process id the registry notes in the ledger (R16); null: none known, as the seam allows. */
  pid: number | null = null;
  readonly calls: string[] = [];
  readonly sent: { uuid: string; text: string }[] = [];
  readonly bashRecords: { uuid: string; input: string; stdout: string; stderr: string; reply: boolean }[] = [];
  closed = false;
  interruptResult: { stillQueued: string[] | null } = { stillQueued: null };
  takeBackResult: { cancelled: boolean } = { cancelled: true };
  title: string | null = null;
  /** What `rename()` answers: true, the process took the name; false, it has no way to take one. */
  renameTaken = true;
  /** What `account()` reports (Settings > Account, 6.8). */
  provider: string | null = null;
  modelList: ModelInfo[] = [];
  commandList: CommandInfo[] = [];
  contextInfo: ContextInfo | null = null;
  connectorList: ConnectorInfo[] = [];
  /** Method names that throw on their next call. */
  readonly failNext = new Set<string>();
  /** close() resolves only when this is released (tests of the ending state). */
  holdClose: Promise<void> | null = null;
  private readonly q: ChatEvent[] = [];
  private waiters: (() => void)[] = [];
  private ended = false;
  readonly events: AsyncIterable<ChatEvent>;

  constructor(
    readonly input: OpenInput,
    private readonly driver: FakeDriver,
  ) {
    const self = this;
    this.events = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<ChatEvent>> {
            while (self.q.length === 0 && !self.ended) await new Promise<void>((r) => self.waiters.push(r));
            const e = self.q.shift();
            return e ? { value: e, done: false } : { value: undefined, done: true };
          },
        };
      },
    };
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** The process sends these events. */
  emit(...events: ChatEvent[]): void {
    this.q.push(...events);
    this.wake();
  }

  /** The process exits (with its `exit` event unless `exit` is null). */
  end(exit: { code: number | null; signal: string | null } | null = { code: 0, signal: null }): void {
    if (this.ended) return;
    if (exit) this.q.push({ k: "exit", code: exit.code, signal: exit.signal, stderr: [] });
    this.ended = true;
    this.wake();
  }

  /** The driver's card callback: ask the user through the registry. `abort` may give the driver's reason (CARD_ABORT). */
  ask(card: Card): { answer: Promise<CardAnswer | null>; abort: (reason?: unknown) => void } {
    const ctl = new AbortController();
    return { answer: this.input.cards.ask(card, ctl.signal), abort: (reason?: unknown) => ctl.abort(reason) };
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private call(name: string): void {
    this.calls.push(name);
    if (this.failNext.delete(name)) throw new Error(`${name} failed`);
  }

  async send(turn: { uuid: string; text: string }): Promise<void> {
    this.call("send");
    this.sent.push({ ...turn });
    this.driver.script?.(this, turn);
  }
  async bashRecord(rec: { uuid: string; input: string; stdout: string; stderr: string; reply: boolean }): Promise<void> {
    this.call("bashRecord");
    this.bashRecords.push({ ...rec });
  }
  async interrupt(): Promise<{ stillQueued: string[] | null }> {
    this.call("interrupt");
    return this.interruptResult;
  }
  async setModel(model: string | null): Promise<void> {
    this.call(`setModel:${model}`);
  }
  async setEffort(level: EffortId | null): Promise<void> {
    this.call(`setEffort:${level}`);
  }
  async setMode(mode: ModeId): Promise<void> {
    this.call(`setMode:${mode}`);
  }
  async commands(): Promise<CommandInfo[]> {
    this.call("commands");
    return this.commandList;
  }
  async models(): Promise<ModelInfo[]> {
    this.call("models");
    return this.modelList;
  }
  async context(): Promise<ContextInfo | null> {
    this.call("context");
    return this.contextInfo;
  }
  async connectors(): Promise<ConnectorInfo[]> {
    this.call("connectors");
    return this.connectorList;
  }
  async reconnect(server: string): Promise<void> {
    this.call(`reconnect:${server}`);
  }
  async setAlwaysAsk(server: string, on: boolean): Promise<{ warning: string | null }> {
    this.call(`setAlwaysAsk:${server}:${on}`);
    return { warning: null };
  }
  async setEnabled(server: string, enabled: boolean): Promise<void> {
    this.call(`setEnabled:${server}:${enabled}`);
  }
  async stopTask(taskId: string): Promise<void> {
    this.call(`stopTask:${taskId}`);
  }
  async runInBackground(toolUseId: string): Promise<boolean> {
    this.call(`runInBackground:${toolUseId}`);
    return true;
  }
  /** What `backgroundAll()` answers (false: background tasks are off for the session). */
  backgroundAllResult = true;
  /** Events the process sends before `backgroundAll()` answers (Claude Code 2.1.317: the moved task's update first). */
  backgroundAllEvents: ChatEvent[] = [];
  async backgroundAll(): Promise<boolean> {
    this.call("backgroundAll");
    if (this.backgroundAllEvents.length > 0) {
      this.emit(...this.backgroundAllEvents.splice(0));
      await Bun.sleep(10);
    }
    return this.backgroundAllResult;
  }
  async takeBack(uuid: string): Promise<{ cancelled: boolean }> {
    this.call(`takeBack:${uuid}`);
    return this.takeBackResult;
  }
  async reload(): Promise<void> {
    this.call("reload");
  }
  async generateTitle(): Promise<string | null> {
    this.call("generateTitle");
    return this.title;
  }
  async rename(title: string, sessionId: string): Promise<boolean> {
    this.call(`rename:${title}`);
    this.driver.order.push(`chat rename:${sessionId}`);
    return this.renameTaken;
  }
  async account(): Promise<{ provider: string | null }> {
    this.call("account");
    return { provider: this.provider };
  }
  /** R124: each side question this process was asked, with its history, signal and progress callback. */
  readonly sideAsks: SideAsk[] = [];
  /** R124: what a side question answers (an Error is thrown); by default at once, an answer that names the question. */
  sideReply: (ask: SideAsk) => SideAnswer | null | Error | Promise<SideAnswer | null | Error> = (a) => ({ response: `Side answer to: ${a.question}`, synthetic: false, fallback: null });
  async sideQuestion(question: string, opts: { history: readonly SideTurn[]; signal: AbortSignal; onProgress?: (p: SideProgress) => void }): Promise<SideAnswer | null> {
    this.call("sideQuestion");
    const ask: SideAsk = { question, history: opts.history.map((h) => ({ ...h })), signal: opts.signal, progress: (p) => opts.onProgress?.(p) };
    this.sideAsks.push(ask);
    const r = await new Promise<SideAnswer | null | Error>((resolve, reject) => {
      if (opts.signal.aborted) return reject(opts.signal.reason);
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
      Promise.resolve(this.sideReply(ask)).then(resolve, reject);
    });
    if (r instanceof Error) throw r;
    return r;
  }
  async close(): Promise<void> {
    this.call("close");
    this.driver.order.push("close");
    this.closed = true;
    if (this.holdClose) await this.holdClose;
    this.end(this.driver.exitOnClose);
  }
}

export const ALL_CAPS: AgentCapabilities = {
  models: true,
  effort: true,
  modes: [...MODE_IDS],
  commands: true,
  bash: true,
  contextUsage: true,
  connectors: true,
  backgroundTasks: true,
  runInBackground: true,
  takeBack: true,
  titles: true,
  rename: true,
  deleteSession: true,
  sideQuestions: true,
  trustFolder: true,
};

/** R124: one side question as the scripted process got it. */
export interface SideAsk {
  question: string;
  history: SideTurn[];
  signal: AbortSignal;
  /** Sends a progress of this side question, as the process's `control_request_progress` would. */
  progress: (p: SideProgress) => void;
}

/** The scripted driver: every `open()` makes a FakeChat; sessions and histories are plain maps. */
export class FakeDriver implements AgentDriver {
  readonly kind = "claude-code" as const;
  caps: AgentCapabilities = { ...ALL_CAPS, modes: [...ALL_CAPS.modes] };
  probeResult: BinaryProbe = {
    ok: true,
    path: "/usr/local/bin/claude",
    realpath: "/usr/local/bin/claude",
    version: "2.1.311",
    source: "path",
    refused: [],
    platformPackages: [],
    drift: null,
    belowMinimum: null,
  };
  probes = 0;
  readonly opens: FakeChat[] = [];
  /** Session ids whose transcript exists (sessionInfo answers for these only). */
  readonly sessions = new Map<string, SessionInfo>();
  readonly histories = new Map<string, ChatEvent[]>();
  /** Row 94: each session's last reply's usage in its transcript (lastUsage answers it). */
  readonly usages = new Map<string, TranscriptUsage>();
  readonly renamed: { sessionId: string; title: string }[] = [];
  readonly deletedSessions: string[] = [];
  /** The folder (`dir`) that each session function was asked with: history, info, rename, delete, fork, usage. */
  readonly sessionDirs: { op: "history" | "info" | "rename" | "delete" | "fork" | "usage"; sessionId: string; cwd: string }[] = [];
  /** The order of the delete steps, with the registry's own calls. */
  readonly order: string[] = [];
  agentSettings: AgentSettings = { respondToBash: true, cleanupPeriodDays: null, promptSuggestions: false, defaultMode: null };
  /** Runs on every message a chat gets (an auto reply, for example). */
  script: ((chat: FakeChat, turn: { uuid: string; text: string }) => void) | null = null;
  exitOnClose: { code: number | null; signal: string | null } | null = { code: 0, signal: null };
  openThrows = false;
  probeWait: Promise<void> | null = null;
  deleteSessionThrows = false;
  /** What readCommands answers (D59), and the folders it was asked for. */
  commandsAnswer: CommandInfo[] = [];
  readsAsked: string[] = [];
  /**
   * Row 81: what readModels answers, the folders it was asked for, a gate it waits for (null: none), and the driver
   * error code it fails with (null: none).
   */
  modelsAnswer: ModelInfo[] = [];
  readonly modelReads: string[] = [];
  /** Row 94: what readWindows answers (from the same short read as readModels's), and the folders it was asked for. */
  windowsAnswer: Record<string, number> = {};
  readonly windowReads: string[] = [];
  modelsWait: Promise<void> | null = null;
  modelsThrows: "no_claude" | "failed" | null = null;
  /** How often endReads ran (R17: the shutdown ends the short reads in flight). */
  endReadsCalls = 0;
  /** D58: the sessions that another process has open now (openSessions answers a copy), and how often it was read. */
  readonly openNow = new Map<string, SessionOpen>();
  openReads = 0;
  openSessionsThrows = false;
  /** D58 Continue in a copy: each fork made, and the driver error code the next forks fail with (null: none). */
  readonly forks: { sessionId: string; cwd: string; title: string | null; id: string }[] = [];
  forkThrows: "not_found" | "failed" | null = null;

  get last(): FakeChat {
    const c = this.opens[this.opens.length - 1];
    if (!c) throw new Error("no chat was opened");
    return c;
  }

  capabilities(): AgentCapabilities {
    return this.caps;
  }
  async probe(): Promise<BinaryProbe> {
    this.probes++;
    if (this.probeWait) await this.probeWait;
    return this.probeResult;
  }
  open(input: OpenInput): AgentChat {
    if (this.openThrows) throw new Error("spawn failed");
    const c = new FakeChat(input, this);
    this.opens.push(c);
    this.order.push("open");
    return c;
  }
  async history(sessionId: string, cwd: string, page: HistoryPageRequest): Promise<{ events: ChatEvent[]; more: string | null }> {
    this.sessionDirs.push({ op: "history", sessionId, cwd });
    const events = clone(this.histories.get(sessionId) ?? []);
    return { events: page.decorate ? page.decorate(events) : events, more: null };
  }
  /** U5: how often transcriptEvents read each session. */
  readonly transcriptReads: { sessionId: string; cwd: string }[] = [];
  async transcriptEvents(sessionId: string, cwd: string): Promise<ChatEvent[]> {
    this.transcriptReads.push({ sessionId, cwd });
    return clone(this.histories.get(sessionId) ?? []);
  }
  async sessionInfo(sessionId: string, cwd: string): Promise<SessionInfo | null> {
    this.sessionDirs.push({ op: "info", sessionId, cwd });
    // R131: a session whose transcript is found only under one folder (a background session's, read with its folder).
    const only = this.infoOnlyIn.get(sessionId);
    if (only !== undefined && only !== cwd) return null;
    return this.sessions.get(sessionId) ?? null;
  }
  /** R131: sessions whose info answers only for this folder (sessionInfo); every other session answers for any. */
  readonly infoOnlyIn = new Map<string, string>();
  async lastUsage(sessionId: string, cwd: string): Promise<TranscriptUsage | null> {
    this.sessionDirs.push({ op: "usage", sessionId, cwd });
    const u = this.usages.get(sessionId);
    return u ? { ...u } : null;
  }
  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.values()];
  }
  /** Row 99: each listReleased read (the folder asked and its ids); it answers the sessions filed under that folder. */
  readonly releasedReads: { cwd: string; ids: string[] }[] = [];
  /** The folder a session's transcript is filed under, when it is not the session's `cwd` (W4's sessionDir). */
  readonly filedUnder = new Map<string, string>();
  async listReleased(cwd: string, ids: readonly string[]): Promise<SessionInfo[]> {
    this.releasedReads.push({ cwd, ids: [...ids] });
    return [...this.sessions.values()].filter((s) => ids.includes(s.sessionId) && (this.filedUnder.get(s.sessionId) ?? s.cwd) === cwd);
  }
  async sessionFolders(): Promise<string[]> {
    const newest = [...this.sessions.values()].sort((a, b) => b.lastModified - a.lastModified);
    return [...new Set(newest.flatMap((s) => (s.cwd ? [s.cwd] : [])))];
  }
  async rename(sessionId: string, title: string, cwd: string): Promise<void> {
    this.sessionDirs.push({ op: "rename", sessionId, cwd });
    this.order.push(`rename:${sessionId}`);
    if (!this.sessions.has(sessionId)) throw new Error("no transcript");
    this.renamed.push({ sessionId, title });
    const s = this.sessions.get(sessionId)!;
    this.sessions.set(sessionId, { ...s, title, customTitle: title });
  }
  async deleteSession(sessionId: string, cwd: string): Promise<void> {
    this.sessionDirs.push({ op: "delete", sessionId, cwd });
    this.order.push("deleteSession");
    if (this.deleteSessionThrows) throw new Error("delete failed");
    this.deletedSessions.push(sessionId);
    this.sessions.delete(sessionId);
    this.histories.delete(sessionId);
  }
  async settings(): Promise<AgentSettings> {
    return { ...this.agentSettings };
  }
  async forkSession(sessionId: string, cwd: string, title: string | null): Promise<string> {
    this.sessionDirs.push({ op: "fork", sessionId, cwd });
    const s = this.sessions.get(sessionId);
    const code = this.forkThrows ?? (s ? null : "not_found");
    // The driver's own error shape (server/agents/claude/driver.ts DriverError), which the registry reads by name.
    if (code) throw Object.assign(new Error("fork failed"), { name: "DriverError", code });
    const id = crypto.randomUUID();
    this.sessions.set(id, { ...s!, sessionId: id, title: title ?? s!.title, customTitle: title, lastModified: Date.now() });
    this.histories.set(id, clone(this.histories.get(sessionId) ?? []));
    this.forks.push({ sessionId, cwd, title, id });
    return id;
  }
  async openSessions(): Promise<ReadonlyMap<string, SessionOpen>> {
    this.openReads++;
    if (this.openSessionsThrows) throw new Error("unreadable");
    return new Map(this.openNow);
  }
  async readCommands(cwd: string): Promise<CommandInfo[]> {
    this.readsAsked.push(cwd);
    return clone(this.commandsAnswer);
  }
  async endReads(): Promise<void> {
    this.endReadsCalls++;
  }
  async readModels(cwd: string): Promise<ModelInfo[]> {
    this.modelReads.push(cwd);
    if (this.modelsWait) await this.modelsWait;
    // The driver's own error shape (server/agents/claude/driver.ts DriverError).
    if (this.modelsThrows) throw Object.assign(new Error("read failed"), { name: "DriverError", code: this.modelsThrows });
    return clone(this.modelsAnswer);
  }
  async readWindows(cwd: string): Promise<Record<string, number>> {
    this.windowReads.push(cwd);
    if (this.modelsWait) await this.modelsWait;
    if (this.modelsThrows) throw Object.assign(new Error("read failed"), { name: "DriverError", code: this.modelsThrows });
    return { ...this.windowsAnswer };
  }

  /**
   * R127: each trust start asked for (its folder), what the next ones answer (`recorded`, or the driver error code they
   * throw), and a gate they wait for (null: none). A start's signal ends it with `failed`, as the driver's does.
   */
  readonly trusts: string[] = [];
  trustAnswer: { recorded: boolean } | "no_claude" | "failed" = { recorded: true };
  trustWait: Promise<void> | null = null;
  async trustFolder(path: string, signal?: AbortSignal): Promise<{ recorded: boolean }> {
    this.trusts.push(path);
    const fail = (code: string) => Object.assign(new Error("trust start failed"), { name: "DriverError", code });
    if (this.trustWait) {
      const aborted = new Promise<"aborted">((r) => signal?.addEventListener("abort", () => r("aborted")));
      if ((await Promise.race([this.trustWait.then(() => "go" as const), aborted])) === "aborted") throw fail("failed");
    }
    if (typeof this.trustAnswer === "string") throw fail(this.trustAnswer);
    return { ...this.trustAnswer };
  }

  /**
   * R131: the background sessions' records that each look answers (backgroundRecords, only those of the ids it asks),
   * how often it was read, and the ids of each read.
   */
  bgRecords: BgRecord[] = [];
  bgRecordReads = 0;
  readonly bgRecordAsks: string[][] = [];
  /**
   * R131: what Claude Code's list answers (null: it cannot be read; `bgListAt`: the answer's start, else now), each set
   * of ids it was asked for, and a gate it waits for (null: none).
   */
  bgList: BgListRow[] | null = [];
  bgListAt: number | null = null;
  readonly bgListAsks: string[][] = [];
  bgListWait: Promise<void> | null = null;
  /** R131: each stop asked (its id), what the next ones answer or the driver error code they throw, and a gate. */
  readonly bgStops: string[] = [];
  bgStopAnswer: BgStopAnswer | "unsupported" | "no_claude" = "stopped";
  bgStopWait: Promise<void> | null = null;
  /** R131: each session's permission mode as its transcript says (backgroundMode), by `<session id> <folder>`. */
  readonly bgModes = new Map<string, ModeId>();
  async backgroundRecords(ids: ReadonlySet<string>): Promise<BgRecord[]> {
    this.bgRecordReads++;
    this.bgRecordAsks.push([...ids].sort());
    return clone(this.bgRecords.filter((r) => ids.has(r.jobId)));
  }
  async listBackground(ids: ReadonlySet<string>): Promise<BgList | null> {
    const at = this.bgListAt ?? Date.now();
    this.bgListAsks.push([...ids].sort());
    if (this.bgListWait) await this.bgListWait;
    if (this.bgList === null) return null;
    return { rows: clone(this.bgList.filter((r) => ids.has(r.id))), at, ran: { ms: 3, code: 0 } };
  }
  async stopBackground(id: string): Promise<BgStopAnswer> {
    this.bgStops.push(id);
    if (this.bgStopWait) await this.bgStopWait;
    const a = this.bgStopAnswer;
    if (a === "unsupported" || a === "no_claude") throw Object.assign(new Error("stop refused"), { name: "DriverError", code: a });
    return a;
  }
  async backgroundMode(sessionId: string, dir: string): Promise<ModeId | null> {
    return this.bgModes.get(`${sessionId} ${dir}`) ?? null;
  }

  /** Mark a session's transcript as written (what the CLI does on the first turn), with its first prompt and custom title. */
  transcript(sessionId: string, firstPrompt = "A past chat", cwd = "/srv/work/app", customTitle: string | null = null): void {
    this.sessions.set(sessionId, { sessionId, title: customTitle ?? firstPrompt, customTitle, lastModified: Date.now(), cwd });
  }
}

/**
 * An auto reply: on each message, the CLI's `system/init`, one text block and the `result`, after `delayMs`. The first
 * reply writes the transcript, so the next start resumes.
 */
export function autoReply(driver: FakeDriver, delayMs = 0, text = "ok"): void {
  driver.script = (chat, turn) => {
    setTimeout(() => {
      if (chat.isEnded) return;
      const sid = chat.input.sessionId?.value ?? chat.input.resume?.value ?? "00000000-0000-4000-8000-000000000000";
      driver.transcript(sid);
      chat.emit(
        { k: "session", sessionId: sid, model: "claude-haiku-5-5", mode: "default", version: "2.1.311", bypass: false },
        { k: "block", key: `m-${turn.uuid}`, kind: "text", text, parent: null },
        { k: "turn_end", ok: true, subtype: "success", durationMs: 5, error: null, uuids: [turn.uuid] },
      );
    }, delayMs);
  };
}

const DIRS: StoreDirs = {
  state: "/state/kitespan",
  config: "/config/kitespan",
  chats: "/state/kitespan/chats",
  drafts: "/state/kitespan/drafts",
  notes: "/state/kitespan/notes",
  uploads: "/state/kitespan/uploads",
  logs: "/state/kitespan/logs",
  queue: "/state/kitespan/queue",
  env: "/state/kitespan/env",
  side: "/state/kitespan/side",
  changes: "/state/kitespan/changes",
};

/** The store in memory, with counters for the tests. */
export class MemoryStore implements Store {
  readonly dirs = DIRS;
  readonly chats = new Map<string, ChatLedger>();
  projects: ProjectRecord[] = [];
  settingsValue: Settings = { ...SETTINGS_DEFAULTS };
  readonly drafts = new Map<string, DraftRecord>();
  /** FIX-U2: each chat's side box's draft (`box: "side"`), as saved. */
  readonly sideDrafts = new Map<string, DraftRecord>();
  /** Each chat's notes as saved (notesForSave's caps applied, as the file store does). */
  readonly notes = new Map<string, NotesRecord>();
  readonly uploads = new Map<string, UploadRecord>();
  /** Each chat's queue file (RD-8), as written; a record with no message is none. */
  readonly queues = new Map<string, QueueRecord>();
  queueWrites = 0;
  lastOptions: LastOptionsRecord | null = null;
  writes: ChatLedger[] = [];
  deleted: string[] = [];
  draftSaves = 0;
  flushed = 0;
  /** Set by FakeDriver.order's owner to record the store's step of a delete. */
  order: string[] | null = null;

  async open(): Promise<StoreOpenResult> {
    return { chats: [...this.chats.values()].map(clone), setAside: [], swept: 0 };
  }
  async readChat(id: string): Promise<ChatLedger | null> {
    const c = this.chats.get(id);
    return c ? clone(c) : null;
  }
  async writeChat(rec: ChatLedger): Promise<void> {
    this.writes.push(clone(rec));
    this.chats.set(rec.id, clone(rec));
  }
  async deleteChat(id: string): Promise<void> {
    this.order?.push("deleteChat");
    this.deleted.push(id);
    this.chats.delete(id);
    this.drafts.delete(id);
    this.sideDrafts.delete(id);
    this.notes.delete(id);
    this.queues.delete(id);
    this.sides.delete(id);
    for (const [uid, u] of this.uploads) if (u.chat === id) this.uploads.delete(uid);
  }
  async listProjects(): Promise<ProjectRecord[]> {
    return this.projects.map(clone);
  }
  async putProject(rec: ProjectRecord): Promise<void> {
    if (this.goneProjects.has(rec.id)) return;
    const i = this.projects.findIndex((p) => p.id === rec.id);
    if (i >= 0) this.projects[i] = clone(rec);
    else this.projects.push(clone(rec));
  }
  async putProjects(recs: readonly ProjectRecord[]): Promise<void> {
    for (const rec of recs) await this.putProject(rec);
  }
  /** Row 99: the removed projects, whose late writes are dropped (as the file store does). */
  readonly goneProjects = new Set<string>();
  async removeProject(id: string): Promise<ProjectRecord | null> {
    this.goneProjects.add(id);
    const rec = this.projects.find((p) => p.id === id) ?? null;
    this.projects = this.projects.filter((p) => p.id !== id);
    for (const [uid, u] of this.uploads) if (u.chat === null && u.project === id) this.uploads.delete(uid);
    return rec ? clone(rec) : null;
  }
  async readSettings(): Promise<Settings> {
    return { ...this.settingsValue };
  }
  async writeSettings(change: Partial<Settings>): Promise<Settings> {
    this.settingsValue = { ...this.settingsValue, ...change } as Settings;
    return { ...this.settingsValue };
  }
  async writeLastOptions(rec: LastOptionsRecord): Promise<void> {
    this.lastOptions = clone(rec);
  }
  async readDraft(chat: string, box: DraftBox = "main"): Promise<DraftRecord> {
    const d = (box === "side" ? this.sideDrafts : this.drafts).get(chat);
    return d ? clone(d) : { v: 1, id: chat, ...(box === "side" ? { box } : {}), ...emptyDraft("2026-10-31T00:00:00.000Z") };
  }
  saveDraft(rec: DraftRecord): void {
    this.draftSaves++;
    (rec.box === "side" ? this.sideDrafts : this.drafts).set(rec.id, clone(rec));
  }
  async readNotes(chat: string): Promise<NotesRecord> {
    const n = this.notes.get(chat);
    return n ? clone(n) : emptyNotes(chat);
  }
  saveNotes(rec: NotesRecord): void {
    this.notes.set(rec.id, notesForSave(clone(rec)));
  }
  async readQueue(chat: string): Promise<QueueRecord | null> {
    const q = this.queues.get(chat);
    return q ? clone(q) : null;
  }
  async writeQueue(rec: QueueRecord): Promise<void> {
    this.queueWrites++;
    if (rec.msgs.length === 0) this.queues.delete(rec.id);
    else this.queues.set(rec.id, clone(rec));
  }
  /** R124: each chat's side file, as written (the file store's check applied); every write in order. */
  readonly sides = new Map<string, SideRecord>();
  readonly sideWrites: SideRecord[] = [];
  async readSide(chat: string): Promise<SideRecord | null> {
    const s = this.sides.get(chat);
    return s ? clone(s) : null;
  }
  async writeSide(rec: SideRecord): Promise<void> {
    const next = sideRecordOf(rec);
    if (!next) throw new Error("the side record fails its check");
    // A deleted chat's late write is dropped, as the file store drops it.
    if (this.deleted.includes(rec.id)) return;
    this.sideWrites.push(clone(next));
    this.sides.set(rec.id, clone(next));
  }
  async listUploads(chat: string | null): Promise<UploadRecord[]> {
    return [...this.uploads.values()].filter((u) => u.chat === chat).map(clone);
  }
  async putUpload(rec: UploadRecord): Promise<void> {
    this.uploads.set(rec.id, clone(rec));
  }
  async removeUpload(id: string): Promise<UploadRecord | null> {
    const u = this.uploads.get(id) ?? null;
    this.uploads.delete(id);
    return u;
  }
  async flush(): Promise<void> {
    this.flushed++;
  }
}

/** A project row for the tests. */
export function projectRecord(id: string, cwd = "/srv/work/app"): ProjectRecord {
  return {
    id,
    cwd,
    name: cwd.split("/").pop() ?? cwd,
    createdAt: "2026-10-31T08:00:00.000Z",
    lastUsedAt: "2026-10-31T08:00:00.000Z",
    picks: { model: null, effort: null, permissionMode: null },
  };
}

/** One upload record for the tests. */
export function uploadRecord(id: string, chat: string | null, project: string, name = "notes.txt"): UploadRecord {
  return {
    v: 1,
    id,
    chat,
    project,
    name,
    size: 10,
    type: "text/plain",
    path: `/tmp/kitespan-uploads-test/u-abcdef/${name}`,
    folder: "temp",
    dir: "/tmp/kitespan-uploads-test/u-abcdef",
    at: "2026-10-31T08:00:00.000Z",
  };
}

/** Apply one request as the socket layer does: the outcome, then its after-ack steps. */
export async function apply(registry: ChatRegistry, frame: RequestFrame, ctx: RequestContext = { tab: "tab_a" }): Promise<Outcome> {
  const o = await registry.request(frame, ctx);
  if (!o.ok) return o;
  const { after, ...rest } = o;
  after?.();
  return rest;
}

/** Let queued promise callbacks and zero-delay timers run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

/** A viewer that records what the registry gives it. */
export class RecordingViewer implements Viewer {
  readonly items: RingItem[] = [];
  /** The message box's drafts it got. */
  readonly drafts: DraftState[] = [];
  /** FIX-U2: the side chat's box's drafts it got. */
  readonly sideDrafts: DraftState[] = [];
  goneCount = 0;
  constructor(readonly tab: string | null = "tab_a") {}
  event(item: RingItem): void {
    this.items.push(item);
  }
  draft(d: DraftState, box: DraftBox = "main"): void {
    (box === "side" ? this.sideDrafts : this.drafts).push(d);
  }
  gone(): void {
    this.goneCount++;
  }
  get events(): ChatEvent[] {
    return this.items.map((i) => i.e);
  }
  of<K extends ChatEvent["k"]>(k: K): Extract<ChatEvent, { k: K }>[] {
    return this.events.filter((e): e is Extract<ChatEvent, { k: K }> => e.k === k);
  }
}

/** A `!` runner that records each command; `hold` keeps the next commands running until released. */
export class FakeBash implements BashRunner {
  readonly runs: { command: string; cwd: string }[] = [];
  result: BashResult = { stdout: "ok\n", stderr: "", code: 0, ms: 4, timedOut: false, capped: false };
  hold: Promise<void> | null = null;
  async run(input: { command: string; cwd: string; signal: AbortSignal }): Promise<BashResult> {
    this.runs.push({ command: input.command, cwd: input.cwd });
    if (this.hold) await this.hold;
    return { ...this.result };
  }
}
