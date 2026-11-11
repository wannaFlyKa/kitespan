// `/search` (DESIGN.md 5.2, 5.3, 9.3): search with no chat open, the chats by title only. A page in the main column
// with the sidebar on a laptop, full width on a tablet (the chat list drawer's Search opens it), and its own screen on
// the phone, whose title bar holds Back to the screen before and the name "Search" (TopBar). A pick opens the chat.
import type { Route } from "../router";
import { Shell } from "../layout/Shell";
import { SearchPane } from "./SearchPane";

export function SearchPage({ route }: { route: Route }) {
  return (
    <Shell route={route}>
      <div className="srch-page" data-testid="search-page">
        <SearchPane route={route} chat={null} place="screen" />
      </div>
    </Shell>
  );
}
