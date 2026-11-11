// U2 (DESIGN-U2 5, 8, 9 and 15): a finished turn's line and its folded work. The line is one row in the transcript's
// row grammar (`chat-row`: the look's row height, 44 px on touch, its radius, the small size and the quiet colour),
// with the disclosure chevron in the icon slot, the words, and a quiet tag when the turn did not end well. It is a
// button with aria-expanded and aria-controls (the work's containers). The open work sits inside a thin rule, so the
// open state shows where the work ends and the answer starts; only the chevron turns, and only on the reader's own
// press (no height animation; an automatic fold moves nothing; nothing under Reduce motion). Folded work stays in the
// page as hidden="until-found", so the browser's Find still finds its words, and its beforematch opens the turn; React
// writes `hidden` as a plain boolean, so the value is set here.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { IconRight } from "../../ui/icons";
import { HiddenWorkProvider } from "./context";

/** The id of a turn's work container: the first one, or the n-th after an input that Claude read inside the turn. */
export const workId = (turnId: string, n: number) => `turn-work-${turnId}-${n}`;

/**
 * One container of a turn's work. Folded, it is hidden until found: the browser's Find looks inside it, and a match
 * (its beforematch) calls `found`.
 */
export function TurnWork({ turnId, n, open, found, children }: { turnId: string; n: number; open: boolean; found: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) el.setAttribute("hidden", "until-found");
  }, [open]);
  const onFound = useRef(found);
  onFound.current = found;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => onFound.current();
    el.addEventListener("beforematch", on);
    return () => el.removeEventListener("beforematch", on);
  }, []);
  return (
    <div ref={ref} id={workId(turnId, n)} className={`chat-turn-work${n > 0 ? " chat-turn-more" : ""}`} data-turn-work={turnId} hidden={!open}>
      {/* R127: folded, no row inside draws its Trust this folder line: the turn's line carries it. */}
      <HiddenWorkProvider value={!open}>{children}</HiddenWorkProvider>
    </div>
  );
}

/** The line: the words and the tag, the chevron that turns when the work is open, then the first container of work. */
export function TurnLine({
  turnId,
  label,
  tag,
  open,
  works,
  turning = false,
  toggle,
  note,
  children,
}: {
  turnId: string;
  label: string;
  tag: string | null;
  open: boolean;
  /** The reader pressed this line last: its chevron turns (an automatic fold, a link or Find moves nothing). */
  turning?: boolean;
  /** How many containers its work has (an input read inside the turn starts another one). */
  works: number;
  toggle: (line: HTMLElement) => void;
  /** R127: the Trust this folder lines of its folded work's refused rows, under the line (never folded with the work). */
  note?: ReactNode;
  children: ReactNode;
}) {
  const controls = Array.from({ length: works }, (_, n) => workId(turnId, n)).join(" ");
  return (
    <div className={`chat-item chat-compact chat-item-turn chat-turn${open ? " is-open" : ""}${turning ? " is-turning" : ""}`} data-turn-id={turnId} data-testid={`turn-${turnId}`}>
      <div className="chat-row-line">
        <button type="button" className="chat-row chat-turn-line" aria-expanded={open} aria-controls={controls} data-testid="turn-line" onClick={(e) => toggle(e.currentTarget)}>
          <span className="chat-row-icon chat-turn-chev">
            <IconRight size={15} />
          </span>
          <span className="chat-row-label">{label}</span>
          {tag ? (
            <>
              {/* The accessible name pauses before the tag: "..., ran 1 command, Interrupted". */}
              <span className="visually-hidden">,</span>{" "}
              <span className="chat-tag">{tag}</span>
            </>
          ) : null}
        </button>
      </div>
      {note}
      {children}
    </div>
  );
}
