// R131 (owner row 131; FIX-R131 2, DESIGN-R131 4 to 11): the background sessions that a chat starts with `claude
// --bg`, on the page. The server matches Claude Code's launch line ("backgrounded · <id> · <name>") in a tool result's
// whole text and puts `background: [{id, name, idle}]` on that row's event; it keeps each session's state (the
// `background` events and `attached.background`, the same on every device, D49). The page draws one line under the
// newest row that holds an id, in every turn while Claude Code lists the session (a live fact, unlike R127's line),
// never in a read-only view. The line's button and the view's actions are links: the view
// (/c/<chat>/background/<id>), the Stop confirm (/c/<chat>/background/<id>/stop), whose Stop sends the one request, and
// the Terminal pane with `claude attach <id>` typed, not run. Pure: no DOM, no store (the reducer reads this file, and
// the server's tests read the reducer).
import { href } from "../../shared/route";
import { BG_ID_RE } from "../../shared/background";
import {
  BG_ROW_STATES,
  BG_STATES,
  BG_STOP_ANSWERS,
  BG_WAITS,
  MODE_IDS,
  bgLaunchesOf,
  bgWorkerOf,
  type BgLaunch,
  type BgRowState,
  type BgState,
  type BgStopAnswer,
  type BgWait,
  type BgWorker,
} from "../../shared/protocol";
import { MODES } from "../state/catalog";
import type { Chat, ChatState, Item, ModeId } from "../state/types";
import { OPEN_IN_TERMINAL } from "./trust";

export { BG_ID_RE, BG_STATES, BG_WAITS, OPEN_IN_TERMINAL, type BgState, type BgStopAnswer, type BgWait, type BgWorker };

// ---- the shapes: shared/protocol.ts's, as the page keeps them

/** One launch line of a tool result, as the server matched it (its short id, the -n name or null, the idle suffix). */
export type Launch = BgLaunch;
/** The chat row's own field for its sessions (ChatRow.background): not `needsYou`, which means a card waits. */
export type BgDot = BgRowState;

/** A line under a launch row: the session's id, the row (its tool use id), and the launch's name and idle flag. */
export interface BgRow {
  id: string;
  toolUse: string;
  name: string | null;
  idle: boolean;
}

const isId = (v: unknown): v is string => typeof v === "string" && BG_ID_RE.test(v);

/** A tool result's `background` as the page keeps it on its row: the protocol's rule (at most 16, each checked); [] for none. */
export function launchesOf(raw: unknown): Launch[] {
  return bgLaunchesOf(raw) ?? [];
}

/** A session's state from the wire by the protocol's rule, or null for one with no known state. */
export function workerOf(raw: unknown): BgWorker | null {
  return bgWorkerOf(raw);
}

/** `attached.background` as the page keeps it: each valid id with a known state; undefined when none. */
export function attachedBackground(raw: unknown): Record<string, BgWorker> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, BgWorker> = {};
  for (const [id, w] of Object.entries(raw as Record<string, unknown>)) {
    const worker = isId(id) ? workerOf(w) : null;
    if (worker) out[id] = worker;
  }
  return Object.keys(out).length ? out : undefined;
}

const sameWorker = (a: BgWorker, b: BgWorker) =>
  a.state === b.state && a.waitingFor === b.waitingFor && a.idleLaunch === b.idleLaunch && a.name === b.name && a.folder === b.folder && a.view === b.view && a.startedAt === b.startedAt && a.unseen === b.unseen;

/** The map with `id` set to `worker`, or taken out (null: Claude Code no longer lists it, so its line goes). */
export function withWorker(map: Readonly<Record<string, BgWorker>> | undefined, id: string, worker: BgWorker | null): Readonly<Record<string, BgWorker>> | undefined {
  if (worker === null) {
    if (!map || !(id in map)) return map && Object.keys(map).length ? map : undefined;
    const { [id]: _gone, ...rest } = map;
    return Object.keys(rest).length ? rest : undefined;
  }
  const was = map?.[id];
  return was && sameWorker(was, worker) ? map : { ...map, [id]: worker };
}

