// The `@` picker (DESIGN.md 6.4, 9.3; on touch 7.2 and 7.5): the / menu's twin. It rises from the composer at every
// size, never as a sheet, because it filters while the user types and a sheet would cover the field; on the phone it
// rides the keyboard inside the composer's wrapper, opaque and as wide as the composer, with 44 px rows. The focus
// stays in the field: the field's keys move the active row and pick it (Composer.tsx, mention.ts mentionKey), and a
// row's press keeps the focus (its pointerdown default is prevented), so the phone's keyboard stays up through a tap.
// While it shows it is a layer (ui/primitives), so Esc closes it before Stop. Only a mouse moves the highlight by
// hovering: a finger that scrolls the rows picks nothing and leaves the highlight where it was.
//
// Its rows are the chat folder's files (D55; files only, L16), at most 120, best first: the folder part dimmed before
// the name, the name's matched letters in bold (text children, never HTML). A path is one line, drawn as the search
// pane draws it (search.css .srch-path): the name whole, the folder part cut at its start; the row's title holds the
// whole path, and after a pick the chip shows it (a tap, on touch too). Rows only: one line, "No file matches
// @<filter>.", once the list came and nothing matches, and nothing before the list came or when the server's search
// failed. The root carries the query its rows answer (`data-q`) and their true count (`data-count`), set in the same
// render as the rows (the performance gate's hook).
//
// The composer renders on every key and on every streamed piece of the chat: the picker and its rows are memo, and
// the composer hands them callbacks that keep their identity, so such a render redraws no row, and a new highlight
// redraws the two rows it moved between. The new-chat form's picker (D59) lists the project's folder, and may open
// under the box (`below`), which is near the top of the page there.
import { memo, useEffect, useRef, type ReactNode } from "react";
import type { NameRange } from "../../shared/match";
import type { FileRow, FileRows } from "../search/engine";
import { useLayer } from "../ui/primitives";
import { scrollWithin } from "./labels";

/** The name with its matched letters in bold: text children only. */
export function markedName(name: string, ranges: readonly NameRange[]): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    const s = Math.max(pos, Math.min(start, name.length));
    const e = Math.min(end, name.length);
    if (e <= s) continue;
    if (s > pos) out.push(name.slice(pos, s));
    out.push(<strong key={s}>{name.slice(s, e)}</strong>);
    pos = e;
  }
  if (pos < name.length) out.push(name.slice(pos));
  return out;
}

export const MentionMenu = memo(function MentionMenu(props: {
  id: string;
  /** The rows for the filter, or null before the file list came. */
  rows: FileRows | null;
  active: number;
  maxHeight?: number;
  /** Open under the box instead of over it (the new-chat form, D59). */
  below?: boolean;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  /** Esc: close the picker. */
  onClose: () => void;
}) {
  const { id, rows, active, maxHeight, below, onPick, onHover, onClose } = props;
  const box = useRef<HTMLDivElement>(null);
  useLayer({ active: true, box, onClose });
  useEffect(() => {
    scrollWithin(box.current, box.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${active}`)}`));
  }, [id, active, rows]);
  return (
    <div
      className={`menu cmp-slash cmp-mention${blankPicker(rows) ? " is-blank" : ""}${below ? " is-below" : ""}`}
      ref={box}
      id={id}
      role="listbox"
      aria-label="Files"
      data-testid="mention-menu"
      data-q={rows ? rows.q : undefined}
      data-count={rows ? rows.count : undefined}
      style={maxHeight ? { maxHeight } : undefined}
      onPointerDown={(e) => e.preventDefault()}
    >
      {mentionRows({ id, rows, active, onPick, onHover })}
    </div>
  );
});

/**
 * Nothing to show: the list has not come, the server's search failed, or a folder with no file and no filter yet. The
 * picker keeps its keys (Enter still never sends) but draws no box.
 */
export function blankPicker(rows: FileRows | null): boolean {
  return !rows || (rows.rows.length === 0 && (!!rows.failed || rows.q === ""));
}

/** The picker's rows, or its one line when nothing matches: memo rows (MentionRow), one per file. */
export function mentionRows(props: { id: string; rows: FileRows | null; active: number; onPick: (index: number) => void; onHover: (index: number) => void }): ReactNode {
  const { id, rows, active, onPick, onHover } = props;
  if (!rows || blankPicker(rows)) return null;
  if (!rows.rows.length)
    return (
      <p className="cmp-slash-empty" data-testid="mention-empty">
        {`No file matches @${rows.q}.`}
      </p>
    );
  return rows.rows.map((row, index) => <MentionRow key={row.path} id={id} row={row} index={index} active={index === active} onPick={onPick} onHover={onHover} />);
}

interface RowProps {
  id: string;
  row: FileRow;
  index: number;
  active: boolean;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}

/** One file row (the element only: no hooks, so a test can press it). */
export function mentionRow({ id, row, index, active, onPick, onHover }: RowProps): ReactNode {
  const dir = row.path.slice(0, row.nameStart);
  return (
    <div
      id={`${id}-${index}`}
      role="option"
      aria-selected={active}
      data-path={row.path}
      data-active={active ? "true" : undefined}
      className={`menu-row cmp-mention-row${active ? " is-active" : ""}`}
      onPointerMove={(e) => {
        // Only a mouse moves the highlight: a finger that scrolls the rows sends pointer moves too.
        if (e.pointerType === "mouse" && !active) onHover(index);
      }}
      onClick={() => onPick(index)}
    >
      <span className="cmp-mention-path" title={row.path}>
        {dir ? (
          <span className="cmp-mention-dir">
            <bdi>{dir}</bdi>
          </span>
        ) : null}
        <span className="cmp-mention-name">{markedName(row.path.slice(row.nameStart), row.nameRanges)}</span>
      </span>
    </div>
  );
}

const MentionRow = memo(mentionRow);

/**
 * The `@` button (7.5): on touch, beside +, a 44 px target. Its press keeps the field's focus, as Send's does, so the
 * keyboard stays up; its click puts `@` at the caret and opens the picker (Composer.tsx openAt). While the picker
 * shows, as its aria-expanded says, a click closes it, as a second press on + closes its menu. `off`: shown as off
 * while the chat is held (row 80).
 */
export function AtButton({ open, off = false, onOpen, onClose }: { open: boolean; off?: boolean; onOpen: () => void; onClose: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn cmp-at-btn"
      data-testid="composer-at"
      disabled={off}
      aria-label="Mention a file"
      title="Mention a file"
      aria-haspopup="listbox"
      aria-expanded={open}
      onPointerDown={(e) => e.preventDefault()}
      onClick={open ? onClose : onOpen}
    >
      <span className="cmp-at-glyph" aria-hidden="true">
        @
      </span>
    </button>
  );
}
