// R127 (owner rows 126, 127 and 129; DESIGN-R127 5 to 10): Trust this folder on the page. When Claude Code refuses a
// background session because a folder is not trusted, the server matches its exact line in the tool result (before the
// text cap) and puts `trust: {path, root}` on that row's event. The page draws one line under the first visible line
// that holds the newest such row of a folder, only while that row is in the chat's last turn, and never in a read-only
// view. The line's state is the server's (the `trust` events and `attached.trust`, the same on every device, D49).
// Its buttons only open a route: the confirm (/c/<chat>/trust/<toolUse>), whose Trust this folder sends the one
// request, or the Terminal pane with Claude Code's own command typed, not run (the fallback). Pure: no DOM, no store.
import { isTrustState, type TrustRef, type TrustRefusal, type TrustState } from "../../shared/protocol";
// The route table's own encoder (shared/route.ts, which web/router.ts re-exports): no DOM here, so the reducer that reads
// this file still type-checks where no browser globals are (the server's tests read the reducer).
import { href } from "../../shared/route";
import type { Item, ToolItem } from "../state/types";
import type { Block } from "./turns";

export { isTrustState, type TrustState };
/** What the line says: offered (no answer for the folder since the server started, or a refusal came after it), or an answer. */
export type TrustLineState = "offered" | TrustState;

/** The folder a refused row names, as the server matched it: its real path, and its repository's root when that is another folder. */
export type TrustTarget = TrustRef;

/** A row that carries the line: its tool use id and its folder. */
export interface TrustRow extends TrustTarget {
  id: string;
}

/** A tool row whose result holds Claude Code's refusal (the server's `trust` on it). */
export type RefusedRow = ToolItem & { trust: TrustTarget };

export function isRefused(it: Item): it is RefusedRow {
  return it.kind === "tool" && !!it.trust && typeof it.trust.path === "string" && it.trust.path.startsWith("/");
}

/** The folder's name on the line: its last two segments (`tasks/remove-negative-qty`); the full path is its title. */
export function trustName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts.slice(-2).join("/") : "/";
}

/** Every refused row in `items` and the subagent blocks inside them, in their order. */
function refusedIn(items: readonly Item[], out: RefusedRow[] = []): RefusedRow[] {
  for (const it of items) {
    if (isRefused(it)) out.push(it);
    else if (it.kind === "agent") refusedIn(it.rows, out);
  }
  return out;
}

/**
 * The rows that carry the line (DESIGN-R127 5.1): the newest refused row of each folder among the rows of the chat's
 * last turn (subagent rows too), by tool use id. A later turn takes the line away whatever its state, so a chat's
 * history never fills with old offers; a row outside every turn carries none.
 */
export function trustRows(blocks: readonly Block[]): ReadonlyMap<string, TrustRow> {
  let last: Item[] | null = null;
  for (const b of blocks) if (b.k === "turn") last = b.turn.rows;
  const newest = new Map<string, RefusedRow>();
  for (const it of refusedIn(last ?? [])) newest.set(it.trust.path, it);
  const out = new Map<string, TrustRow>();
  for (const it of newest.values()) out.set(it.id, { id: it.id, path: it.trust.path, root: it.trust.root ?? null });
  return out;
}

/** The rows among `items` (deep, in order) that carry the line: what a closed summary, subagent block or turn shows under its head. */
export function trustRowsIn(items: readonly Item[], rows: ReadonlyMap<string, TrustRow> | undefined): TrustRow[] {
  if (!rows?.size) return [];
  const out: TrustRow[] = [];
  const walk = (list: readonly Item[]) => {
    for (const it of list) {
      const r = rows.get(it.id);
      if (r) out.push(r);
      if (it.kind === "agent") walk(it.rows);
    }
  };
  walk(items);
  return out;
}

/** The refused row a confirm route names, anywhere in the chat (a subagent's row too), or null. */
export function refusedRow(items: readonly Item[], toolUse: string): RefusedRow | null {
  for (const it of items) {
    if (it.id === toolUse) return isRefused(it) ? it : null;
    if (it.kind === "agent") {
      const hit = refusedRow(it.rows, toolUse);
      if (hit) return hit;
    }
  }
  return null;
}

/** `attached.trust` as the page keeps it: each absolute path with a known state; undefined when none. */
export function attachedTrust(raw: unknown): Record<string, TrustState> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, TrustState> = {};
  for (const [path, st] of Object.entries(raw as Record<string, unknown>)) if (path.startsWith("/") && isTrustState(st)) out[path] = st;
  return Object.keys(out).length ? out : undefined;
}

/** The map with `path` set to `state`, or taken out (`null`: a live refusal of it came, so its line offers again). */
export function withTrust(trust: Readonly<Record<string, TrustState>> | undefined, path: string, state: TrustState | null): Readonly<Record<string, TrustState>> | undefined {
  if (state === null) {
    if (!trust || !(path in trust)) return trust;
    const { [path]: _gone, ...rest } = trust;
    return Object.keys(rest).length ? rest : undefined;
  }
  return trust?.[path] === state ? trust : { ...trust, [path]: state };
}

/** The line's state for a folder: the server's last answer for it, else offered. */
export function lineState(trust: Readonly<Record<string, TrustState>> | null | undefined, path: string): TrustLineState {
  const s = trust?.[path];
  return isTrustState(s) ? s : "offered";
}

