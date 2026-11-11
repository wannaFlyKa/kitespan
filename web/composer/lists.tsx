// The picker lists, shared by the composer's pickers and the new-chat form (agent U3). Each list renders rows only:
// a check on the current value and a mark on the one a link pre-filled. The caller puts the list in a Popup and owns
// the button that acts ("Switch" in a chat; in the form a pick only fills the form). Keys inside a list: the arrows
// and Home/End move, Enter picks, 1 to 9 pick that row (DESIGN.md 6.6 and 6.11).
// In a popover (a laptop, a tablet) the rows are base.css's .menu-row; in a sheet (the phone) the list is a .group of
// .group-row rows, as iOS lists its choices (plan v3 section 4). `grouped` picks one; it follows the Popup primitive's
// rule (a sheet on the phone) when the caller leaves it out. `rows` are the chat's model rows (store.ts modelRows);
// the catalog's list is the default.
import type { KeyboardEvent, ReactNode } from "react";
import { usePopupSheet } from "../ui/primitives";
import { EFFORTS, MODELS, MODES } from "../state/catalog";
import type { ModelRow } from "../state/types";
import { IconCheck } from "../ui/icons";
import { AUTO_OFF_LINE, BYPASS_NEW_CHAT_LINE, effortsFor, supportsAuto } from "./labels";

/** True where an anchored Popup draws a sheet: on the phone (a tablet shows an anchored menu). */
export function useSheet(): boolean {
  return usePopupSheet();
}

/** Arrow, Home, End and digit keys for any list of role="menuitemradio" or role="menuitem" rows. */
export function listKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')];
  const live = all.filter((r) => r.getAttribute("aria-disabled") !== "true");
  if (!live.length) return;
  const at = live.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (e.key === "ArrowDown") next = live[(at + 1) % live.length];
  else if (e.key === "ArrowUp") next = live[at <= 0 ? live.length - 1 : at - 1];
  else if (e.key === "Home") next = live[0];
  else if (e.key === "End") next = live[live.length - 1];
  else if (/^[1-9]$/.test(e.key)) {
    const row = all[Number(e.key) - 1];
    e.preventDefault();
    if (row && row.getAttribute("aria-disabled") !== "true") row.click();
    return;
  }
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

function Row(props: { id: string; label: ReactNode; hint?: string; checked: boolean; marked: boolean; tabbable: boolean; disabled?: boolean; warn?: boolean; grouped: boolean; onPick: (id: string) => void }) {
  const { id, label, hint, checked, marked, tabbable, disabled, warn, grouped, onPick } = props;
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={tabbable ? 0 : -1}
      data-value={id}
      className={`${grouped ? "group-row" : "menu-row"} cmp-row${marked ? " is-marked" : ""}${warn ? " is-warn" : ""}`}
      onClick={() => {
        if (!disabled) onPick(id);
      }}
    >
      <span className={grouped ? "group-text" : "cmp-row-text"}>
        <span className={grouped ? "group-label cmp-row-label" : "cmp-row-label"}>{label}</span>
        {hint ? <span className={grouped ? "group-sub" : "row-hint"}>{hint}</span> : null}
      </span>
      {marked ? <span className="cmp-row-tag">From the link</span> : null}
      <IconCheck className={grouped ? "group-check" : "menu-check"} />
    </button>
  );
}

function List(props: { label: string; grouped: boolean; children: ReactNode }) {
  return (
    <div className={props.grouped ? "group cmp-list" : "cmp-list"} role="menu" aria-label={props.label} onKeyDown={listKeys}>
      {props.children}
    </div>
  );
}

/** One Tab stop per list (the arrows move inside): the current row, else the first. */
function tabStop(ids: string[], value: string): string | undefined {
  return ids.includes(value) ? value : ids[0];
}

export function ModelList({ value, marked, grouped, rows = MODELS, onPick }: { value: string; marked?: string; grouped?: boolean; rows?: readonly ModelRow[]; onPick: (id: string) => void }) {
  const sheet = useSheet();
  const g = grouped ?? sheet;
  const stop = tabStop(rows.map((m) => m.id), value);
  return (
    <List label="Model" grouped={g}>
      {rows.map((m) => (
        <Row key={m.id} id={m.id} label={m.label} hint={m.hint} checked={m.id === value} marked={m.id === marked} tabbable={m.id === stop} grouped={g} onPick={onPick} />
      ))}
    </List>
  );
}

/** The levels that the model supports, Low to Max (the spike's labels; Desktop's are not documented). `withDefault`
 *  adds "Default" first, the user's Claude Code default (no pick), so the check always shows the current value. */
export function EffortList(props: { model: string; value: string; marked?: string; grouped?: boolean; rows?: readonly ModelRow[]; withDefault?: boolean; onPick: (id: string) => void }) {
  const { model, value, marked, grouped, rows = MODELS, withDefault = false, onPick } = props;
  const sheet = useSheet();
  const g = grouped ?? sheet;
  const levels = effortsFor(model, rows);
  const list = [...(withDefault ? [{ id: "default", label: "Default" }] : []), ...EFFORTS.filter((e) => levels.includes(e.id))];
  const stop = tabStop(list.map((e) => e.id), value);
  return (
    <List label="Effort" grouped={g}>
      {list.map((e) => (
        <Row key={e.id} id={e.id} label={e.label} checked={e.id === value} marked={e.id === marked} tabbable={e.id === stop} grouped={g} onPick={onPick} />
      ))}
    </List>
  );
}

/** Why a mode row cannot be picked, or null: Bypass in a chat that started without the bypass flag, or Auto while the
 *  model does not support it (DESIGN.md 6.6). `model` is the model the mode would run with, when it is known. */
export function modeOffLine(id: string, opts: { bypassNeedsNewChat?: boolean; model?: string; rows?: readonly ModelRow[] }): string | null {
  if (id === "bypassPermissions" && opts.bypassNeedsNewChat) return BYPASS_NEW_CHAT_LINE;
  if (id === "auto" && opts.model !== undefined && !supportsAuto(opts.model, opts.rows)) return AUTO_OFF_LINE;
  return null;
}

/** Desktop's five modes. Bypass permissions shows only while Settings allows it; in a chat whose Claude Code started
 *  without the bypass flag it shows off with its line (DESIGN.md 6.6, D12). With `model`, Auto shows off with its line
 *  while that model does not support it. The current mode stays on, with the line, so the user sees why. */
export function ModeList(props: { value: string; marked?: string; allowBypass: boolean; onPick: (id: string) => void; bypassNeedsNewChat?: boolean; model?: string; rows?: readonly ModelRow[]; grouped?: boolean }) {
  const { value, marked, allowBypass, onPick, bypassNeedsNewChat = false, model, rows } = props;
  const sheet = useSheet();
  const g = props.grouped ?? sheet;
  const list = MODES.filter((m) => m.id !== "bypassPermissions" || allowBypass);
  const stop = tabStop(list.map((m) => m.id), value);
  return (
    <List label="Permission mode" grouped={g}>
      {list.map((m) => {
        const why = modeOffLine(m.id, { bypassNeedsNewChat, model, rows });
        const off = !!why && value !== m.id;
        return (
          <Row
            key={m.id}
            id={m.id}
            label={m.label}
            hint={why ?? m.hint}
            checked={m.id === value}
            marked={m.id === marked}
            tabbable={m.id === stop}
            disabled={off}
            warn={m.id === "bypassPermissions"}
            grouped={g}
            onPick={onPick}
          />
        );
      })}
    </List>
  );
}
