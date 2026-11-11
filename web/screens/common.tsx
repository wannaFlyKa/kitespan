// Shared words and small parts of the navigation, Home, project and dialog screens (DESIGN.md 6.2, 6.9, 6.10).
import { useEffect, useLayoutEffect, useMemo, type RefObject } from "react";
import type { ModelInfo } from "../../shared/protocol";
import { href, navigate, parse, type EntryState, type Route } from "../router";
import { EFFORTS, MODES } from "../state/catalog";
import { act, getState, modelRows, restartingNow, useStore } from "../state/store";
import { listState } from "../state/reduce";
import type { Chat, ChatState, ModelRow, Project } from "../state/types";
import { relTime, usePopupSheet } from "../ui/primitives";
import { RESTART_WORDS } from "../settings/restart";
import { bgDotSaid, chatDot } from "../chat/background";

/**
 * Claude Code's agent-view words for a chat state (DESIGN.md 6.2); "Unread" is Desktop's (its sidebar's read and
 * unread mark, row 116), read out only; "Sleeping" is kitespan's own (no claude process).
 */
export const STATE_WORD: Record<ChatState, string> = {
  starting: "Starting",
  running: "Working",
  waiting: "Needs input",
  failed: "Failed",
  unread: "Unread",
  idle: "Idle",
  sleeping: "Sleeping",
};

/** The states whose word leads the row, before the title, in place of the time (DESIGN.md 6.2). */
const LEADS = new Set<ChatState>(["waiting", "failed"]);
/**
 * The states that a search result marks with a dot, and the title bar of those it shows (M2: Needs input and Failed
 * only; the bar's state, barState, is never Failed since row 116; the name says the state).
 */
export const MARKED = LEADS;

/**
 * The chat's state in its own title bar (row 116, DESIGN-R116 9): unread and failed are the seen flag, and the chat in
 * its own bar is the one on screen, whose view clears the flag at its end and offers Jump to latest above it. So the
 * bar names the chat's own state and draws no unread or failed dot (one mark per fact); it marks Needs input only.
 */
export function barState(chat: Pick<Chat, "state" | "serverState">): ChatState {
  return chat.state === "unread" || chat.state === "failed" ? listState(chat.serverState) : chat.state;
}

/** Where a chat's title came from, as visible text in the Rename form (DESIGN.md 6.10): never a tooltip. */
export const TITLE_SOURCE: Record<Chat["titleSource"], string> = {
  rename: "Named by you",
  generated: "Named by Claude Code",
  "first-prompt": "From the first prompt",
};

/**
 * The model rows the page knows (6.6, row 81): Claude Code's model list as the server keeps it, the same in every chat
 * and project (the store's `modelList`: the route's answer, or any chat's `get models`; else a chat's own rows), or null
 * before any came. Each row is a model value that `set_model` and `new_chat` send.
 */
export function knownModels(chats: readonly Chat[], kept: readonly ModelInfo[] | null = getState().modelList): ModelRow[] | null {
  if (kept && kept.length > 0) return modelRows({ models: [...kept] });
  const c = chats.find((x) => x.models && x.models.length > 0);
  return c ? modelRows(c) : null;
}
/** knownModels from the store, or Claude Code's Default row alone before any list came. */
export function useModelRows(): ModelRow[] {
  const kept = useStore((s) => s.modelList);
  const chat = useStore((s) => s.chats.find((x) => x.models && x.models.length > 0)?.models ?? null);
  return useMemo(() => modelRows({ models: kept && kept.length > 0 ? kept : chat }), [kept, chat]);
}

/**
 * Read Claude Code's model rows for a label or a picker (GET /api/projects/:project/models, which changes nothing the
 * user made): the server's kept list, or with none kept its one short read for this project's folder. Nothing once the
 * page has the rows; two asks at once share one read (act.loadModels).
 */
export function askModelRows(projectId: string | undefined) {
  if (!projectId || getState().modelList?.length) return;
  void act.loadModels(projectId);
}
/** The model rows, read once when the page names a model it has no row for, so the model shows by its name. */
export function useModelRowsFor(model: string | undefined, projectId?: string): ModelRow[] {
  const rows = useModelRows();
  const known = !model || model === "default" || rows.some((m) => m.id === model);
  useEffect(() => {
    if (!known) askModelRows(projectId);
  }, [known, projectId]);
  return rows;
}

