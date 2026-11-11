// One chat: the conversation, the composer, the side cards and the chat's dialogs. Each child reads the route, so a
// deep link opens exactly its state: a message, a block, a card, a picker, a pre-filled composer or a dialog.
// Files dragged over the chat show the drop overlay (D37, plan v2 "Drop target"), and a drop anywhere on the chat
// screen, the composer too, uploads them with act.upload; the composer handles paste and the + menu's file input.
// While a card waits, the composer is hidden: a drop still uploads, the overlay says that the files wait for the
// message box, and one line where the composer comes back says how many files the next message holds. A Take back
// that waits for a command in the message box (act.takeBack) shows its line above the composer, as does a side answer's
// Bring back that the box refused for its command (R130, act.bringBack), and so does the
// store's notice (a request the server refused, a line the server sent for this chat): one line that goes away. While
// a send, a `!` command or a Send again of this page waits for the socket (or for an ack that is overdue on a silent
// link), that line is "Reconnecting...", where the chat list's foot, which says the same (M4), is not on screen; it
// goes when the socket is back. While kitespan restarts (from the server's notice of its close or its `bye`, or this
// page's own Restart now, to the new `welcome`) it is "Restarting kitespan..." there, whatever waits. While a restart
// waits for the running turns, the line is the drain's, with Cancel restart and Restart now (settings/DrainLine.tsx),
// where the list's foot is not on screen either. Else, where no docked sidebar shows the list's foot, the update's
// line (row 108: the step line while an update runs, Restart to apply, or Update available with Update), which no timer
// takes away; a refused request's line goes first while it shows.
import { useEffect } from "react";
import type { Route } from "../router";
import { EMPTY_DRAFT, NO_UPLOADS, act, draftOf, isCommandDraft, restartingNow, takeBackWaitLine, uploadRoot, uploadRootLabel, useStore } from "../state/store";
import { steadyChat } from "../state/steady";
import { DropOverlay, useFileDrop } from "../ui/files";
import { Shell } from "../layout/Shell";
import { ChatView } from "./ChatView";
import { Composer } from "../composer/Composer";
import { SidePanel } from "../panels/SidePanel";
import { ChatDialogs } from "../dialogs/ChatDialogs";
import { Home } from "../screens/Home";
import { RECONNECTING, RESTARTING } from "../screens/common";
import { DrainLine } from "../settings/DrainLine";
import { UpdateLine } from "../update/UpdateLine";
import { isOriginNotice } from "../update/state";
import { useShellLayout } from "../layout/size";
import { NoticeEnvLink } from "../env/UnreadableLine";
import { BRING_COMMAND_LINE } from "../side/bring";
import { ChatLinks } from "../browser/links";

/** The overlay's second line while a card waits. */
export const DROP_WAIT_NOTE = "The files wait for your next message. Answer the request first.";
/** The line where the composer comes back, while a card waits and the draft holds uploads. */
export function filesWaitLine(n: number): string {
  return `${n === 1 ? "1 file is" : `${n} files are`} attached to your next message. Answer the request, then write it.`;
}

/** How long the store's notice line stays above the composer. */
export const NOTICE_MS = 8_000;
/** The Rename form and the chat's dialogs that show a refused press's line themselves (dialogs/ackClose.ts). */
const OWN_LINE_ROUTES: ReadonlySet<string> = new Set(["rename", "archive", "stop"]);

/**
 * `gone` (R131): one 5.4 line above the conversation for a link to something that this chat does not show (a
 * background session's view route that gave way to the chat).
 */
