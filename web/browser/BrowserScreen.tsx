// /browser and /browser/<tab> (DESIGN-B1 4.1; PAGE 2.2): the Browser on its own, with no chat. On a laptop with the
// sidebar docked it is the main column beside the sidebar at full size, its head on the title bar's row: Back "Chat"
// (only when this page opened it from a chat) and the tab strip. Elsewhere the title bar stays (the chats button, or
// on the phone Back to the screen before it and "Browser").
import { docReach, parsePath, type EntryState, type Route } from "../router";
import { PANE_ROUTES } from "../routes";
import { Shell } from "../layout/Shell";
import { useShellLayout } from "../layout/size";
import { useStore } from "../state/store";
import { IconBack } from "../ui/icons";
import { Link } from "../ui/primitives";
import { LinkNotice } from "../ui/LinkNotice";
import { BrowserPane } from "./BrowserPane";

/** The chat this page opened /browser from: the entry behind it, when this document pushed it and it is a chat's view. */
function useFromChat(): { to: string; title: string } | null {
  const st = typeof history !== "undefined" ? (history.state as EntryState | null) : null;
  const from = st && docReach(st) > 0 && typeof st.from === "string" && st.from.startsWith("/") && !st.from.startsWith("//") ? st.from : null;
  const r = from ? parsePath(from) : null;
  const id = r && !r.fallbackFrom && (r.name === "chat" || PANE_ROUTES.has(r.name)) ? r.params.chat : undefined;
  const title = useStore((s) => (id ? s.chats.find((c) => c.id === id)?.title : undefined));
  return from && title !== undefined ? { to: from, title } : null;
}

export function BrowserScreen({ route }: { route: Route }) {
  const layout = useShellLayout();
  const back = useFromChat();
  const full = layout.size === "laptop" && layout.sidebar === "docked";
  const lead = full && back ? (
    <Link to={back.to} close className="scr-bar-back bp-back-chat" aria-label={`Back to ${back.title}`}>
      <IconBack size={18} />
      <span>Chat</span>
    </Link>
  ) : null;
  return (
    <Shell route={route} bare={full}>
      <div className="bp-screen" data-testid="browser-screen">
        <LinkNotice route={route} />
        <BrowserPane route={route} mode={layout.size === "phone" ? "page" : "full"} lead={lead} />
      </div>
    </Shell>
  );
}
