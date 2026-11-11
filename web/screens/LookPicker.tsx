// Settings > Appearance > Look (prototype design plan v3 section 5, the owner's D36; key `look`): four live preview
// tiles, Glass, Paper, Mono and Editor. Each tile carries data-look (and data-theme when the theme is not System)
// on its own preview, so tokens.css draws that look in the current theme: a sidebar strip, the user's bubble, a reply
// line in the look's prose font, and the composer with its send button. The checked look has the --ring outline, the
// check and aria-checked. A click wears a look at once (act.setLook, one recorded action).
// /settings/appearance/look?value=editor checks the Editor tile as a draft, as the Theme row shows a link's value: "Not
// saved" and Save beside the row's name, the page still in the saved look, nothing recorded until Save or a click
// (DESIGN.md 5.1 rule 3). The tiles are a radio group: Tab reaches the checked one, the arrow keys move and pick, as
// the segmented control does.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { act, useStore } from "../state/store";
import { LOOKS, lookOf } from "../state/catalog";
import type { AppSettings, LookId } from "../state/types";
import { segmentFor } from "../ui/Segmented";
import { IconCheck } from "../ui/icons";

/**
 * The look a link's value names: an id or a name, in any case ("editor", "Mono"); null when it names none.
 */
export function parseLook(raw: string): LookId | null {
  const v = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return lookOf(v) ?? LOOKS.find((l) => l.label.toLowerCase() === v)?.id ?? null;
}

const PART_UNREAD = "Part of that link could not be read.";

/** The Look row: its name and line, the four tiles, and Save while a link's look is not saved yet. */
export function LookRow({ focused, urlRaw, touch }: { focused: boolean; urlRaw?: string; touch: boolean }) {
  const saved = useStore((s) => s.settings.look);
  const theme = useStore((s) => s.settings.theme);
  const labelId = useId();
  const helpId = useId();
  const fromUrl = urlRaw !== undefined && urlRaw !== "" ? parseLook(urlRaw) : null;
  const badUrl = urlRaw !== undefined && urlRaw !== "" && fromUrl === null;
  // A look from the link is a draft: checked, not worn and not saved, until Save. A tile wears its look at once, which
  // also ends the link's draft.
  const [draft, setDraft] = useState<LookId | null>(fromUrl);
  const [savedNote, setSavedNote] = useState(false);
  // Save goes away once it saves, so the focus goes to the look it saved (the checked tile), not to the page.
  const [refocus, setRefocus] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const dirty = draft !== null && draft !== saved;
  const shown = draft ?? saved;

  useEffect(() => {
    if (!focused) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    if (dirty) saveRef.current?.focus({ preventScroll: true });
    else (rowRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ?? rowRef.current)?.focus({ preventScroll: true });
  }, [focused]);

  useEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    rowRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus({ preventScroll: true });
  }, [refocus]);

  useEffect(() => {
    if (!savedNote) return;
    const t = setTimeout(() => setSavedNote(false), 1600);
    return () => clearTimeout(t);
  }, [savedNote]);

  const pick = (id: LookId) => {
    setDraft(null);
    if (id === saved) return;
    act.setLook(id);
    setSavedNote(true);
  };
  const save = () => {
    if (draft === null) return;
    act.setLook(draft);
    setDraft(null);
    setSavedNote(true);
    setRefocus(true);
  };
  const index = LOOKS.findIndex((l) => l.id === shown);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const next = segmentFor(e.key, index, LOOKS.map(() => false));
    if (next === null) return;
    e.preventDefault();
    pick(LOOKS[next]!.id);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  const tileTheme = theme === "system" ? undefined : theme;

  return (
    <li ref={rowRef} className="set-row set-row-look" data-testid="setting-look" data-focused={focused || undefined} tabIndex={-1}>
      <div className="set-row-main">
        <div className="set-row-text">
          <span className="set-label" id={labelId}>
            Look
          </span>
          <span className="set-help" id={helpId}>
            Pick the feel you like. Every look works in light and dark.
          </span>
          {badUrl ? (
            <span className="set-row-line" role="status">
              {PART_UNREAD}
            </span>
          ) : null}
        </div>
        {dirty ? (
          <div className="set-control">
            <span className="set-save">
              <span className="set-unsaved">Not saved</span>
              <button type="button" ref={saveRef} className="btn primary" data-testid="confirm-save" onClick={save}>
                Save
              </button>
            </span>
          </div>
        ) : savedNote ? (
          <div className="set-control">
            <span className="set-saved" role="status">
              Saved
            </span>
          </div>
        ) : null}
      </div>
      <div className="look-picker" role="radiogroup" aria-labelledby={labelId} aria-describedby={helpId} data-testid="look-picker" data-touch={touch || undefined} onKeyDown={onKeyDown}>
        {LOOKS.map((l, i) => {
          const on = l.id === shown;
          return (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={i === Math.max(0, index) ? 0 : -1}
              className="look-tile"
              data-testid={`look-${l.id}`}
              title={l.hint}
              onClick={() => pick(l.id)}
            >
              <span className="look-frame">
                <LookPreview look={l.id} theme={tileTheme} />
              </span>
              <span className="look-name">
                <span>{l.label}</span>
                {on ? <IconCheck size={14} className="look-check" /> : null}
              </span>
              <span className="visually-hidden">{l.hint}</span>
            </button>
          );
        })}
      </div>
    </li>
  );
}

/**
 * A small live preview of one look: the element carries the look (and a chosen theme), so every token inside it is
 * that look's. Radii are half the look's own, to read at this size.
 */
export function LookPreview({ look, theme }: { look: LookId; theme?: Exclude<AppSettings["theme"], "system"> }) {
  return (
    <span className="look-preview" data-look={look} data-theme={theme} aria-hidden="true">
      <span className="look-side">
        <i className="look-side-on" />
        <i />
        <i />
      </span>
      <span className="look-main">
        <span className="look-bubble" />
        <span className="look-reply">Here is the plan.</span>
        <span className="look-line" />
        <span className="look-composer">
          <span className="look-send">
            <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 13V3M3.8 7.2 8 3l4.2 4.2" />
            </svg>
          </span>
        </span>
      </span>
    </span>
  );
}
