// The composer's text model (DESIGN.md 6.4 and 5.1 rule 7). The first character typed into an empty field picks the
// mode and becomes the mode chip: "/" for a command, "!" for Bash mode. A draft's mode is its own field (the store's
// draft, D49), never its text's first character: a message that starts with "!" (link text, a message taken back or
// refused) stays a message, also when it is edited. Text that came from a link stays plain until it is sent or cleared.
//
// The `/` menu's rows are the chat's own commands (the `commands` event, or `get commands`, 4.3). Each function that
// reads them takes the list; the catalog's COMMANDS (empty on the real page, the scripted rows in the unit tests) is
// the default. `commandMenu` binds the functions to one chat's list for the composer.
import { COMMANDS } from "../state/catalog";
import { filterFits } from "./mention";
import type { ChatDraft, DraftInput } from "../state/store";
import type { Route } from "../router";
import type { Chat, CommandRow } from "../state/types";

export type Mode = "chat" | "slash" | "bash";

export interface Draft {
  mode: Mode;
  command: string | null; // the command chip, in slash mode only
  text: string; // what the field holds, after the chip
  fromLink: boolean; // the text came from a link (the address bar, Back or Forward, or another page's link draft)
}

export const EMPTY: Draft = { mode: "chat", command: null, text: "", fromLink: false };

/** A `/` menu row with the aliases that typing also matches (6.4). */
export type MenuRow = CommandRow & { aliases?: string[] };

/** The chat's `/` menu rows: Claude Code's own list once it came, else the catalog's (empty outside the tests). */
export function menuRowsOf(chat: Pick<Chat, "commands"> | undefined): MenuRow[] {
  const list = chat?.commands;
  if (!list || list.length === 0) return COMMANDS;
  return list.map((c) => ({
    name: c.name,
    hint: c.description,
    args: c.argumentHint || undefined,
    source: c.builtin ? "built-in" : "user",
    terminalOnly: c.terminalOnly || undefined,
    aliases: c.aliases.length ? [...c.aliases] : undefined,
  }));
}

export function findCommand(name: string, rows: readonly MenuRow[] = COMMANDS): MenuRow | undefined {
  return rows.find((c) => c.name === name) ?? rows.find((c) => c.aliases?.includes(name));
}

/** The store's draft (the server's own fields) as the field shows it: its mode and chip are its own fields. */
export function fromStore(d: Pick<ChatDraft, "mode" | "command" | "text"> & { link?: boolean }): Draft {
  if (d.mode === "chat" && d.text === "" && !d.link) return EMPTY;
  return { mode: d.mode, command: d.mode === "slash" ? d.command : null, text: d.text, fromLink: !!d.link };
}

/** The field's draft as the store takes it (act.setDraft), field for field. */
export function toInput(d: Draft): DraftInput & { link: boolean } {
  return { mode: d.mode, command: d.mode === "slash" ? d.command : null, text: d.text, link: d.fromLink };
}

/** One key per draft, to tell the store's draft from the one this composer wrote last. */
export function draftKey(d: Draft): string {
  return JSON.stringify([d.mode, d.mode === "slash" ? d.command : null, d.text, d.fromLink]);
}

/**
 * The draft after the field's value changed to `value` (`replacedAll`: the change typed over the whole text). The first
 * character picks the mode only when the field held nothing before it, so a "!" typed in front of a message, or a
 * message that starts with "!" and is edited, stays a message. Link text stays plain, and stops counting as the link's
 * once it is cleared or typed over as a whole (5.1 rule 7).
 */
export function typed(prev: Draft, value: string, replacedAll: boolean): Draft {
  const fromLink = prev.fromLink && value !== "" && !replacedAll;
  const fresh = prev.text === "" || replacedAll;
  if (prev.mode === "chat" && !fromLink && fresh) {
    if (value.startsWith("!")) return { mode: "bash", command: null, text: value.slice(1), fromLink: false };
    if (value.startsWith("/")) return { mode: "slash", command: null, text: value.slice(1), fromLink: false };
  }
  if (prev.mode === "chat" && value === "") return EMPTY;
  return { ...prev, text: value, fromLink };
}

/** The message that Send sends, or the command that Run runs. Empty when there is nothing to send. */
export function outgoing(d: Draft): string {
  if (d.mode === "slash") {
    if (!d.command) return d.text.trim() ? "/" + d.text.trimEnd() : "";
    const args = d.text.trim();
    return args ? `/${d.command} ${args}` : `/${d.command}`;
  }
  if (d.mode === "bash") return d.text.trim();
  return d.text.trim() ? d.text.trimEnd() : "";
}

/** The / menu's rows for a filter: name prefixes first, then names or aliases that contain it. Terminal-only commands
 *  show on every size, because the Terminal pane is on every size (D47; a pick opens it). `hideTerminal` leaves them
 *  out, as a remote UI without that pane would ("Phone/remote UIs should hide these from command menus"). */