/** The chat row's `background`: needs_input, failed or done; anything else none. */
export function bgDotOf(raw: unknown): BgDot | null {
  return (BG_ROW_STATES as readonly unknown[]).includes(raw) ? (raw as BgDot) : null;
}

// ---- which rows carry a line (DESIGN-R131 4, 5.1)

/** Each launch row among `items` and the subagent blocks inside them, in their order. */
function launchRows(items: readonly Item[], out: BgRow[] = []): BgRow[] {
  for (const it of items) {
    if (it.kind === "tool" && it.launches?.length) for (const l of it.launches) out.push({ id: l.id, toolUse: it.id, name: l.name, idle: l.idle });
    else if (it.kind === "agent") launchRows(it.rows, out);
  }
  return out;
}

/**
 * The rows that carry a line, by tool use id: the newest row that holds each id (a wake of a stopped session prints
 * the same id again), in every turn; each row's lines in the order of its launch lines.
 */
export function bgRows(items: readonly Item[]): ReadonlyMap<string, readonly BgRow[]> {
  const all = launchRows(items);
  const newest = new Map<string, number>();
  all.forEach((r, i) => newest.set(r.id, i));
  const out = new Map<string, BgRow[]>();
  all.forEach((r, i) => {
    if (newest.get(r.id) === i) out.set(r.toolUse, [...(out.get(r.toolUse) ?? []), r]);
  });
  return out;
}

/** The lines that the rows among `items` (deep, in order) carry: what a closed summary, subagent block or turn shows under its head. */
export function bgRowsIn(items: readonly Item[], rows: ReadonlyMap<string, readonly BgRow[]> | undefined): BgRow[] {
  if (!rows?.size) return [];
  const out: BgRow[] = [];
  const walk = (list: readonly Item[]) => {
    for (const it of list) {
      const r = rows.get(it.id);
      if (r) out.push(...r);
      if (it.kind === "agent") walk(it.rows);
    }
  };
  walk(items);
  return out;
}

/** The newest row that holds `id`, anywhere in the chat (a subagent's row too), or null: the chat did not print it. */
export function launchOf(items: readonly Item[], id: string): BgRow | null {
  let hit: BgRow | null = null;
  for (const r of launchRows(items)) if (r.id === id) hit = r;
  return hit;
}

// ---- the words (DESIGN-R131 5.2, 11): agent view's states; kitespan's Starting