export const modelLabel = (id: string | undefined, rows: readonly ModelRow[] = []) => rows.find((m) => m.id === id)?.label ?? (id === "default" ? "Default" : id ?? "");
export const effortLabel = (id?: string) => EFFORTS.find((e) => e.id === id)?.label ?? id ?? "";
export const modeLabel = (id?: string) => MODES.find((m) => m.id === id)?.label ?? id ?? "";

/** The effort levels a model offers: its row's, or every level for a model the page has no row for. */
export function effortsOf(model: string | undefined, rows: readonly ModelRow[] = []): string[] {
  return rows.find((m) => m.id === (model ?? "default"))?.efforts ?? EFFORTS.map((e) => e.id);
}

/** The view key rides along on every /c/<chat> path (DESIGN.md 6.3), so a dialog closes back to the same view. */
export function viewOf(route: Route): string | undefined {
  return typeof route.query.view === "string" ? route.query.view : undefined;
}
export function chatHref(name: string, chatId: string, route: Route): string {
  return href(name, { chat: chatId }, { view: viewOf(route) });
}

/**
 * Where a chat's dialog (rename, archive, delete, Stop) closes to (5.1 rule 4): the page that opened it when that page
 * does not show this chat, as a row's Rename or Delete in a chat list does (/chats, Home, a project page, another
 * chat), so Cancel, Done or Save go back one step to where the user was; else the chat's own path (a dialog opened over
 * the chat, or by a URL with no page of kitespan's behind it). The router keeps the opener in the entry's `from`.
 */
export function dialogParent(chatId: string, route: Route): string {
  const own = chatHref("chat", chatId, route);
  if (typeof history === "undefined") return own;
  const from = (history.state as EntryState | null)?.from;
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//")) return own;
  const r = parse(new URL(from, "http://kitespan.invalid"));
  return r.fallbackFrom || r.params.chat === chatId ? own : from;
}

/** True when the address bar holds a value for `key` that is longer than its cap (DESIGN.md 5.4, the over-cap row). */
export function overCap(key: string, max: number): boolean {
  if (typeof location === "undefined") return false;
  const raw = new URLSearchParams(location.search).get(key);
  return raw !== null && raw.length > max;
}
export const TOO_LONG = "That link's text is too long to fill in (the limit is 5,000 characters, or 120 for a title or a setting).";
export const PART_UNREAD = "Part of that link could not be read.";
export const CHAT_GONE = "That chat is not here. It may have been deleted.";

export const newestFirst = (a: Chat, b: Chat) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

/** The folder's last segment and its parent, for "the folder name, its parent dimmed" (DESIGN.md 6.9). */
export function splitFolder(folder: string): { name: string; parent: string } {
  const i = folder.replace(/\/+$/, "").lastIndexOf("/");
  return i < 0 ? { name: folder, parent: "" } : { name: folder.slice(i + 1), parent: folder.slice(0, i) };
}

