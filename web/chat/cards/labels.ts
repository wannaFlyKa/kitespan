// The words of the waiting cards and of the records they leave in the transcript (DESIGN.md 6.3 and 6.12): Desktop's
// approval labels, the CLI's plan labels, and kitespan's own words where no source gives any.
import type { Route } from "../../router";
import { COMMANDS } from "../../state/catalog";
import type { Chat, ElicitationCard, Item, PermissionCard, PlanAnswer } from "../../state/types";

export const PERMISSION_LABEL: Record<NonNullable<PermissionCard["answered"]>, string> = {
  once: "Allow once",
  session: "Allow for this session",
  deny: "Deny",
};

/** The Workflow launch card (CA-4): Desktop's Once and Deny, and Allow for this session in Desktop's Always place (D27). */
export const WORKFLOW_LABEL: Record<NonNullable<PermissionCard["answered"]>, string> = {
  once: "Once",
  session: "Allow for this session",
  deny: "Deny",
};

export const PERMISSION_DONE: Record<NonNullable<PermissionCard["answered"]>, string> = {
  once: "Allowed once",
  session: "Allowed for this session",
  deny: "Denied",
};

export const PLAN_LABEL: Record<PlanAnswer, string> = {
  auto: "Yes, and use auto mode",
  "accept-edits": "Yes, auto-accept edits",
  bypass: "Yes, and bypass permissions",
  manual: "Yes, manually approve edits",
  "keep-planning": "No, keep planning",
};

export const ELICITATION_DONE: Record<NonNullable<ElicitationCard["answered"]>, string> = {
  accept: "Submitted",
  decline: "Declined",
  cancel: "Cancelled",
};

/** The 5.4 lines for a card link that no longer waits. */
export const LINE_ANSWERED = "That request was already answered.";
/** Only for a request the chat knows ended unanswered with its Claude Code process (DESIGN.md 4.1, 4.10). */
export const LINE_LOST = "That request was lost when Claude Code restarted. Send a message to continue.";
/** A request id the chat never had, or cannot tell about: it names no cause, because none is known. */
export const LINE_NOT_WAITING = "That request is not waiting in this chat.";
export const LINE_GONE = "That message is not in this chat.";
/** A card path whose request id names a waiting or answered card of another kind (/question/ on a permission). */
export const LINE_UNREAD = "That link could not be read.";
export const LINE_PICK = "That choice is not available in this chat.";
export const LINE_BYPASS_OFF = "Bypass permissions is off. You can allow it in Settings > Chats.";
export const LINE_BYPASS_NEW = "Start a new chat to use Bypass permissions.";

/** The record an answered card leaves in the transcript. */
export type CardRecord = Extract<Item, { kind: "card" }>;

/**
 * What a chat knows about the requests of its cards: the waiting ones, the answered records in the transcript, and
 * `lostRequests`, the ids the server knows ended unanswered with their Claude Code process. The list is read only if
 * the chat data carries it.
 */
export type CardLinkChat = Pick<Chat, "items" | "pending"> & { lostRequests?: readonly string[] };

/**
 * The 5.4 line for a card path (`kind` is the path's card kind) whose request does not wait on that path, with the
 * answered record the chat then scrolls to. Null when the card waits on its own path.
 * - A waiting card or a record of another kind (/question/ on a permission request): the link could not be read.
 * - A record of the path's kind: already answered.
 * - An id the chat knows was lost with its Claude Code process: lost; send a message to continue.
 * - Any other id: not waiting in this chat, with no cause.
 */
export function cardLinkLine(chat: CardLinkChat, kind: string, requestId: string): { line: string; record?: CardRecord } | null {
  const waiting = chat.pending.find((k) => k.id === requestId);
  if (waiting?.kind === kind) return null;
  const record = chat.items.find((i): i is CardRecord => i.kind === "card" && i.card.id === requestId);
  if (record) return record.card.kind === kind ? { line: LINE_ANSWERED, record } : { line: LINE_UNREAD };
  if (waiting) return { line: LINE_UNREAD };
  return { line: chat.lostRequests?.includes(requestId) ? LINE_LOST : LINE_NOT_WAITING };
}

const has = (route: Route, key: string) => typeof route.query[key] === "string" && route.query[key] !== "";
const WITH_TEXT = "the composer comes back with your link's text";

/** The `/` menu rows a slash link is checked against: the chat's own list (commandRowsOf), the catalog's by default. */
type SlashRows = readonly { name: string; terminalOnly?: boolean }[];

/** What a composer link opens once the waiting card is answered (the Composer fills from the same route). */
function afterAnswer(route: Route, commands: SlashRows): string {
  switch (route.name) {
    case "send":
      return has(route, "text") ? WITH_TEXT : "the composer comes back";
    case "bash":
      return has(route, "cmd") ? WITH_TEXT : "the composer comes back in Bash mode";
    case "slash": {
      // The arguments fill in only after a command the / menu can send (a terminal-only one opens its row, empty).
      const cmd = commands.find((c) => c.name === route.params.command);
      return has(route, "args") && cmd && !cmd.terminalOnly ? WITH_TEXT : "the / menu opens";
    }
    case "slashMenu":
      return "the / menu opens";
    case "add":
      return "the + menu opens";
    case "mention":
      return "the @ picker opens";
    case "model":
    case "effort":
      return "the model picker opens";
    case "mode":
      return "the permission mode picker opens";
    default:
      return "the composer comes back";
  }
}

/**
 * Above the card, on a composer link (send, bash, the / menu, +, the pickers) that opens while a card waits: it
 * promises the link's text only when the link carries some that the router kept (text, cmd or args), else the menu,
 * the picker or the composer that comes back.
 */
export function answerFirstLine(route: Route, commands: SlashRows = COMMANDS): string {
  return `Answer this request first. Then ${afterAnswer(route, commands)}.`;
}
