// Which chats' stored drafts are text from a link (DESIGN.md 5.1 rule 7 and 7.5). The store keeps each draft as one
// string, and "!git status" reads back as Bash mode. Text from a link keeps the mode the link gave it until it is sent
// or cleared, also after a reload, so link text that starts with "!" stays a message and never becomes a command. The
// composer keeps that mode per chat in local storage, beside the store's drafts.
//
// A mark holds the text it was made for (a short key of it), and it counts only while the chat's draft is that text:
// it is this page's own unsent edit, never a draft that another device or tab wrote since (D49), so a Bash link that
// this device edited never turns another device's text link into a command.
//
// A mark's mode changes only when a chat's draft starts or stops being link text, and then the store's pending draft
// is written at once too (flushDrafts), so the server gets the link mode at once; between changes, the store's own
// 250 ms write keeps the text, and the mark follows the text.
import { flushDrafts, getState } from "../state/store";
import type { Mode } from "./draft";

// Not under the store's draft prefix: its start-up sweep removes every key there that is not a draft record.
const KEY = "kitespan.proto.composer.links";
const MODES = new Set<string>(["chat", "slash", "bash"]);
/** The most marks kept: one per chat with unsent link text, so a mark whose chat went elsewhere goes in time. */
const MAX_MARKS = 100;

interface Mark {
  mode: Mode;
  /** textKey of the draft the mark was made for. */
  key: string;
}

/** A short key of a draft's text (its length and an FNV-1a hash): enough to tell this text from another one. */
export function textKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${text.length.toString(36)}.${(h >>> 0).toString(36)}`;
}

function read(): Record<string, Mark> {
  try {
    const raw = localStorage.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object") return {};
    const out: Record<string, Mark> = {};
    for (const [id, m] of Object.entries(v as Record<string, unknown>)) {
      const { mode, key } = (m ?? {}) as Partial<Mark>;
      // A mark without its text's key (or a bad value) cannot say which text it is for: it is left out.
      if (typeof mode === "string" && MODES.has(mode) && typeof key === "string") out[id] = { mode, key };
    }
    return out;
  } catch {
    return {}; // no storage, blocked storage or a bad value: no marks
  }
}

function write(v: Record<string, Mark>) {
  try {
    if (Object.keys(v).length) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {} // full or blocked storage: the marks stay in memory
}

let marks: Record<string, Mark> | null = null;
const current = () => (marks ??= read());

/**
 * The mode a link gave the chat's draft, or undefined when the draft is typed text, there is none, or the mark was
 * made for other text. `text` is the store's string for the draft (the store's current one by default: the store reads
 * the mark when it sends this page's own edit).
 */
export function linkMode(chatId: string, text: string = getState().drafts[chatId] ?? ""): Mode | undefined {
  const m = current()[chatId];
  return m && text !== "" && m.key === textKey(text) ? m.mode : undefined;
}

/** Call right after act.setDraft: `mode` when the chat's new draft `text` is text from a link, else null. */
export function markLink(chatId: string, mode: Mode | null, text: string) {
  const { [chatId]: was, ...next } = current();
  const mark: Mark | null = mode && text !== "" ? { mode, key: textKey(text) } : null;
  if (was?.mode === mark?.mode && was?.key === mark?.key) return;
  if (mark) {
    next[chatId] = mark; // at the end: the oldest marks go first
    const ids = Object.keys(next);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_MARKS))) delete next[id];
  }
  marks = next;
  if (was?.mode !== mark?.mode) flushDrafts();
  write(next);
}

/** Tests only: forget the marks in memory, so the next read comes from storage. */
export function resetLinkMarks() {
  marks = null;
}
