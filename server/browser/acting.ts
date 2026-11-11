// "Claude is acting" from the chat stream (DESIGN-B1 2.13; SERVER-B1 11). The registry calls `event` for each tool
// event of every kitespan chat (a hook, not a viewer, so no chat is kept awake). A `tool_call` whose name starts with
// `mcp__playwright__` adds an entry; its `tool_result` or `tool_stopped` removes it; `turn_end` and `exit` clear the
// chat. ToolSearch never counts. The owner's terminal sessions drive the same browser, but their streams are not
// kitespan's, so they light nothing.
//
// A tab's mark (`claudeLast`) is the chat whose browser result named the tab most recently. A chat's mark goes when
// its process ends (`exit`, or the registry's `ended` for a close of kitespan's own, which draws no `exit` event) and
// when the chat is archived or deleted; the next newest chat on that tab keeps the mark, or none. Each such end also
// tells the relay (`ended`), whose size set by that chat and whose chooser of that chat's go with it.
//
// Which tab: from a result's text, the `(current)` line of `### Open tabs` or `### Result`, else `- Page URL:` under
// `### Page`, matched to a tab by URL, then by title; no match, or two, gives no tab. The tabs matched are the relay's
// listed tabs and its spares: a result that names a spare alone makes it a listed tab (relay.ts spareUsed), and the
// blank start tab and a blank spare are two matches, so a result at about:blank then names neither. While a call runs,
// its tab is the chat's last uniquely named tab, except for browser_navigate, browser_tabs and browser_close, whose tab
// is unknown until their result. A result that names no page (browser_resize's) is on its call's tab, else on the
// chat's last named tab when it comes (a call sent with a browser_navigate in one message). A format change of a later
// MCP version gives no tab, never an error.
//
// Whose call runs on a tab (a dialog's and a file chooser's `by: claude`): a call on that tab, or of a chat whose last
// tab it is, then a call on a tab not yet known. A browser_navigate, browser_tabs or browser_close call of a chat whose
// last tab is another tab counts for no other tab: it gives no user activation there, so it opens no chooser there.

import { BROWSER_TOOL_PREFIX, type BrowserActing } from "../../shared/browser";
import type { ChatEvent } from "../../shared/protocol";

/** The tools whose tab is unknown until their result. */
const MOVING = new Set(["browser_navigate", "browser_tabs", "browser_close"]);

export interface ResultTab {
  url: string;
  title: string;
}

/** The tab a result names: the `(current)` line, else the Page section's URL and title; null when it names none. */
export function resultTab(text: string): ResultTab | null {
  const lines = text.split(/\r?\n/);
  let section = "";
  let page: { url: string | null; title: string } = { url: null, title: "" };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("### ")) {
      section = line.slice(4).trim();
      continue;
    }
    if (section === "Open tabs" || section === "Result") {
      const m = /^- \d+: \(current\) \[(.*)\]\((.*)\)$/.exec(line);
      if (m) {
        // The title may hold "](": the URL is after the last one.
        const whole = line.slice(line.indexOf("(current) [") + "(current) [".length, -1);
        const cut = whole.lastIndexOf("](");
        return { title: whole.slice(0, cut), url: whole.slice(cut + 2) };
      }
    }
    if (section === "Page") {
      const u = /^- Page URL: (.+)$/.exec(line);
      if (u) page.url = u[1]!.trim();
      const t = /^- Page Title: (.*)$/.exec(line);
      if (t) page.title = t[1]!.trim();
    }
  }
  return page.url ? { url: page.url, title: page.title } : null;
}

/** The tab that a result's URL and title name alone, among `tabs`: by URL, then by title; else null. */
export function matchTab(named: ResultTab, tabs: readonly { id: string; url: string; title: string }[]): string | null {
  const byUrl = tabs.filter((t) => t.url === named.url);
  if (byUrl.length === 1) return byUrl[0]!.id;
  const pool = byUrl.length > 1 ? byUrl : tabs;
  if (!named.title) return null;
  const byTitle = pool.filter((t) => t.title === named.title);
  return byTitle.length === 1 ? byTitle[0]!.id : null;
}

interface Entry {
  chat: string;
  id: string;
  tool: string;
  tab: string | null;
  since: string;
  input: unknown;
}

/** What the relay learns from the stream (kitespan's chats only). */
export type ActingFact =
  /** A result named this tab alone: the chat's last tab. */
  | { k: "named"; chat: string; tab: string }
  /** The chat's mark went (its process ended, or it was archived or deleted): once, when it had one. */
  | { k: "forgot"; chat: string }
  /** The chat ended (each word of the registry's, and its exit event): what it set in a tab goes too. */
  | { k: "ended"; chat: string }
  /** browser_resize returned on this tab with this size (the tab's size.by is claude). */
  | { k: "resized"; chat: string; tab: string | null; w: number; h: number }
  /** browser_file_upload returned with paths (Claude chose the file), or with none (it cleared its stale state). */
  | { k: "uploaded"; chat: string; tab: string | null; paths: boolean }
  /** A browser call's result came: the focused field's facts may have changed. */
  | { k: "result"; chat: string; tab: string | null };

export interface ActingOptions {
  /** The tabs as the relay knows them now. */
  tabs: () => readonly { id: string; url: string; title: string }[];
  onChange: (list: BrowserActing[]) => void;
  onFact: (f: ActingFact) => void;
  now?: () => Date;
}

