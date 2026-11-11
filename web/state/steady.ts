// S1 (FIX-S1): while only a streamed block's text grows (a block_delta appends to a reply or to thinking), the screen
// around the conversation (the title bar, the sidebar's list, the composer, the side panel, the dialogs) keeps the chat
// object it drew, so it does not draw again for each streamed piece. Nothing there reads a reply's or a thinking
// block's text; the conversation (ChatView) reads the store's own chat. Any other change gives the new chat.
import type { Chat, Item } from "./types";

/** The text that streams into a row of this kind, if any. */
const TEXT: Partial<Record<Item["kind"], string>> = { assistant: "markdown", thinking: "text" };

/** The two rows are one row whose streamed text may differ, every other field the same. */
function sameButText(a: Item, b: Item): boolean {
  if (a === b) return true;
  const text = TEXT[b.kind];
  if (!text || a.kind !== b.kind || a.id !== b.id) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of kb) if (k !== text && (a as unknown as Record<string, unknown>)[k] !== (b as unknown as Record<string, unknown>)[k]) return false;
  return true;
}

/** `next` is `prev` with at most the streamed text of some rows changed: the same rows, in the same order. */
export function textOnly(prev: readonly Item[], next: readonly Item[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) if (!sameButText(prev[i]!, next[i]!)) return false;
  return true;
}

/** Every field of the chat but its rows is the same object, and its rows differ at most in streamed text. */
function steadyAgainst(prev: Chat, next: Chat): boolean {
  if (prev === next) return true;
  const kp = Object.keys(prev);
  const kn = Object.keys(next);
  if (kp.length !== kn.length) return false;
  for (const k of kn) if (k !== "items" && (prev as unknown as Record<string, unknown>)[k] !== (next as unknown as Record<string, unknown>)[k]) return false;
  return textOnly(prev.items, next.items);
}

/** Per chat id, the chat the screen drew last. */
const kept = new Map<string, Chat>();

/** The chat as the screen around the conversation reads it: the one it drew, while only streamed text changed since. */
export function steadyChat<C extends Chat | undefined>(chat: C): C {
  if (!chat) return chat;
  const was = kept.get(chat.id);
  if (was && steadyAgainst(was, chat)) return was as C;
  kept.set(chat.id, chat);
  return chat;
}

let listIn: readonly Chat[] | null = null;
let listOut: Chat[] = [];

/** The chat list as the screen reads it (the store's `chats`): the same array while only streamed text changed in it. */
export function steadyChats(chats: readonly Chat[]): Chat[] {
  if (chats === listIn) return listOut;
  const out = chats.map(steadyChat);
  listIn = chats;
  if (out.length !== listOut.length || out.some((c, i) => c !== listOut[i])) listOut = out;
  // A chat that left the list is not kept.
  if (kept.size > chats.length) {
    const ids = new Set(chats.map((c) => c.id));
    for (const id of kept.keys()) if (!ids.has(id)) kept.delete(id);
  }
  return listOut;
}