export const BG_WORDS: Readonly<Record<BgState, string>> = {
  starting: "Starting",
  working: "Working",
  needs_input: "Needs input",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

/** The reason after Needs input, in plain words (Claude Code's own classes: a worker request is a permission). */
export const WAIT_WORDS: Readonly<Record<BgWait, string | null>> = {
  "permission prompt": "a permission prompt",
  "worker request": "a permission prompt",
  "input needed": "a question",
  "sandbox request": "a sandbox request",
  "goal proposal": "a proposed goal",
  "dialog open": "a dialog",
  other: null,
};
/** Claude Code's own words for a session that got no prompt (the launch line's idle suffix, without its dash). */
export const IDLE_LAUNCH_WORDS = "send a prompt to start";

/** The reason a session needs input, or null (none known, or another state). */
export function reasonOf(w: BgWorker): string | null {
  if (w.state !== "needs_input") return null;
  if (w.waitingFor) return WAIT_WORDS[w.waitingFor];
  return w.idleLaunch ? IDLE_LAUNCH_WORDS : null;
}

/** The R116 dot's class for a session: no new token; Idle, Stopped and a seen Completed keep an empty place. */
export function dotOf(w: BgWorker): "" | "starting" | "running" | "waiting" | "unread" | "failed" {
  switch (w.state) {
    case "starting":
      return "starting";
    case "working":
      return "running";
    case "needs_input":
      return "waiting";
    case "completed":
      return w.unseen ? "unread" : "";
    case "failed":
      return "failed";
    default:
      return "";
  }
}

/** The state word's colour, as the chat list colours its lead words: Needs input warm, Failed red, the rest dim. */
export function toneOf(state: BgState): "is-attn" | "is-bad" | null {
  return state === "needs_input" ? "is-attn" : state === "failed" ? "is-bad" : null;
}

/** The state as plain text: "Needs input: a question", "Completed". */
export function stateText(w: BgWorker): string {
  const why = reasonOf(w);
  return why ? `${BG_WORDS[w.state]}: ${why}` : BG_WORDS[w.state];
}

/** Claude Code's noun for these sessions: read out on the line, and the view's heading on touch. */
export const BG_HEADING = "Background session";

/** What a screen reader hears of a line: "Background session <name>, Needs input: a permission prompt". */
export function lineSaid(name: string, w: BgWorker): string {
  return `${BG_HEADING} ${name}, ${stateText(w)}`;
}

/** The session's name: the server's (the launch's -n name, else Claude Code's), else the launch row's, else the short id. */
export function bgName(w: BgWorker | undefined, row: Pick<BgRow, "name"> | null, id: string): string {
  return w?.name ?? row?.name ?? id;
}

/** Stop is offered while the session runs (its process lives, or Claude Code has not settled it). */
export function canStop(state: BgState): boolean {
  return state === "starting" || state === "working" || state === "needs_input" || state === "idle";
}

/** The line's button: Open (the view), or Desktop's Open in terminal for a session outside the project. */
export const OPEN = "Open";

// ---- the chat's dot (DESIGN-R131 9.5): its own field, never needsYou, so the Needs input filter still means a card waits

/**
 * The one dot a chat row shows: the chat's own Needs input, then a session that needs input, then the chat's own turn
 * (running or starting), its own failed end, a failed session not seen, its own unread end, then a completed session
 * not seen; else the chat's own state (idle, asleep).
 */
export function chatDot(chat: Pick<Chat, "state" | "bgDot">): ChatState {
  const own = chat.state;
  const bg = chat.bgDot ?? null;
  if (own === "waiting") return "waiting";
  if (bg === "needs_input") return "waiting";
  if (own === "running" || own === "starting" || own === "failed") return own;
  if (bg === "failed") return "failed";
  if (own === "unread") return "unread";
  if (bg === "done") return "unread";
  return own;
}

/** The words for screen readers before the title, while a session of the chat needs input or ended unseen. */
export const BG_DOT_SAID: Readonly<Record<BgDot, string>> = {
  needs_input: "A background session needs input, ",
  failed: "A background session failed, ",
  done: "A background session completed, ",
};
export function bgDotSaid(chat: Pick<Chat, "bgDot">): string | null {
  return chat.bgDot ? BG_DOT_SAID[chat.bgDot] : null;
}

// ---- the chat's own bar: where the dot points (the chat at its end does not show it, and does not see its sessions)

/** The bar's mark of the chat's background sessions: the dot, the words for screen readers, and where it opens. */
export interface BgBarMark {
  id: string;
  dot: "waiting" | "failed" | "unread";
  said: string;
  /** The session's view, else its launch row opened in place (the line is under it); null with no row drawn yet. */
  to: string | null;
}

const BAR_SAID: Readonly<Record<BgDot, string>> = {
  needs_input: "A background session needs input: ",
  failed: "A background session failed: ",
  done: "A background session completed: ",
};

/**
 * The chat bar's mark while the chat row's own field says a session needs input, or ended unseen (the chat's dot in the
 * list), so the chat that the dot opens says it too, and where: the newest launched session of that kind. None for an
 * archived chat or when the field says nothing. The bar draws it only while the chat itself waits for nothing.
 */
export function bgBarMark(chat: Pick<Chat, "id" | "archived" | "items" | "bgDot" | "background">, view?: string): BgBarMark | null {
  const kind = chat.bgDot ?? null;
  if (!kind || chat.archived || !chat.background) return null;
  const wants = (w: BgWorker | undefined): w is BgWorker =>
    !!w && (kind === "needs_input" ? w.state === "needs_input" : kind === "failed" ? w.state === "failed" && !!w.unseen : w.state === "completed" && !!w.unseen);
  const rows = [...bgRows(chat.items).values()].flat();
  let hit: { id: string; w: BgWorker; row: BgRow | null } | null = null;
  for (const r of rows) {
    const w = chat.background[r.id];
    if (wants(w)) hit = { id: r.id, w, row: r };
  }
  if (!hit)
    for (const [id, w] of Object.entries(chat.background)) {
      if (wants(w)) hit = { id, w, row: null };
    }
  if (!hit) return null;
  const to = hit.w.view ? bgHref(chat.id, hit.id, view) : hit.row ? href("tool", { chat: chat.id, toolUse: hit.row.toolUse }, { view }) : null;
  return { id: hit.id, dot: kind === "needs_input" ? "waiting" : kind === "failed" ? "failed" : "unread", said: `${BAR_SAID[kind]}${bgName(hit.w, hit.row, hit.id)}`, to };
}

// ---- the routes: each names the chat and the short id that the chat's own row printed, never a path (DESIGN 5.2)

export function bgHref(chatId: string, id: string, view?: string): string {
  return href("background", { chat: chatId, id }, { view });
}
export function bgStopHref(chatId: string, id: string, view?: string): string {
  return href("backgroundStop", { chat: chatId, id }, { view });
}
/** The Terminal pane with `claude attach <id>` typed at its prompt (the server types it only for an id in the chat's book). */
export function bgTerminalHref(chatId: string, id: string, view?: string): string {
  return href("shell", { chat: chatId }, { type: "attach", bg: id, view });
}

// ---- the view (DESIGN-R131 6)

/** The 5.4 lines of a link to a session that the view does not show. */
export const BG_NOT_IN_CHAT = "That background session is not in this chat.";
export const BG_OUTSIDE = "That background session runs outside this project, so kitespan does not show it.";

export type BgVerdict = "loading" | "view" | "gone" | "outside";

/**
 * What the view route shows: the view for a session that a launch row of the chat printed and Claude Code still lists
 * in the project's folder (or the chat's worktree); the chat with 5.4's line for one the chat did not print, that
 * Claude Code no longer lists, or an archived chat; with the outside line for one in another folder. Before the chat's
 * history is drawn: loading (the view's frame).
 */
export function viewVerdict(chat: Pick<Chat, "archived" | "loaded" | "items" | "background">, id: string): BgVerdict {
  if (chat.archived) return "gone";
  if (!chat.loaded) return "loading";
  if (!launchOf(chat.items, id)) return "gone";
  const w = chat.background?.[id];
  if (!w) return "gone";
  return w.view ? "view" : "outside";
}

/** The folder's last two segments (`worktrees/remove-negative-qty`); the full path is its title. */
export function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts.slice(-2).join("/") : "/";
}