export function commandRows(q: string, hideTerminal = false, rows: readonly MenuRow[] = COMMANDS): MenuRow[] {
  const ql = q.toLowerCase();
  const hit = (c: MenuRow) => c.name.toLowerCase().includes(ql) || !!c.aliases?.some((a) => a.toLowerCase().includes(ql));
  const list = rows.filter((c) => !(hideTerminal && c.terminalOnly) && (!ql || hit(c)));
  const rank = (c: MenuRow) => (c.name.toLowerCase().startsWith(ql) ? 0 : 1);
  return list.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
}

export type MenuAt = { top: true } | { command: string };

export interface Prefill {
  key: string; // changes when the link's pre-fill changes, so Back and Forward fill again
  draft?: Draft; // absent: the link fills nothing (over its cap), and the field keeps what it had
  menu?: MenuAt;
  /** /c/<chat>/mention (9.3): the `@` picker's filter; the composer shows `@<q>` after the box's text as its token. */
  mention?: string;
  /** The link's value could not be used and was left out (5.4: "Part of that link could not be read."). */
  dropped?: boolean;
  overCap: boolean;
  notAvailable: boolean; // a command the chat does not offer here
}

const TEXT_CAP = 5000; // DESIGN.md 5.1 rule 7, the same cap as the router's

/** True when the link held this key but the router dropped it for its length (DESIGN.md 5.4, the over-cap line). */
function overCap(key: string): boolean {
  if (typeof location === "undefined") return false;
  const raw = new URLSearchParams(location.search).get(key);
  return raw !== null && raw.length > TEXT_CAP;
}

/**
 * What a composer route pre-fills (DESIGN.md 5.2): send, bash, the / menu, a command row and the `@` picker (9.3).
 * Nothing acts. A command row is judged against the chat's list only once Claude Code sent one: before that, the
 * link's command fills its chip as it is, and the key says so, so the list's arrival fills again.
 */
export function prefillOf(route: Route, hideTerminal = false, rows: readonly MenuRow[] = COMMANDS): Prefill | null {
  const q = route.query;
  const str = (k: string) => (typeof q[k] === "string" && q[k] !== "" ? (q[k] as string) : undefined);
  switch (route.name) {
    case "send": {
      const text = str("text");
      if (text !== undefined) return { key: "send|" + text, draft: { mode: "chat", command: null, text, fromLink: true }, overCap: false, notAvailable: false };
      if (overCap("text")) return { key: "send|over", overCap: true, notAvailable: false };
      return null;
    }
    case "bash": {
      const cmd = str("cmd") ?? "";
      const over = !cmd && overCap("cmd");
      return { key: `bash|${over ? "over" : cmd}`, draft: { mode: "bash", command: null, text: cmd, fromLink: !!cmd }, overCap: over, notAvailable: false };
    }
    case "slashMenu":
      return { key: "slash", draft: { mode: "slash", command: null, text: "", fromLink: false }, menu: { top: true }, overCap: false, notAvailable: false };
    case "slash": {
      const name = route.params.command ?? "";
      const args = str("args") ?? "";
      const over = !args && overCap("args");
      const known = rows.length > 0;
      const key = `slash|${name}|${over ? "over" : args}${known ? "" : "|unknown"}`;
      if (!known) return { key, draft: { mode: "slash", command: name, text: args, fromLink: !!args }, menu: { top: true }, overCap: over, notAvailable: false };
      const cmd = findCommand(name, rows);
      if (!cmd || (cmd.terminalOnly && hideTerminal))
        return { key, draft: { mode: "slash", command: null, text: "", fromLink: false }, menu: { top: true }, overCap: over, notAvailable: true };
      // A terminal-only command cannot be sent from here: its row shows, greyed, and a pick opens Open in terminal.
      if (cmd.terminalOnly) return { key, draft: { mode: "slash", command: null, text: "", fromLink: false }, menu: { command: cmd.name }, overCap: over, notAvailable: false };
      return { key, draft: { mode: "slash", command: cmd.name, text: args, fromLink: !!args }, menu: { command: cmd.name }, overCap: over, notAvailable: false };
    }
    case "mention": {
      // The `@` picker over the chat's folder (9.3): the filter only; no chip until a pick. A `q` over its cap fills
      // nothing and opens nothing; the 5.4 line says why. A `q` that no filter can be (white space, which ends the
      // picker's token, or over the 1,024 characters of a filter) is a bad value: it is left out with 5.4's line, and
      // the picker opens with no filter.
      const qv = str("q") ?? "";
      if (!qv && overCap("q")) return { key: "mention|over", overCap: true, notAvailable: false };
      const fits = filterFits(qv);
      return { key: `mention|${qv}`, mention: fits ? qv : "", dropped: !fits, overCap: false, notAvailable: false };
    }
  }
  return null;
}

/** The functions above, bound to one chat's `/` menu rows (the composer's view of them). */
export interface CommandMenu {
  rows: MenuRow[];
  commandRows(q: string): MenuRow[];
  findCommand(name: string): MenuRow | undefined;
  prefillOf(route: Route): Prefill | null;
}

export function commandMenu(rows: MenuRow[]): CommandMenu {
  return {
    rows,
    commandRows: (q) => commandRows(q, false, rows),
    findCommand: (name) => findCommand(name, rows),
    prefillOf: (route) => prefillOf(route, false, rows),
  };
}
