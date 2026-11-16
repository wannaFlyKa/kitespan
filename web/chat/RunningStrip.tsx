// The chat's running work in a fixed place (chat/running.ts): one line at the foot of the conversation, above the
// message box (or the card in its place), wherever the side panel's Running card is not on screen (layout/Shell.tsx
// useCardsShown). It names the one thing that runs, with a workflow's count, and links to its view; for several it
// counts them and opens Details, whose first card lists them, by the opener rules (layout/split.ts openHref). Nothing
// while nothing runs, and a thing that ended leaves at once. The line under it is for screen readers, in the card's
// layouts too: a change in what runs is read out once (role=status), never a workflow's count.
import { useMemo } from "react";
import { href, type Route } from "../router";
import type { Chat } from "../state/types";
import { useCardsShown } from "../layout/Shell";
import { openHref, useSplitLive } from "../layout/split";
import { viewOf } from "../panels/format";
import { IconRight } from "../ui/icons";
import { Link } from "../ui/primitives";
import { RUNNING, runningOf, runningSaid, stripCount } from "./running";

export function RunningStrip({ chat, route }: { chat: Chat; route: Route }) {
  const cards = useCardsShown();
  const live = useSplitLive();
  const view = viewOf(route);
  const rows = useMemo(() => runningOf(chat, view), [chat, view]);
  const one = rows.length === 1 ? rows[0]! : null;
  const count = stripCount(rows);
  return (
    <>
      {rows.length && !cards ? (
        <div className="chat-gone chat-running">
          <div className="chat-measure">
            <section aria-label={RUNNING} data-testid="running-strip">
              <Link to={one ? one.to : openHref(route, href("details", { chat: chat.id }, { view }), live)} className="chat-running-link" data-testid="running-strip-link">
                <span className={`dot ${rows.some((r) => r.tone) ? "waiting" : "running"}`} aria-hidden="true" />
                <span className="chat-running-words">{runningSaid(rows)}</span>
                {count ? <span className="chat-running-count">{count}</span> : null}
                <IconRight size={14} />
              </Link>
            </section>
          </div>
        </div>
      ) : null}
      <p className="visually-hidden" role="status" data-testid="running-said">
        {runningSaid(rows)}
      </p>
    </>
  );
}
