// /c/<chat>/files/<relative path> (D37; v0.1 core): the download page of a file in the chat's folder
// (panels/file.tsx), through the server's download route (its existence probe first). As DESIGN.md 5.3 says, a laptop shows it in
// the side panel's place beside the chat and a medium touch device in the docked pane, so there this screen is the
// chat; the phone shows it as its own screen, whose title bar has Back to the chat. While the shell does not open its
// pane on this path (Shell's SIDE_ROUTES), a narrow laptop and a tablet show it as a page too, with a Back row to the
// chat.
import { href, type Route } from "../router";
import { useStore } from "../state/store";
import { Shell, useShellLayout } from "../layout/Shell";
import { ChatScreen } from "../chat/ChatScreen";
import { LinkNotice } from "../ui/LinkNotice";
import { BackRow } from "../panels/details";
import { FileView } from "../panels/file";
import { Home } from "./Home";
import { useBesideChat } from "./Uploads";

export function FileDownload({ route }: { route: Route }) {
  const chat = useStore((s) => s.chats.find((c) => c.id === route.params.chat));
  const layout = useShellLayout();
  const beside = useBesideChat(route);
  // DESIGN.md 5.4: a chat id that is not in the list shows Home with one plain line.
  if (!chat) return <Home route={route} notice="That chat is not here. It may have been deleted." />;
  if (beside) return <ChatScreen route={route} />;
  const view = typeof route.query.view === "string" ? route.query.view : undefined;
  return (
    <Shell route={route} chat={chat}>
      <div className="side-page" data-testid="file-page">
        <div className="side-page-inner">
          <LinkNotice route={route} />
          {layout.size === "phone" ? null : <BackRow label="Chat" to={href("chat", { chat: chat.id }, { view })} aria={`Back to ${chat.title}`} />}
          <FileView chat={chat} route={route} place="page" />
        </div>
      </div>
    </Shell>
  );
}
