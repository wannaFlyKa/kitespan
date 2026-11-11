// /c/<chat>/uploads (D37; v0.1 core): the chat's uploads, each with Download, Copy path and
// Remove. A laptop shows them in the side panel's place beside the chat, a medium touch device in the docked pane,
// and the phone as their own screen (DESIGN.md 5.3). The list itself is panels/uploads.tsx. While the shell does not
// open its pane on this path (Shell's SIDE_ROUTES), a narrow laptop and a tablet show the list as a page too.
import { href, type Route } from "../router";
import { useStore } from "../state/store";
import { Shell, SIDE_ROUTES, useShellLayout } from "../layout/Shell";
import { ChatScreen } from "../chat/ChatScreen";
import { LinkNotice } from "../ui/LinkNotice";
import { BackRow } from "../panels/details";
import { UploadsView } from "../panels/uploads";
import { Home } from "./Home";

/**
 * The chat's uploads and a file's download page (FileDownload.tsx) beside the chat: on a laptop and a tablet the
 * screen at these paths is the chat itself, with the list in the side panel's place or the docked pane. App renders
 * ChatScreen for them directly, so opening or closing Files keeps the chat and its composer mounted (a remount would
 * drop the focused field, the on-screen keyboard and the composer's open menu).
 */
export function useBesideChat(route: Route): boolean {
  const railHidden = useStore((s) => s.view.railHidden);
  const layout = useShellLayout();
  if (route.name !== "uploads" && route.name !== "files") return false;
  return layout.size !== "phone" && (SIDE_ROUTES.has(route.name) || (layout.side === "column" && !railHidden));
}

export function Uploads({ route }: { route: Route }) {
  const chat = useStore((s) => s.chats.find((c) => c.id === route.params.chat));
  const layout = useShellLayout();
  const beside = useBesideChat(route);
  // DESIGN.md 5.4: a chat id that is not in the list shows Home with one plain line.
  if (!chat) return <Home route={route} notice="That chat is not here. It may have been deleted." />;
  if (beside) return <ChatScreen route={route} />;
  const view = typeof route.query.view === "string" ? route.query.view : undefined;
  return (
    <Shell route={route} chat={chat}>
      <div className="side-page" data-testid="uploads-page">
        <div className="side-page-inner">
          <LinkNotice route={route} />
          {layout.size === "phone" ? null : <BackRow label="Chat" to={href("chat", { chat: chat.id }, { view })} aria={`Back to ${chat.title}`} />}
          {/* The phone's title bar already names the screen (Back to the chat, then "Uploads"), so the page's heading
              is for screen readers only there; one title on screen, as an iOS bar title without a large title. */}
          <h1 className={layout.size === "phone" ? "visually-hidden" : "side-page-title"}>Uploads</h1>
          <UploadsView chat={chat} route={route} place="page" />
        </div>
      </div>
    </Shell>
  );
}