export function ChatScreen({ route, gone = null }: { route: Route; gone?: string | null }) {
  // S1: the chat this screen drew, while only a reply's text grows (state/steady.ts); the conversation reads its own.
  const chat = useStore((s) => steadyChat(s.chats.find((c) => c.id === route.params.chat)));
  const uploadFolder = useStore((s) => s.settings.uploadFolder);
  const customFolder = useStore((s) => s.settings.customFolder);
  const chatId = chat?.id;
  const uploads = useStore((s) => (chatId ? s.uploads[chatId] ?? NO_UPLOADS : NO_UPLOADS));
  // The box's draft by its own fields (D49): a message that starts with "!" is not a command.
  const draft = useStore((s) => (chatId ? draftOf(s, chatId) : EMPTY_DRAFT));
  // D50: the message box's file chips are upload ids, never references in its text.
  const chips = draft.uploads.length ? draft.uploads : undefined;
  const wait = useStore((s) => (s.takeBackWait && s.takeBackWait.chatId === chatId ? s.takeBackWait.messageId : null));
  const bringWait = useStore((s) => !!chatId && s.bringBackWait?.chatId === chatId);
  const notice = useStore((s) => s.notice);
  const noticeFor = useStore((s) => s.noticeFor);
  const offline = useStore((s) => {
    const out = s.outgoing[route.params.chat ?? ""] ?? [];
    return out.length > 0 && (s.net !== "open" || out.some((id) => s.overdue.includes(id)));
  });
  const restarting = useStore(restartingNow);
  const drainText = useStore((s) => s.restartWait?.text ?? null);
  const updateText = useStore((s) => s.updateNotice?.text ?? null);
  const docked = useShellLayout().sidebar === "docked";
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => act.setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);
  // Row 80: while another app holds the chat's session the zone is off: a drop uploads nothing (the window refuses it).
  const drop = useFileDrop((files) => {
    if (chatId) act.upload(chatId, files);
  }, !!chatId && !chat?.held);
  // DESIGN.md 5.4: a chat id that is not in the list shows Home with one plain line.
  if (!chat) return <Home route={route} notice="That chat is not here. It may have been deleted." />;
  const folder = uploadRootLabel(uploadRoot({ uploadFolder, customFolder }, chat.sessionId));
  const waiting = chat.pending.length > 0;
  const held = waiting && chips ? chips.filter((id) => uploads.some((u) => u.id === id && u.state === "done")).length : 0;
  // The line goes when the box no longer holds a command or the message is no longer queued (Claude started on it).
  const waitLine = wait && isCommandDraft(draft) && chat.items.some((i) => i.id === wait && i.kind === "user" && i.queued) ? takeBackWaitLine(waiting) : null;
  // R130: the same place for Bring back's, while the box still holds the command.
  const bringLine = !waitLine && bringWait && isCommandDraft(draft) ? BRING_COMMAND_LINE : null;
  return (
    <Shell route={route} chat={chat} side={(mode, r = route, reads = true) => <SidePanel chat={chat} route={r} mode={mode} reads={reads} />}>
      <div
        className="chat-screen"
        data-testid="chat"
        data-chat={chat.id}
        data-drop={drop.over ? "over" : undefined}
        onDragEnterCapture={drop.handlers.onDragEnter}
        onDragOverCapture={drop.handlers.onDragOver}
        onDragLeaveCapture={drop.handlers.onDragLeave}
        onDropCapture={drop.handlers.onDrop}
      >
        <ChatView chat={chat} route={route} gone={gone} />
        {/* Iteration 7 (DESIGN-B1 4.15, PA-14): where the links in Claude's text open, and the first-click question. */}
        <ChatLinks chat={chat.id} route={route} />
        {held ? (
          <div className="chat-gone chat-files-wait">
            <div className="chat-measure">
              <p className="notice" data-testid="files-wait" role="status">
                {filesWaitLine(held)}
              </p>
            </div>
          </div>
        ) : null}
        {waitLine ? (
          <div className="chat-gone chat-take-back-wait">
            <div className="chat-measure">
              <p className="notice" data-testid="take-back-wait" role="status">
                {waitLine}
              </p>
            </div>
          </div>
        ) : bringLine ? (
          <div className="chat-gone chat-take-back-wait">
            <div className="chat-measure">
              <p className="notice" data-testid="bring-back-wait" role="status">
                {bringLine}
              </p>
            </div>
          </div>
        ) : (offline || restarting) && !docked ? (
          <div className="chat-gone chat-notice-line">
            <div className="chat-measure">
              <p className="notice" data-testid="chat-reconnecting" role="status">
                {restarting ? RESTARTING : RECONNECTING}
              </p>
            </div>
          </div>
        ) : drainText !== null && !docked ? (
          <div className="chat-gone chat-notice-line">
            <div className="chat-measure">
              <DrainLine />
            </div>
          </div>
        ) : notice && !OWN_LINE_ROUTES.has(route.name) && notice !== drainText ? (
          <div className="chat-gone chat-notice-line">
            <div className="chat-measure">
              <p className="notice" data-testid="chat-notice" role="status">
                {notice}
              </p>
              <NoticeEnvLink notice={noticeFor} />
            </div>
          </div>
        ) : updateText && !docked && !isOriginNotice(updateText) ? (
          <div className="chat-gone chat-notice-line">
            <div className="chat-measure">
              <UpdateLine />
            </div>
          </div>
        ) : null}
        <Composer chat={chat} route={route} />
        {drop.over ? <DropOverlay folder={folder} note={waiting ? DROP_WAIT_NOTE : undefined} /> : null}
      </div>
      <ChatDialogs chat={chat} route={route} />
    </Shell>
  );
}