/** Projects, the last used first (the newest chat in each); projects with no chats keep their order at the end. */
export function byLastUse(projects: Project[], chats: Chat[]): Project[] {
  const last = new Map<string, number>();
  for (const c of chats) last.set(c.projectId, Math.max(last.get(c.projectId) ?? 0, Date.parse(c.updatedAt)));
  return projects
    .map((p, i) => ({ p, i, t: last.get(p.id) ?? -1 }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.p);
}

/** A chat row's title with the row text of DESIGN.md 6.2, part one: a waiting chat's row starts with "Needs input",
 *  as agent view writes it ("Needs input · ..."), and a failed one with "Failed". Under the Needs input filter the
 *  word goes (`lead` false, M7): the filter says it, and the dot stays. The word and the title share one baseline
 *  (.scr-titled). The title is its own direction island (dir="auto"), so a right-to-left title, or a direction
 *  override typed into one, never reorders the words around it. */
export function ChatTitle({ chat, className, lead = true }: { chat: Chat; className: string; lead?: boolean }) {
  const title = (
    <span className={className} dir="auto">
      {chat.title}
    </span>
  );
  if (!LEADS.has(chat.state)) return title;
  if (!lead)
    return (
      <>
        <span className="visually-hidden">{STATE_WORD[chat.state]}, </span>
        {title}
      </>
    );
  return (
    <span className="scr-titled">
      <span className={`scr-lead is-${chat.state}`}>
        {STATE_WORD[chat.state]}
        <span className="visually-hidden">, </span>
      </span>
      {title}
    </span>
  );
}

/** The row text of DESIGN.md 6.2, part two, after the title: "Working" or "Starting" in place of the time, nothing
 *  for a waiting or failed chat (its word leads the row), else the time. With `words` false (the phone's Recent, M10;
 *  a row under the Working filter, M7) a working or starting chat shows its time too, and its state is read out only.
 *  An unread chat (row 116) shows its time with no word: its dot says it, and "Unread" is read out before the time. */
export function ChatMeta({ chat, words = true, now = Date.now() }: { chat: Chat; words?: boolean; now?: number }) {
  if (words && chat.state === "running") return <span className="scr-meta scr-meta-working">Working</span>;
  if (words && chat.state === "starting") return <span className="scr-meta">Starting</span>;
  if (LEADS.has(chat.state)) return null;
  return (
    <span className="scr-meta">
      <span className="visually-hidden">{STATE_WORD[chat.state]}, </span>
      {relTime(chat.updatedAt, now)}
    </span>
  );
}

// ---- Archive and Delete (D48, DESIGN.md 6.10)

/**
 * The chat's Claude Code is busy: the chat list says so (`busy`, D48: also for a chat this page has not attached, whose
 * background tasks it does not hear), or this page knows that a turn runs, a card waits or a background task that is
 * not ambient runs. Its Archive then reads "Stop and archive" (one tap: interrupt, close, hide). The server checks again
 * and answers `busy` to an Archive without `stop` on a chat that has become busy.
 */
export function isBusy(chat: Chat): boolean {
  if (chat.busy) return true;
  const s = chat.serverState;
  if (s === "starting" || s === "running" || s === "waiting") return true;
  if (chat.needsYou || chat.pending.length > 0 || chat.turn !== null) return true;
  return s !== "sleeping" && chat.tasks.some((t) => !t.ambient);
}

export interface ArchiveItem {
  label: "Archive" | "Stop and archive" | "Unarchive";
  testId: "confirm-archive" | "confirm-stop-and-archive" | "confirm-unarchive";
}
/** The one archive item a chat offers now: Unarchive for an archived chat, Stop and archive for a busy one. */
export function archiveItem(chat: Chat): ArchiveItem {
  if (chat.archived) return { label: "Unarchive", testId: "confirm-unarchive" };
  return isBusy(chat) ? { label: "Stop and archive", testId: "confirm-stop-and-archive" } : { label: "Archive", testId: "confirm-archive" };
}

/** True when this page has the chat attached (App attaches the route's chat), so it hears the chat's `tasks`. */
function attachedHere(chatId: string): boolean {
  if (typeof location === "undefined") return false;
  return parse(new URL(location.href)).params.chat === chatId;
}

/**
 * The `stop` of an Archive frame: true for a busy chat (Stop and archive), and for a chat with a process that this page
 * has not attached. A chat list row carries no background tasks (`chats`), so an idle row can still run one, and the
 * server would refuse a plain Archive of it with `busy`. With `stop` the server interrupts only a chat that is busy,
 * so for an idle chat the frame is a plain Archive: its process ends, as an idle chat's Archive does (D48).
 */
export function archiveStop(chat: Chat): boolean {
  if (isBusy(chat)) return true;
  return chat.serverState !== "sleeping" && !attachedHere(chat.id);
}

/**
 * The archive item's press (a click or tap handler only): Archive, Stop and archive or Unarchive. The page that
 * showed the chat goes to / with replaceState after an Archive (6.10); no notice line follows (principle 0).
 */
export function pressArchive(chat: Chat, shown: boolean) {
  if (chat.archived) {
    void act.unarchive(chat.id);
    return;
  }
  act.archive(chat.id, { stop: archiveStop(chat) });
  if (shown) navigate("/", { replace: true });
}

/** How long a refused request's line stays on a screen (ChatScreen's NOTICE_MS). */
export const SCREEN_NOTICE_MS = 8_000;

/**
 * The store's one line for a request that the server refused, on a screen that is not a chat: the phone's chat list
 * (a row's Archive), Home and /new (Start). A line left from another screen is not about this one, so it goes when the
 * screen opens; this screen's own line goes after 8 s, and when the screen closes, so it never shows later under a
 * chat that it is not about.
 */
export function useScreenNotice(): string | null {
  const notice = useStore((s) => s.notice);
  useLayoutEffect(() => {
    if (getState().notice !== null) act.setNotice(null);
    return () => {
      if (getState().notice !== null) act.setNotice(null);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => act.setNotice(null), SCREEN_NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);
  return notice;
}

/** The items of a chat's menu after its view items, in order (6.2, 6.10): the archive item, then Delete, last. */
export function endItems(chat: Chat): string[] {
  return [archiveItem(chat).label, "Delete"];
}

/** The classes of a Popup's rows (plan v3): menu rows in an anchored menu (a laptop, a tablet); on the phone, where
 *  Popup draws a sheet, grouped lists (.group) on the grouped surface, with their section titles and foot lines. */
export interface PopupRows {
  sheet: boolean;
  /** The content's box inside the Popup. */
  box: string;
  /** One list of rows: a .group in a sheet. */
  list: string;
  row: string;
  check: string;
  /** A section title above a list. */
  label: string;
  /** A line under the lists. */
  note: string;
}
export function usePopupRows(): PopupRows {
  const sheet = usePopupSheet(); // Popup's own rule for an anchored Popup: a sheet on the phone only
  return sheet
    ? { sheet, box: "scr-pick scr-sheet", list: "group scr-pick-group", row: "group-row", check: "group-check", label: "group-title scr-pick-label", note: "group-foot scr-pick-note" }
    : { sheet, box: "scr-pick", list: "scr-pick-list", row: "menu-row", check: "menu-check", label: "scr-pick-label", note: "scr-pick-note" };
}

/** The page's link to the kitespan server (DESIGN.md 6.2 and 4.3): the chat list's foot says "Reconnecting..." only
 *  while the page dials again (M4), and "Restarting kitespan..." from the old server's notice of its close (or its
 *  `bye {reason: "restart"}`) to the new one's `welcome` (4.10 steps 4 to 6), and from this page's own Restart now; a
 *  good connection shows no word (state/store.ts `net`, restartingNow). */
export type Connection = "connected" | "reconnecting" | "restarting";
export const RECONNECTING = "Reconnecting...";
export const RESTARTING = RESTART_WORDS.restarting;
export function useConnection(): Connection {
  return useStore((s) => (restartingNow(s) ? "restarting" : s.net === "open" ? "connected" : "reconnecting"));
}

/** A row's state dot (DESIGN.md 6.2, row 116; base.css .dot): hidden from screen readers, whose words the row says. */
export function StateDot({ state }: { state: ChatState }) {
  return <span className={`dot ${state}`} aria-hidden="true" />;
}

/**
 * A chat row's dot (R131, DESIGN-R131 9.5): the chat's own state, or its background sessions' field where that comes
 * first (chat/background.ts chatDot: a session that needs input before the chat's own turn, a failed or completed one
 * not seen after the chat's own). No visible word of its own; a screen reader hears it before the title.
 */
export function ChatDot({ chat }: { chat: Pick<Chat, "state" | "bgDot"> }) {
  const said = bgDotSaid(chat);
  return (
    <>
      <StateDot state={chatDot(chat)} />
      {said ? <span className="visually-hidden">{said}</span> : null}
    </>
  );
}

/** Keyboard focus for a menu that Popup draws at the end of the page: when it opens, focus goes to its checked row
 *  (else its first row); when it closes and focus was left on nothing, it goes back to the control that opened it. */
export function usePopupFocus(open: boolean, testId: string, opener: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const box = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      const row = box?.querySelector<HTMLElement>('[aria-checked="true"]') ?? box?.querySelector<HTMLElement>("a[href], button:not(:disabled)");
      row?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(id);
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (!a || a === document.body) opener.current?.focus({ preventScroll: true });
      });
    };
  }, [open, testId, opener]);
}