/** "started 4 min ago" ("started just now" within a minute), in the preview's units; null with no start known. */
export function startedText(at: number | null, now: number): string | null {
  if (at === null) return null;
  const m = Math.round((now - at) / 60000);
  if (m < 1) return "started just now";
  if (m < 60) return `started ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `started ${h} h ago`;
  return `started ${Math.round(h / 24)} d ago`;
}

/** A permission mode in Desktop's words (DESIGN 6.12), or null. */
export function modeWord(mode: ModeId | null): string | null {
  return mode ? (MODES.find((m) => m.id === mode)?.label ?? null) : null;
}

/** What the server's read of the session's transcript said (GET /api/chats/:chat/background/:id). */
export type BgReply =
  | { kind: "same" }
  | { kind: "outside" }
  | { kind: "page"; history: unknown[]; stamp: string | null; mode: ModeId | null }
  /** The id is not in the chat's book (404): the view gives way to the chat's 5.4 line. */
  | { kind: "gone" };

/** The read's answer as the page takes it, or null for an answer it cannot read. */
export function viewReply(raw: unknown): Exclude<BgReply, { kind: "gone" }> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.same === true) return { kind: "same" };
  if (o.outside === true) return { kind: "outside" };
  if (!Array.isArray(o.history)) return null;
  const mode = typeof o.mode === "string" && (MODE_IDS as readonly string[]).includes(o.mode) ? (o.mode as ModeId) : null;
  return { kind: "page", history: o.history, stamp: typeof o.stamp === "string" ? o.stamp : null, mode };
}

/** How often the open view asks again (the registry's own 2 s look while a chat has a viewer). */
export const BG_READ_MS = 2000;

export interface BgReaderDeps {
  /** One read; `since` is the last answer's stamp. Throws an error with `status` (0: it did not reach the server). */
  get(since: string | null): Promise<unknown>;
  visible(): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  answer(a: BgReply): void;
}

/**
 * The view's reads (DESIGN-R131 6.6): one at once, then one about every 2 s, only while the page is visible and the
 * view is mounted (start to stop), each with the last stamp, so the server answers `same` from its lite read when
 * nothing changed. A hidden page reads nothing and runs no timer; visible again, it reads at once. A read that did not
 * reach the server keeps the page and tries again; a 404 (the id is not in the chat's book) ends the reads.
 */
export class BgReader {
  private timer: unknown = null;
  private running = false;
  private reading = false;
  private since: string | null = null;

  constructor(private readonly deps: BgReaderDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.read();
  }

  stop(): void {
    this.running = false;
    this.clear();
  }

  /** visibilitychange: hidden stops the timer; visible reads at once. */
  visibility(): void {
    if (!this.running) return;
    if (!this.deps.visible()) this.clear();
    else if (this.timer === null && !this.reading) this.read();
  }

  private clear(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private later(): void {
    this.clear();
    if (this.running && this.deps.visible()) this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.read();
    }, BG_READ_MS);
  }

  private read(): void {
    if (!this.running || this.reading || !this.deps.visible()) return;
    this.reading = true;
    this.deps.get(this.since).then(
      (raw) => {
        this.reading = false;
        if (!this.running) return;
        const a = viewReply(raw);
        if (a) {
          if (a.kind === "page") this.since = a.stamp;
          this.deps.answer(a);
          if (a.kind === "outside") return this.stop();
        }
        this.later();
      },
      (e: unknown) => {
        this.reading = false;
        if (!this.running) return;
        const status = (e as { status?: unknown } | null)?.status;
        if (status === 404) {
          this.deps.answer({ kind: "gone" });
          return this.stop();
        }
        this.later();
      },
    );
  }
}

// ---- Stop (DESIGN-R131 8): Claude Code's own words for what stop keeps (`claude stop --help`, 2.1.318)

/** Claude Code's hint "stop this session", as a question. */
export const STOP_TITLE = "Stop this session?";
export const STOP_KEPT = { before: "Its conversation is kept; resume it later with ", after: "." } as const;
export const stopKeptText = (id: string) => `${STOP_KEPT.before}claude attach ${id}${STOP_KEPT.after}`;
/** The confirm of a session that does not run (the chat's own Stop confirm's pattern). */
export const NOT_RUNNING = "This session is not running, so there is nothing to stop.";

/** The answers of a stop that Claude Code gave (an ok ack's `result.background`). */
export const STOP_ANSWERS = BG_STOP_ANSWERS;

const STOP_WORDS: Readonly<Record<string, string>> = {
  not_found: "Claude Code does not list this session any more.",
  failed: "Claude Code did not confirm the stop. Try again in a moment.",
  stale: "This chat did not start that session.",
  unsupported: "This Claude Code cannot stop background sessions.",
};

/**
 * The confirm's line for an answer (not_found, failed) or a refused request (stale, unsupported, else the code's fixed
 * line); busy has none: a stop of that id runs, and the confirm follows the state.
 */
export function stopLine(code: string, messages: Readonly<Record<string, string>>): string | null {
  if (code === "busy" || code === "stopped") return null;
  return STOP_WORDS[code] ?? messages[code] ?? messages.failed ?? null;
}

// ---- Open in terminal (DESIGN-R131 7): the pane's one line, with Claude Code's own key to leave attach

/**
 * The pane's line once `claude attach <id>` is typed for a session that runs (starting, working, needs input, idle):
 * Enter opens it in Claude Code's own screen, where its prompts are answered; Ctrl+Z leaves it running (`claude attach
 * --help`: "Ctrl+Z drops back to your shell. The session keeps running either way.").
 */
export const ATTACH_PANE_LINE = "The command is at the prompt. Press Enter to open the session, and answer its prompts there. Ctrl+Z drops back to your shell, and the session keeps running.";
/** The same for a session that ended (completed, failed, stopped): it has no prompt, and `claude attach <id>` "opens it again". */
export const ATTACH_AGAIN_LINE = "The command is at the prompt. Press Enter to open the session again. Ctrl+Z drops back to your shell.";
