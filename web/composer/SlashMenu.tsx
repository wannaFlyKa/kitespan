// The / menu (DESIGN.md 6.4). It rises from the composer at every size, never as a sheet, because it filters while
// the user types and a sheet would cover the field (7.2). Focus stays in the field: the field's keys move the active
// row (Up, Down) and pick it (Enter, Tab); a click or tap picks a row. While it shows it is a layer (ui/primitives), so
// Esc closes it before any older surface, such as a pane over the chat that opened first (6.4: "Esc first closes an
// open menu"). It is base.css's .menu with .menu-row rows, so the active row takes the look's menu highlight. The rows
// are the chat's own commands; before Claude Code sent them (a chat that has not run since kitespan started) the menu
// says so in one line. A terminal-only row is quieter and tagged Open in terminal, because a pick opens it there
// (D47); in the menu at a mid-line `/` (`inText`, D57) a pick is plain text in the message, so the row reads as any
// other. The new-chat form's box is near the top of the page, so there it may open under the box (`below`, D59).
import { useEffect, useRef } from "react";
import type { MenuRow } from "./draft";
import { useLayer } from "../ui/primitives";
import { scrollWithin } from "./labels";

export function SlashMenu(props: {
  id: string;
  rows: MenuRow[];
  active: number;
  filter: string;
  notice?: string;
  /** The menu at a mid-line `/` (D57): a pick puts `/<name> ` in the text, so no row opens the Terminal pane. */
  inText?: boolean;
  maxHeight?: number;
  /** Open under the box instead of over it (the new-chat form, D59). */
  below?: boolean;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  /** Esc: close the menu. */
  onClose: () => void;
}) {
  const { id, rows, active, filter, notice, inText, maxHeight, below, onPick, onHover, onClose } = props;
  const box = useRef<HTMLDivElement>(null);
  useLayer({ active: true, box, onClose });
  useEffect(() => {
    scrollWithin(box.current, box.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${active}`)}`));
  }, [id, active]);
  return (
    <div className={`menu cmp-slash${below ? " is-below" : ""}`} ref={box} id={id} role="listbox" aria-label="Slash commands" data-testid="slash-menu" style={maxHeight ? { maxHeight } : undefined}>
      {notice ? (
        <p className="notice cmp-slash-note" data-testid="link-notice" role="status">
          {notice}
        </p>
      ) : null}
      {rows.length ? (
        rows.map((c, i) => {
          const term = c.terminalOnly && !inText;
          return (
            <div
              key={c.name}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={term || undefined}
              data-command={c.name}
              data-active={i === active ? "true" : undefined}
              className={`menu-row cmp-slash-row${i === active ? " is-active" : ""}${term ? " is-term" : ""}`}
              onPointerDown={(e) => e.preventDefault()}
              onPointerMove={() => {
                if (i !== active) onHover(i);
              }}
              onClick={() => onPick(i)}
            >
              <span className="cmp-slash-name">/{c.name}</span>
              {c.args ? <span className="cmp-slash-args">{c.args}</span> : null}
              <span className="cmp-slash-hint">{c.hint}</span>
              {term ? <span className="cmp-tag">Open in terminal</span> : c.source !== "built-in" ? <span className="cmp-tag">yours</span> : null}
            </div>
          );
        })
      ) : (
        <p className="cmp-slash-empty">{filter ? `No command matches /${filter}.` : "No commands yet."}</p>
      )}
    </div>
  );
}
