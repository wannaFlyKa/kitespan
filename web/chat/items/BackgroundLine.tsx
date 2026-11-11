// R131 (DESIGN-R131 5): the line under a launch row, in R127's note place (the row's head, above its open body; or
// the closed summary row, the folded turn's line, a closed subagent block's head that holds the row). It leads with
// the R116 dot (the slow warm pulse while the session needs you; Reduce motion stops it), names the session in --text
// and says its state in agent view's words, then one small button: Open (the view) or, for a session outside the
// project, Open in terminal. The state is the server's, the same on every device (D49), and a change is read out once
// (role=status); a session with no state yet, or one Claude Code no longer lists, has no line. The button is a link:
// nothing here acts. The line is the place that sees its session's end (FIX-R131 2: "its line or view"), a report and
// never an action:
// while at least half of it is in view and the route shows the chat's conversation, it says so in the chat's seen
// report with its session's id (net/onScreen.ts adds the page's visibility and the chat's drawn attach). The chat at its
// end does not stand for it: the line may be far up, or folded away.
import { useEffect, useRef, useState, type RefObject } from "react";
import { act, useStore } from "../../state/store";
import { Link } from "../../ui/primitives";
import type { Item } from "../../state/types";
import { BG_HEADING, OPEN, OPEN_IN_TERMINAL, bgHref, bgName, bgTerminalHref, dotOf, reasonOf, toneOf, BG_WORDS, type BgRow, type BgWorker } from "../background";
import { useBackgroundLines, useConversationShown, useTranscript } from "./context";

/** The share of a line that must be in view for its session's end to count as seen. */
export const LINE_SEEN_RATIO = 0.5;

/**
 * The line's own seen report: on while the route shows the conversation (`shown`) and at least half of the line is in
 * the viewport (its scroller clips it, so a line scrolled away is not in view); off once either goes, and gone when the
 * line unmounts. A page with no IntersectionObserver never says on.
 */
function useLineOnScreen(chatId: string, id: string, el: RefObject<HTMLElement | null>, shown: boolean): void {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = el.current;
    if (!node || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (e) setInView(e.isIntersecting && e.intersectionRatio >= LINE_SEEN_RATIO);
      },
      { threshold: [0, LINE_SEEN_RATIO, 1] },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [el]);
  const on = shown && inView;
  useEffect(() => {
    if (chatId) act.bgOnScreen(chatId, id, on);
  }, [chatId, id, on]);
  useEffect(
    () => () => {
      if (chatId) act.bgOnScreen(chatId, id, false, true);
    },
    [chatId, id],
  );
}

export function BackgroundLine({ row }: { row: BgRow }) {
  const ctx = useTranscript();
  const chatId = ctx?.chatId ?? "";
  const worker = useStore((s) => s.chats.find((c) => c.id === chatId)?.background?.[row.id]);
  if (!worker) return null;
  return <Line row={row} chatId={chatId} worker={worker} view={ctx && ctx.view !== "normal" ? ctx.view : undefined} />;
}

function Line({ row, chatId, worker, view }: { row: BgRow; chatId: string; worker: BgWorker; view: string | undefined }) {
  const el = useRef<HTMLParagraphElement>(null);
  useLineOnScreen(chatId, row.id, el, useConversationShown());
  const name = bgName(worker, row, row.id);
  const dot = dotOf(worker);
  const tone = toneOf(worker.state);
  const why = reasonOf(worker);
  // The dot keeps its place in every state (an empty one is transparent), so the names of a list of lines line up, and
  // it hangs: a second line of words starts under the name. The noun is for screen readers only (agent view's rows
  // carry none).
  return (
    <p ref={el} className="chat-row-note chat-bgline" data-state={worker.state} role="status" data-testid={`bg-line-${row.id}`}>
      <span className="chat-bgline-words">
        <span className={`dot${dot ? ` ${dot}` : ""}`} aria-hidden="true" />
        <span className="visually-hidden">{`${BG_HEADING} `}</span>
        <span className="chat-bgline-name" title={name}>
          {name}
        </span>
        <span className="visually-hidden">,</span> <span className={`chat-bgline-state${tone ? ` ${tone}` : ""}`}>{BG_WORDS[worker.state]}</span>
        {why ? <span className="chat-bgline-why">{`: ${why}`}</span> : null}
      </span>{" "}
      {worker.view ? (
        <Link to={bgHref(chatId, row.id, view)} className="btn chat-mini chat-bgline-btn" aria-label={`${OPEN} ${name}`} data-testid={`bg-open-${row.id}`}>
          {OPEN}
        </Link>
      ) : (
        <Link to={bgTerminalHref(chatId, row.id, view)} className="btn chat-mini chat-bgline-btn" aria-label={`${OPEN_IN_TERMINAL}, ${name}`} data-testid={`bg-terminal-${row.id}`}>
          {OPEN_IN_TERMINAL}
        </Link>
      )}
    </p>
  );
}

/** The lines that the launch rows among `items` (deep) carry here: none inside a folded turn's work or a read-only view. */
export function BackgroundLines({ items }: { items: readonly Item[] }) {
  const rows = useBackgroundLines(items);
  return rows.length ? (
    <>
      {rows.map((r) => (
        <BackgroundLine key={`${r.toolUse} ${r.id}`} row={r} />
      ))}
    </>
  ) : null;
}