/** The states whose confirm still offers Trust this folder (another device's press takes it away). */
export function canTrust(state: TrustLineState): boolean {
  return state === "offered" || state === "failed";
}

/**
 * The line's words per state (DESIGN-R127 5.3 and 10): the folder's name goes between `before` and `after`. Every state
 * names it on screen, so an answered line above another folder's offer is never read as that folder's (the lead's
 * words after the R127 review); the offer says what was blocked.
 */
export const TRUST_WORDS = {
  offered: { before: "", after: " is not trusted, so Claude Code did not start a background session there." },
  trusting: { before: "Trusting ", after: "..." },
  gone: { before: "", after: " is not there any more." },
  trusted: { before: "", after: " is trusted. Ask Claude to try again." },
  already: { before: "", after: " was already trusted. Ask Claude to try again." },
  not_recorded: { before: "Claude Code did not record ", after: " as trusted." },
  failed: { before: "Claude Code did not start, so ", after: " was not trusted." },
} as const;

/** The line's words as plain text (a screen reader's, the tests'). */
export function lineText(state: TrustLineState, path: string): string {
  const w = TRUST_WORDS[state];
  return `${w.before}${trustName(path)}${w.after}`;
}

/** The action names: one name from the line to the confirm to its result (Trust this folder, Trust this folder?, Trusted). */
export const TRUST_BUTTON = "Trust this folder";
export const TRUST_TITLE = "Trust this folder?";
export const TRY_AGAIN = "Try again";
/** Desktop's words (DESIGN.md 6.12). */
export const OPEN_IN_TERMINAL = "Open in terminal";

/** The line's button: what it opens (never what it does; only the confirm's button sends). */
export type TrustButton = { label: string; to: "confirm" | "terminal" } | null;

/**
 * The button of each state. Offered: Trust this folder, which opens the confirm, or Open in terminal when the server's
 * agent cannot trust a folder itself (the capability off, row 127's first answer). Failed: Try again (the confirm).
 * Not recorded: Open in terminal, so Claude Code's own question asks.
 */
export function lineButton(state: TrustLineState, canAttest: boolean): TrustButton {
  if (state === "offered") return canAttest ? { label: TRUST_BUTTON, to: "confirm" } : { label: OPEN_IN_TERMINAL, to: "terminal" };
  if (state === "failed") return canAttest ? { label: TRY_AGAIN, to: "confirm" } : { label: OPEN_IN_TERMINAL, to: "terminal" };
  if (state === "not_recorded") return { label: OPEN_IN_TERMINAL, to: "terminal" };
  return null;
}

/** The confirm's route for a refused row: it names the row, never a path, so a link cannot name a folder Claude Code did not refuse. */
export function trustHref(chatId: string, toolUse: string, view?: string): string {
  return href("trust", { chat: chatId, toolUse }, { view });
}

/** The Terminal pane with `cd <folder> && claude` typed at its prompt for that row (the server takes the path from its own match). */
export function trustTerminalHref(chatId: string, toolUse: string, view?: string): string {
  return href("shell", { chat: chatId }, { type: "trust", tool: toolUse, view });
}

// ---- the confirm's words: Claude Code's own (its trust dialog, 2.1.317 and 2.1.318; DESIGN-R127 2.1), word for word

export const CC_QUESTION =
  "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.";
export const CC_ALLOWS = "Claude Code'll be able to read, edit, and execute files here.";
/** Claude Code's line for a folder inside a repository whose root is another folder: the parts around the root and `claude`. */
export const CC_REPO = { before: "This folder is part of the repository at ", middle: "; trusting it trusts that whole repository, including when you run ", after: " there." } as const;
export const ccRepoText = (root: string) => `${CC_REPO.before}${root}${CC_REPO.middle}claude${CC_REPO.after}`;

/** The pane's line once the server typed the command (the pane's pattern, with Claude Code's choice words). */
export const TRUST_PANE_LINE = "The command is at the prompt. Press Enter to run it, then choose Yes, I trust this folder.";
/** The Terminal pane's line when the chat holds no refused row of that id any more (the server typed nothing). */
export const TRUST_NOT_IN_CHAT = "That refused folder is not in this chat.";

// ---- a refused request's line in the confirm (DESIGN-R127 8.4 and 10)

export const REFUSAL_WORDS: Readonly<Record<TrustRefusal, string>> = {
  link: "That path is a link now, so kitespan did not trust it.",
  not_folder: "That path is not a folder now.",
  home: "Claude Code never saves trust for the home directory.",
  holds_home: "kitespan does not trust a folder that holds the home directory.",
  too_long: "That path is too long.",
};

/**
 * The confirm's line for a refused `trust_folder`: a `trust_refused` reason's own words, else the code's fixed line
 * (`messages`, the protocol's), else the agent's failure. `busy` has none: a trust start runs for the folder already, and
 * the confirm follows the line, which says Trusting.
 */
export function trustRefusalLine(code: string, reason: string | null, messages: Readonly<Record<string, string>>): string | null {
  if (code === "busy") return null;
  if (code === "trust_refused") return (reason && REFUSAL_WORDS[reason as TrustRefusal]) || messages.trust_refused || messages.failed || null;
  return messages[code] ?? messages.failed ?? null;
}
