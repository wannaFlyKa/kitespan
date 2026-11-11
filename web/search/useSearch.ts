// The hooks of search on the page (DESIGN.md 9.3; BUILD-CHECKLIST C3): the chat folder's files for a field's query,
// for the search pane and the `@` picker alike, and the search pane's groups.
//
// useFileEngine(chat) asks for the chat's list when the surface opens (web/search/corpus.ts), kept under the chat's
// folder so the chats of one project share it, and makes this surface's own engine from it (web/search/engine.ts): a
// new list (a new `v`) is a new engine, and the old one is closed. useProjectFileEngine(project) does the same for a
// project's folder before any chat exists (the new-chat form's `@` picker, D59), under the same key. useFileRows(engine, q, ask) is the engine's answer
// for `q`: the page's copy answers at once, the server's route with its answer for `q` or its newest. The caller
// passes the deferred query as `q` (useDeferredValue), so the field's echo never waits for the rows (L14), and the
// field's own value as `ask`, so the server's request leaves with the key's echo, not after the deferred render.
// U5: useMessages(typed, on) is the pane's ask for the Messages group (web/search/messages.ts), one per pane, which
// usePaneData adds as the last group.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { readViewport } from "../layout/size";
import { NO_UPLOADS, act, chatFolderIn, useStore, visibleChats } from "../state/store";
import type { Chat } from "../state/types";
import { menuRowsOf } from "../composer/draft";
import { corpusKey, corpusOf, openCorpus, openProjectCorpus, projectCorpusKey, subscribeCorpus, type CorpusSnapshot, type CorpusState } from "./corpus";
import { createFileEngine, type FileEngine, type FileRows } from "./engine";
import { kindsOf, searchSections, type SearchResult, type SearchScope } from "./sections";
import { askMaker, asksMessages, messagesView, type MessageAsk, type MessagesView } from "./messages";

const noSubscribe = () => () => {};
const nothing = () => null;

/**
 * This surface's engine over the chat's files (null with no chat, or before the first answer), the list's state, and
 * whether the folder has a file at all (the scope control's Files).
 */
export function useFileEngine(chat: string | null): { engine: FileEngine | null; state: CorpusState; any: boolean } {
  // The chat's folder (its worktree's, row 73, else its project's), as the page knows it: the key of the list.
  const folder = useStore((s) => chatFolderIn(s, chat ? s.chats.find((x) => x.id === chat) : undefined) ?? null);
  const key = chat ? corpusKey(chat, folder) : null;
  const snap = useSyncExternalStore(subscribeCorpus, () => corpusOf(key), () => corpusOf(key));
  useEffect(() => {
    if (chat && key) void openCorpus(chat, readViewport().touch, {}, key);
  }, [chat, key]);
  return useEngineOf(snap, chat !== null);
}

/**
 * The same over a project's folder, before any chat exists (the new-chat form's `@` picker, D59): the project corpus
 * routes, kept under the project's folder, so the form and the project's chats share one list.
 */
export function useProjectFileEngine(project: string | null): { engine: FileEngine | null; state: CorpusState; any: boolean } {
  const folder = useStore((s) => (project ? (s.projects.find((p) => p.id === project)?.folder ?? null) : null));
  const key = project ? projectCorpusKey(project, folder) : null;
  const snap = useSyncExternalStore(subscribeCorpus, () => corpusOf(key), () => corpusOf(key));
  useEffect(() => {
    if (project && key) void openProjectCorpus(project, readViewport().touch, {}, key);
  }, [project, key]);
  return useEngineOf(snap, project !== null);
}

/** This surface's own engine over a list's source; a new source is a new engine, and the old one is closed. */
function useEngineOf(snap: CorpusSnapshot, on: boolean): { engine: FileEngine | null; state: CorpusState; any: boolean } {
  const engine = useMemo(() => (snap.source ? createFileEngine(snap.source) : null), [snap.source]);
  useEffect(() => () => engine?.close(), [engine]);
  const any = !!snap.source && (snap.source.at === "server" || snap.source.corpus.size > 0);
  return { engine, state: on ? snap.state : "none", any };
}

/**
 * The engine's rows for `q`, the deferred query (null before the list is ready, or before the server's first answer).
 * The server is asked for `ask`, the field's own value, as soon as it changes.
 */
export function useFileRows(engine: FileEngine | null, q: string, ask: string = q): FileRows | null {
  const rows = useSyncExternalStore(engine ? engine.subscribe : noSubscribe, engine ? () => engine.rows(q) : nothing, engine ? () => engine.rows(q) : nothing);
  useEffect(() => {
    engine?.ask(ask);
  }, [engine, ask]);
  return rows;
}

