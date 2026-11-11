// Rename (DESIGN.md 6.10): a field with the current title, at most 120 characters, never blank. Enter or Save saves;
// Esc or Cancel keeps the old title. A ?title= value is shown in the field and saved only by Save (5.1 rule 3). Save
// closes the form on the server's ok ack only; a refusal keeps the form and its text, with the line (useAckClose).
// The title bar draws it inline on a laptop and a medium touch device; on a phone it sits in a sheet (5.3), whose
// Cancel at the top right closes it without saving (ChatDialogs: not Done, which beside Save and the keyboard's "done"
// would read as "save it"), so the sheet shows Save alone. Save, Cancel and Esc close the form back to the page that
// opened it (dialogParent: a chat list row's Rename goes back to the list).
// Under the field, one line says where the title came from ("Named by you", "Named by Claude Code" or "From the first
// prompt"), as visible text on touch too (M30: it was the session menu's foot). It describes the saved title, so it
// shows only while the field holds that title: not for a link's pre-filled title, nor once the user types. The phone's
// sheet has no "Current title" line, because its header shows the title (M29).
import { useEffect, useRef, useState } from "react";
import { closeTo, type Route } from "../router";
import { act } from "../state/store";
import type { Chat } from "../state/types";
import { dialogParent, overCap, TITLE_SOURCE, TOO_LONG } from "../screens/common";
import { useAckClose } from "./ackClose";

export const TITLE_MAX = 120;

export function RenameForm({ chat, route, inline, testId }: { chat: Chat; route: Route; inline: boolean; testId?: string }) {
  const linked = typeof route.query.title === "string" ? route.query.title : undefined;
  const tooLong = linked === undefined && overCap("title", TITLE_MAX);
  const [title, setTitle] = useState(linked ?? chat.title);
  const field = useRef<HTMLInputElement>(null);
  // Read once: the entry's opener does not change while the form is open.
  const [parent] = useState(() => dialogParent(chat.id, route));
  const clean = title.trim();
  const saved = title === chat.title; // the field holds the saved title: its source line shows
  const ack = useAckClose();

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    if (linked === undefined) el.select();
  }, []);

  const cancel = () => closeTo(parent);
  // In the title bar the field is a state of the page, like a dialog: Esc closes it even when focus is elsewhere, and
  // nothing else hears that Esc (the composer's Esc would stop a running turn). A menu or dialog that is open takes
  // Esc first: this handler leaves it to them.
  useEffect(() => {
    if (!inline) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(".menu, .sheet, .dialog")) return;
      e.preventDefault();
      e.stopPropagation();
      closeTo(parent);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [inline, parent]);
  return (
    <form
      className={`scr-rename${inline ? " scr-rename-inline" : ""}`}
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        if (!clean || ack.waiting) return;
        ack.press(act.rename(chat.id, clean), () => closeTo(parent));
      }}
    >
      <label className="visually-hidden" htmlFor="scr-rename-field">
        Chat title
      </label>
      <input
        id="scr-rename-field"
        ref={field}
        className="field scr-rename-field"
        value={title}
        maxLength={TITLE_MAX}
        autoComplete="off"
        enterKeyHint="done"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }}
      />
      {/* The title bar's tip floats over the chat, so it goes when empty; the sheet keeps the line's height, so the
          field does not move while the user types. */}
      {tooLong || ack.line || saved || !inline ? (
        <div className={inline ? "scr-rename-tip" : "scr-rename-lines"}>
          {ack.line ? (
            <p className="notice" data-testid="dialog-notice" role="status">
              {ack.line}
            </p>
          ) : tooLong ? (
            <p className="notice">{TOO_LONG}</p>
          ) : null}
          {saved ? (
            <p className="scr-rename-from" data-testid="title-source">
              {TITLE_SOURCE[chat.titleSource]}
            </p>
          ) : !inline ? (
            <p className="scr-rename-from" aria-hidden="true">
              {"\u00a0"}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="scr-rename-actions">
        {inline ? (
          <button type="button" className="btn ghost" onClick={cancel}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="btn primary" data-testid="confirm-save-title" disabled={!clean || ack.waiting}>
          Save
        </button>
      </div>
    </form>
  );
}
