// /chats (DESIGN.md 5.3): the chat list screen on a phone, a drawer over the last chat on a medium touch device, and
// on a laptop the sidebar takes the focus while the main column shows Home (under 1,000 px Shell draws the sidebar as
// a drawer over it, 6.1). ?filter= is live state (replaceState).
import { useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { closeTo, href, parse, type Route } from "../router";
import { useStore } from "../state/store";
import { useViewport } from "../layout/size";
import { Shell } from "../layout/Shell";
import { Scrim, useLayer } from "../ui/primitives";
import { LinkNotice } from "../ui/LinkNotice";
import { ChatScreen } from "../chat/ChatScreen";
import { ChatListBody } from "./ChatListBody";
import { Home, HomeBody } from "./Home";
import { useScreenNotice } from "./common";

export function ChatList({ route }: { route: Route }) {
  const vp = useViewport();
  if (vp.size === "laptop")
    return (
      <Shell route={route}>
        <HomeBody route={route} autoFocus={false} />
      </Shell>
    );
  if (vp.size === "phone") return <PhoneChats route={route} />;
  return <ChatDrawer route={route} />;
}

/** The phone's /chats screen. A row's Archive that the server refused says why at the top, as no chat is open. */
function PhoneChats({ route }: { route: Route }) {
  const refused = useScreenNotice();
  return (
    <Shell route={route}>
      <div className="scr-page scr-chats">
        {refused ? (
          <p className="notice fallback-line" role="status" data-testid="screen-notice">
            {refused}
          </p>
        ) : (
          <LinkNotice route={route} />
        )}
        <ChatListBody route={route} variant="screen" />
      </div>
    </Shell>
  );
}

/** The entry this drawer was opened from, when it was a chat or another app page (not the list itself). */
function openedFrom(): string | null {
  const from = (history.state as { from?: string } | null)?.from;
  return from && !/^\/chats(\?|$)/.test(from) ? from : null;
}

/** Medium touch: the list in a drawer over the chat it was opened from. A modal layer: Esc or the scrim closes it. */
function ChatDrawer({ route }: { route: Route }) {
  const from = openedFrom();
  const parent = from ?? "/";
  const chatId = useMemo(() => parse(new URL(parent, location.origin)).params.chat, [parent]);
  const chatHere = useStore((s) => (chatId ? s.chats.some((c) => c.id === chatId) : false));
  const panel = useRef<HTMLElement>(null);
  const close = () => closeTo(parent);
  useLayer({ active: true, box: panel, onClose: close, modal: true });

  // Behind the drawer: the chat it was opened over (at its plain path), else Home.
  const behind = useMemo(() => parse(new URL(chatId && chatHere ? href("chat", { chat: chatId }) : "/", location.origin)), [chatId, chatHere]);
  const background = behind.name === "chat" ? <ChatScreen route={behind} /> : <Home route={behind} />;
  return (
    <>
      {background}
      {createPortal(
        <>
          <Scrim onClick={close} />
          <aside ref={panel} className="scr-drawer" role="dialog" aria-modal="true" aria-label="Chats" tabIndex={-1}>
            <LinkNotice route={route} />
            <ChatListBody route={route} variant="drawer" focusOnOpen />
          </aside>
        </>,
        document.body,
      )}
    </>
  );
}