/**
 * U5: the pane's ask for the Messages group, for the field's own value `typed` (never the deferred one, so the pause
 * runs from the key itself), while `on` (the scope keeps Messages). One ask per pane: it warms the server's read when
 * the pane opens and goes with the pane.
 */
export function useMessages(typed: string, on: boolean): MessagesView {
  const ref = useRef<MessageAsk | null>(null);
  ref.current ??= askMaker.make();
  const ask = ref.current;
  useEffect(() => {
    ask.warm();
    return () => ask.close();
  }, [ask]);
  useEffect(() => {
    ask.set(typed, on);
  }, [ask, typed, on]);
  const snap = useSyncExternalStore(ask.subscribe, ask.snapshot, ask.snapshot);
  return messagesView(snap, typed, on);
}

export interface PaneData {
  result: SearchResult;
  /** The rows are what this query gives: the file list came (or failed, or there is none), so an empty list means no match. */
  settled: boolean;
  /** Which kinds this chat has rows of at all (the scope control). */
  has: { chats: boolean; files: boolean; commands: boolean };
  /** U5: the Messages group's state for the field's value (its rows are in `result`). */
  messages: MessagesView;
}

/**
 * The search pane's groups for the deferred query `q`; `typed` is the field's own value, which the server is asked
 * for at once. In a chat: its chats by title, the folder's files and its uploads, and its `/` commands (read once with
 * `get commands` when the chat has none yet, a read that never starts a sleeping chat). With no chat (the `/search`
 * page): the chats by title only. A scope with no files (Chats, Commands) scans no file and asks the server nothing.
 */
export function usePaneData(chat: Chat | null, q: string, scope: SearchScope | null, typed: string = q): PaneData {
  // The chat list changes on every streamed piece of any chat; the rows read only these fields, so the groups are
  // ranked again only when one of them changes (or the query does).
  const allChats = useStore((s) => s.chats);
  const chatKey = chatsKey(allChats);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const chats = useMemo(() => visibleChats(allChats), [chatKey]);
  // U5: the Messages rows name any chat the page holds, archived included (the key holds the fields they read).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const everyChat = useMemo(() => allChats, [chatKey]);
  const uploads = useStore((s) => (chat ? (s.uploads[chat.id] ?? NO_UPLOADS) : NO_UPLOADS));
  const chatId = chat?.id ?? null;
  const inChat = chat !== null;
  const commandsKnown = chat ? chat.commands !== null : true;
  useEffect(() => {
    if (chatId && !commandsKnown) void act.load(chatId, "commands");
  }, [chatId, commandsKnown]);
  // An archived chat runs nothing: its page offers no command.
  const list = chat?.commands ?? null;
  const archived = !!chat?.archived;
  const commands = useMemo(() => (!archived && list?.length ? menuRowsOf({ commands: list }) : null), [list, archived]);
  const { engine, state, any } = useFileEngine(chatId);
  const filesHere = inChat && kindsOf(scope).includes("files");
  const files = useFileRows(filesHere ? engine : null, q, typed);
  // The server answered the field's value before the deferred render caught up: the list still answers `q`.
  const filesAhead = !!files && files.q !== q && files.q === typed;
  // U5: the Messages group, asked for the field's own value; its rows are drawn for the deferred query once they match.
  const msgsOn = kindsOf(inChat ? scope : null).includes("messages");
  const msgs = useMessages(typed, msgsOn);
  const messagesAsked = msgsOn && asksMessages(q);
  const hits = msgs.hits;
  const answer = useMemo(() => (hits ? { q: typed, hits } : null), [hits, typed]);
  const result = useMemo(
    () => searchSections({ q, scope: inChat ? scope : null, chats, files: filesHere ? files : null, filesAhead, uploads, commands, messages: answer, allChats: everyChat, messagesAsked }),
    [q, scope, inChat, chats, files, filesHere, filesAhead, uploads, commands, answer, everyChat, messagesAsked],
  );
  const settled = !chat || state === "failed" || (state === "ready" && files !== null) || (scope !== null && scope !== "files");
  const has = { chats: chats.length > 0, files: any || uploads.some((u) => u.state === "done"), commands: !!commands?.length };
  return { result, settled, has, messages: msgs };
}

/** The fields of the chat list that the chat rows read, as one key. */
export function chatsKey(chats: readonly Chat[]): string {
  return chats.map((c) => `${c.id}\u0000${c.title}\u0000${c.state}\u0000${c.projectId}\u0000${c.updatedAt}\u0000${c.archived}`).join("\u0001");
}