export class Acting {
  private readonly entries = new Map<string, Entry>();
  /** Each chat's last uniquely named tab, in the order of those results: the newest is last. */
  private readonly last = new Map<string, string>();
  /** The chats whose turn runs a browser call (from its first call to its turn_end or exit). */
  private readonly turns = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly o: ActingOptions) {
    this.now = o.now ?? (() => new Date());
  }

  list(): BrowserActing[] {
    return [...this.entries.values()].map((e) => ({ chat: e.chat, tool: e.tool, tab: e.tab, since: e.since }));
  }

  /** The chat whose result named this tab alone most recently (a tab's `claudeLast`). */
  lastOf(tab: string): string | null {
    let newest: string | null = null;
    for (const [chat, t] of this.last) if (t === tab) newest = chat;
    return newest;
  }

  /** A running turn's Claude acts in the tab, or last used it (Close and Page size then ask first). */
  actsIn(tab: string): boolean {
    for (const e of this.entries.values()) if (e.tab === tab) return true;
    for (const chat of this.turns) if (this.last.get(chat) === tab) return true;
    return false;
  }

  /**
   * A kitespan chat's browser call (of `tool`, when given) runs on this tab or on an unknown one: a dialog's and a file
   * chooser's `by: claude`.
   */
  running(tab: string, tool?: string): boolean {
    return this.runner(tab, tool) !== null;
  }

  /**
   * The chat whose browser call (of `tool`, when given) runs on this tab: a call on it, or of a chat whose last tab it
   * is, first; else a call on a tab not yet known, but not a navigate, tabs or close call of a chat whose last tab is
   * another (it gives no user activation in this tab). Null: none.
   */
  runner(tab: string, tool?: string): string | null {
    let unknown: string | null = null;
    for (const e of this.entries.values()) {
      if (tool !== undefined && e.tool !== tool) continue;
      const last = this.last.get(e.chat);
      if (e.tab === tab || last === tab) return e.chat;
      if (e.tab === null && unknown === null && !(MOVING.has(e.tool) && last !== undefined)) unknown = e.chat;
    }
    return unknown;
  }

  /** A tab went: no chat's last tab is it any more. */
  forgetTab(tab: string): void {
    for (const [chat, t] of [...this.last]) if (t === tab) this.last.delete(chat);
  }

  /**
   * The registry's word that a chat ended: its process ended (also by kitespan's own close), or it was archived or
   * deleted. Its running calls and its mark go; a result that comes later has no entry, so it marks nothing.
   */
  ended(chat: string): void {
    this.clearChat(chat);
    if (this.last.delete(chat)) this.o.onFact({ k: "forgot", chat });
    this.o.onFact({ k: "ended", chat });
  }

  /** One event of a kitespan chat (the registry's `tools` hook, before any cap). */
  event(chat: string, e: ChatEvent): void {
    switch (e.k) {
      case "tool_call": {
        if (!e.name.startsWith(BROWSER_TOOL_PREFIX)) return;
        const tool = e.name.slice(BROWSER_TOOL_PREFIX.length);
        const seen = this.entries.get(e.id);
        if (seen) {
          // The call's second event carries its input.
          if (e.input !== null && e.input !== undefined) seen.input = e.input;
          return;
        }
        this.turns.add(chat);
        this.entries.set(e.id, { chat, id: e.id, tool, tab: MOVING.has(tool) ? null : (this.last.get(chat) ?? null), since: this.now().toISOString(), input: e.input });
        this.changed();
        return;
      }
      case "tool_result": {
        const entry = this.entries.get(e.id);
        if (!entry) return;
        this.entries.delete(e.id);
        const named = resultTab(e.text);
        const tab = named ? matchTab(named, this.o.tabs()) : null;
        if (tab) {
          // The newest result goes last, so the mark names the chat that used the tab most recently.
          this.last.delete(chat);
          this.last.set(chat, tab);
          this.o.onFact({ k: "named", chat, tab });
        }
        // A result that names no page (browser_resize's) is on its call's tab, else on the chat's last named tab now: a
        // call sent in one message with a browser_navigate started before that navigate's result named the tab.
        const where = tab ?? entry.tab ?? (MOVING.has(entry.tool) ? null : (this.last.get(chat) ?? null));
        if (!e.isError) {
          const input = (entry.input ?? {}) as Record<string, unknown>;
          const { width, height } = input;
          if (entry.tool === "browser_resize" && typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height)) {
            this.o.onFact({ k: "resized", chat, tab: where, w: width, h: height });
          }
          if (entry.tool === "browser_file_upload") {
            const paths = Array.isArray(input.paths) && input.paths.length > 0;
            this.o.onFact({ k: "uploaded", chat, tab: where, paths });
          }
        }
        this.o.onFact({ k: "result", chat, tab: where });
        this.changed();
        return;
      }
      case "tool_stopped":
        if (this.entries.delete(e.id)) this.changed();
        return;
      case "turn_end":
        this.clearChat(chat);
        return;
      case "exit":
        this.ended(chat);
        return;
    }
  }

  /** The chat's turn is over: its running calls go. */
  private clearChat(chat: string): void {
    this.turns.delete(chat);
    let any = false;
    for (const [id, en] of [...this.entries]) {
      if (en.chat === chat) {
        this.entries.delete(id);
        any = true;
      }
    }
    if (any) this.changed();
  }

  private changed(): void {
    this.o.onChange(this.list());
  }
}
