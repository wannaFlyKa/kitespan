// The routes of later milestones (DESIGN.md 5.2, section 9): browser and browserTab. Each opens one calm screen with
// its name, the one line "Not in this version." and a way back (MINIMALISM M16: no milestone label, no description of
// a control that is not built). The files and uploads routes ship in v0.1 core (D37), and search, chatSearch and
// mention in v0.3 search; each has its own screen.
import { href, type Route } from "../router";
import { Shell } from "../layout/Shell";
import { useStore } from "../state/store";
import { Link } from "../ui/primitives";
import { LinkNotice } from "../ui/LinkNotice";
import { Home } from "./Home";

const TITLE: Record<string, string> = {
  browser: "A browser you share with Claude",
  browserTab: "One browser tab",
};

export function Later({ route }: { route: Route }) {
  const chatId = route.params.chat;
  const chat = useStore((s) => (chatId ? s.chats.find((c) => c.id === chatId) : undefined));
  // DESIGN.md 5.4: a chat id that is not in the list shows Home with one plain line.
  if (chatId && !chat) return <Home route={route} notice="That chat is not here. It may have been deleted." />;

  const title = TITLE[route.name] ?? "Not built yet";
  const back = chat ? href("chat", { chat: chat.id }) : "/";

  return (
    <Shell route={route} chat={chat}>
      <div className="later" data-testid={`later-${route.name}`}>
        <div className="later-inner">
          <LinkNotice route={route} />
          <h1 className="later-title">{title}</h1>
          <p className="later-when">Not in this version.</p>
          <Link to={back} className="btn">
            {chat ? "Back to the chat" : "Go to Home"}
          </Link>
        </div>
      </div>
    </Shell>
  );
}
