// The app-drawn pickers (DESIGN-B1 4.5, D-14, F4, F7; PAGE 6): native popups never show in the frames, so the server
// reads a tapped select, date or colour control with its fixed script and the pane draws its own picker, anchored at the
// control (kitespan's menu surface), or a sheet on the phone. The pick names the picker's id, so the server sets the
// control that the user tapped (kept as an object), whatever has the focus by then; a control that is gone refuses it.
// It closes on a pick, Done, Esc, a click outside it, picker_closed, or a focus frame that says the focus left;
// closing without a pick sends pick_cancel, so the invisible native popup closes too. On a laptop the layer measures
// itself hidden, then shows at its place, and only then takes the focus (a hidden element cannot), so its keys (PAGE-B1
// 17) reach the list or the grid and never the page's invisible popup; Esc in it closes it over the chat too
// (escape.ts), and when it closes with the focus inside, the focus goes back to the frame.
// The select: the options in order, groups as headings, a disabled option dim, the chosen one ticked; Up, Down, Home,
// End, type to find, Enter, Esc. The date grid: Previous month and Next month, the locale's first day, days outside
// min and max off, today ringed, Clear and Today; the grid keys. Time: hours and minutes (seconds when the step asks).
// Colour: the field's list first, then twelve swatches, the Hex field, Cancel and Done.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { BrowserPickerFacts, BrowserValueKind } from "../../shared/browser";
import { IconBack, IconCheck, IconForward } from "../ui/icons";
import { focusables, Popup } from "../ui/primitives";
import { onEscape, useFocusBack } from "./escape";
import { dateKey, dayOfValue, inRange, isoDay, monthGrid, placePicker, selectKey, SWATCHES, typeToFind, valueFor, weekStartOf } from "./pickRules";
import type { PickerFrame } from "./store";

export type PickAnswer = { index: number } | { value: string };
type SelectP = Extract<PickerFrame, { kind: "select" }>;
type ValueP = Exclude<PickerFrame, { kind: "select" }>;

const NAMES: Record<BrowserPickerFacts["kind"], string> = { select: "Choose an option", date: "Date", time: "Time", "datetime-local": "Date", month: "Date", week: "Date", color: "Colour" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function pickerName(p: Pick<PickerFrame, "kind" | "label">): string {
  return p.label || NAMES[p.kind];
}

/** Whether the pane shows the picker for this frame (DESIGN-B1 4.5, F7). */
export function pickerShows(p: Pick<PickerFrame, "kind" | "open">, touch: boolean, tapped: boolean): boolean {
  if (p.kind === "select" || p.kind === "color") return p.open === true;
  return p.open === true || (touch && tapped);
}

export function PickerLayer(props: {
  p: PickerFrame;
  /** The control's box on the stage (CSS px from the stage's top left), mapped from the newest frame. */
  anchor: { x: number; y: number; w: number; h: number };
  stage: { w: number; h: number };
  phone: boolean;
  touch: boolean;
  onPick: (a: PickAnswer) => void;
  onCancel: () => void;
}) {
  const { p, anchor, stage, phone, touch, onPick, onCancel } = props;
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (phone || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setPos(placePicker(anchor, stage, { w: r.width, h: r.height }));
  }, [phone, anchor.x, anchor.y, anchor.w, anchor.h, stage.w, stage.h, p.id]);
  // Placed and shown, on a laptop: the focus goes in (the part marked data-autofocus, else the first control). On touch
  // nothing takes it, so no field raises the on-screen keyboard (as the dialog card).
  const placed = pos !== null;
  useLayoutEffect(() => {
    const el = box.current;
    if (phone || touch || !placed || !el || el.contains(document.activeElement)) return;
    (el.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)") ?? focusables(el)[0])?.focus({ preventScroll: true });
  }, [phone, touch, placed, p.id]);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(
    () =>
      onEscape(() => {
        if (!box.current?.contains(document.activeElement)) return false;
        cancel.current();
        return true;
      }),
    [],
  );
  useFocusBack(box);
  useEffect(() => {
    if (phone) return;
    const down = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      onCancel();
    };
    const t = setTimeout(() => window.addEventListener("pointerdown", down, true), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", down, true);
    };
  }, [phone, onCancel]);
  const body = p.kind === "select" ? <SelectList p={p} touch={touch} onPick={onPick} onCancel={onCancel} sheet={phone} /> : p.kind === "color" ? <ColourPicker p={p} touch={touch} onPick={onPick} onCancel={onCancel} /> : p.kind === "time" ? <TimePicker p={p} onPick={onPick} onCancel={onCancel} /> : <DateGrid p={p} onPick={onPick} onCancel={onCancel} />;
  if (phone)
    return (
      <Popup open onClose={onCancel} title={pickerName(p)} testId="browser-picker-sheet">
        {body}
      </Popup>
    );
  const room = Math.max(160, stage.w - 16);
  const style: CSSProperties = { left: pos?.left ?? anchor.x, top: pos?.top ?? anchor.y + anchor.h + 4, visibility: pos ? undefined : "hidden", maxWidth: room, ...(p.kind === "select" ? { minWidth: Math.min(room, Math.max(200, Math.round(anchor.w))) } : {}) };
  return (
    <div ref={box} className="menu bp-pop" style={style} data-testid="browser-picker" data-kind={p.kind}>
      {body}
    </div>
  );
}

function SelectList({ p, touch, sheet, onPick, onCancel }: { p: SelectP; touch: boolean; sheet: boolean; onPick: (a: PickAnswer) => void; onCancel: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(Math.max(0, p.items.findIndex((i) => i.index === p.selected)));
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  useLayoutEffect(() => {
    list.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${at}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [at]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const item = p.items[at];
      if (item && !item.disabled) onPick({ index: item.index });
      return;
    }
    const to = selectKey(e.key, at, p.items);
    if (to !== null && to >= 0) {
      e.preventDefault();
      setAt(to);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      const now = Date.now();
      const text = now - typed.current.at < 800 ? typed.current.text + e.key : e.key;
      typed.current = { text, at: now };
      const found = typeToFind(text, at, p.items);
      if (found !== null) setAt(found);
    }
  };
  let group: string | null = null;
  const rows: ReactNode[] = [];
  p.items.forEach((item, i) => {
    if (item.group !== group) {
      group = item.group;
      if (group) rows.push(<div key={`g${i}`} className="bp-group" role="presentation">{group}</div>);
    }
    const chosen = item.index === p.selected;
    rows.push(
      <div
        key={i}
        id={`bp-opt-${p.id}-${i}`}
        className={`menu-row${sheet ? " bp-sheet-row" : ""}`}
        role="option"
        aria-selected={chosen}
        aria-disabled={item.disabled || undefined}
        data-active={i === at ? "true" : undefined}
        data-i={i}
        onPointerMove={() => !touch && setAt(i)}
        onClick={() => !item.disabled && onPick({ index: item.index })}
      >
        <span className="menu-check" style={chosen ? { visibility: "visible" } : undefined}>
          <IconCheck />
        </span>
        {item.label}
      </div>,
    );
  });
  return (
    <div ref={list} role="listbox" aria-label={pickerName(p)} tabIndex={0} aria-activedescendant={`bp-opt-${p.id}-${at}`} onKeyDown={onKey} data-autofocus="" data-testid="browser-select">
      {rows}
    </div>
  );
}

function DateGrid({ p, onPick, onCancel }: { p: ValueP; onPick: (a: PickAnswer) => void; onCancel: () => void }) {
  const weekStart = weekStartOf();
  const today = isoDay(new Date(Date.now() - new Date().getTimezoneOffset() * 60_000));
  const chosen = dayOfValue(p.kind, p.value);
  const [focus, setFocus] = useState(chosen ?? today);
  const [time, setTime] = useState(p.kind === "datetime-local" && p.value.includes("T") ? p.value.slice(11, 16) : "00:00");
  const grid = useRef<HTMLDivElement>(null);
  const y = Number(focus.slice(0, 4));
  const m = Number(focus.slice(5, 7)) - 1;
  const days = monthGrid(y, m, weekStart);
  const min = p.min ? dayOfValue(p.kind, p.min) : null;
  const max = p.max ? dayOfValue(p.kind, p.max) : null;
  const ok = (d: string) => inRange(d, min, max);
  useLayoutEffect(() => {
    grid.current?.querySelector<HTMLElement>(`[data-day="${focus}"]`)?.focus({ preventScroll: true });
  }, [focus]);
  const pick = (d: string) => {
    if (!ok(d)) return;
    if (p.kind === "datetime-local") setFocus(d);
    else onPick({ value: valueFor(p.kind, { day: d }) ?? "" });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      pick(focus);
      return;
    }
    const to = dateKey(e.key, focus, e.shiftKey, weekStart);
    if (to) {
      e.preventDefault();
      setFocus(to);
    }
  };
  const dows = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 10, 1 + ((weekStart + i) % 7)))).slice(0, 2));
  const head = `${MONTHS[m]} ${y}`;
  const step = (n: number) => {
    const d = new Date(Date.UTC(y, m + n, 1));
    setFocus(isoDay(d));
  };
  return (
    <div className="bp-cal" role="dialog" aria-label={pickerName(p)} onKeyDown={onKey} data-testid="browser-date">
      <div className="bp-pop-head">
        <h3 className="bp-pop-title">{head}</h3>
        <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => step(-1)}>
          <IconBack />
        </button>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => step(1)}>
          <IconForward />
        </button>
      </div>
      <div className="bp-cal-grid" role="grid" aria-label={head} ref={grid}>
        {dows.map((d, i) => (
          <span key={`w${i}`} className="bp-cal-dow" aria-hidden="true">
            {d}
          </span>
        ))}
        {days.map((d, i) =>
          d ? (
            <button
              key={d}
              type="button"
              role="gridcell"
              className={`bp-cal-day${d === today ? " is-today" : ""}`}
              aria-selected={d === (p.kind === "datetime-local" ? focus : chosen)}
              aria-label={`${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}${d === today ? ", today" : ""}`}
              tabIndex={d === focus ? 0 : -1}
              disabled={!ok(d)}
              data-day={d}
              data-autofocus={d === focus ? "" : undefined}
              onClick={() => pick(d)}
            >
              {Number(d.slice(8))}
            </button>
          ) : (
            <span key={`b${i}`} className="bp-cal-day" aria-hidden="true" />
          ),
        )}
      </div>
      {p.kind === "datetime-local" ? (
        <div className="bp-time">
          <input className="field" type="text" inputMode="numeric" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      ) : null}
      <div className="bp-pop-foot">
        <button type="button" className="btn plain" onClick={() => onPick({ value: "" })}>
          Clear
        </button>
        {p.kind === "datetime-local" ? (
          <button type="button" className="btn primary" disabled={!/^\d{2}:\d{2}$/.test(time) || !ok(focus)} onClick={() => onPick({ value: valueFor("datetime-local", { day: focus, time }) ?? "" })}>
            Done
          </button>
        ) : (
          <button type="button" className="btn plain" disabled={!ok(today)} onClick={() => pick(today)}>
            Today
          </button>
        )}
      </div>
    </div>
  );
}

function TimePicker({ p, onPick, onCancel }: { p: ValueP; onPick: (a: PickAnswer) => void; onCancel: () => void }) {
  const secs = !!p.step && Number(p.step) > 0 && Number(p.step) < 60;
  const [h, setH] = useState(p.value.slice(0, 2) || "00");
  const [m, setM] = useState(p.value.slice(3, 5) || "00");
  const [s, setS] = useState(p.value.slice(6, 8) || "00");
  const two = (v: string, max: number) => /^\d{1,2}$/.test(v) && Number(v) <= max;
  const ok = two(h, 23) && two(m, 59) && (!secs || two(s, 59));
  const value = `${h.padStart(2, "0")}:${m.padStart(2, "0")}${secs ? `:${s.padStart(2, "0")}` : ""}`;
  const field = (label: string, v: string, set: (v: string) => void) => <input className="field" type="text" inputMode="numeric" maxLength={2} aria-label={label} value={v} onChange={(e) => set(e.target.value)} />;
  return (
    <div role="dialog" aria-label={pickerName(p)} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onCancel())} data-testid="browser-time">
      <div className="bp-time">
        {field("Hours", h, setH)}:{field("Minutes", m, setM)}
        {secs ? <>:{field("Seconds", s, setS)}</> : null}
      </div>
      <div className="bp-pop-foot">
        <button type="button" className="btn plain" onClick={() => onPick({ value: "" })}>
          Clear
        </button>
        <button type="button" className="btn primary" disabled={!ok || !inRange(value, p.min, p.max)} onClick={() => onPick({ value })}>
          Done
        </button>
      </div>
    </div>
  );
}

function ColourPicker({ p, touch, onPick, onCancel }: { p: ValueP; touch: boolean; onPick: (a: PickAnswer) => void; onCancel: () => void }) {
  const [hex, setHex] = useState(p.value || "#000000");
  const swatches = [...new Set([...p.list.map((c) => c.toLowerCase()).filter((c) => /^#[0-9a-f]{6}$/.test(c)), ...SWATCHES])].slice(0, touch ? 18 : 24);
  const value = valueFor("color", { color: hex });
  return (
    <div role="dialog" aria-label={pickerName(p)} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onCancel())} data-testid="browser-colour">
      <div className="bp-pop-head">
        <h3 className="bp-pop-title">{pickerName(p)}</h3>
      </div>
      <div className="bp-swatches" role="radiogroup" aria-label="Colours">
        {swatches.map((c) => (
          <button key={c} type="button" role="radio" className="bp-swatch" aria-checked={c === hex.toLowerCase()} aria-label={c} style={{ background: c }} onClick={() => setHex(c)} data-autofocus={c === hex.toLowerCase() ? "" : undefined} />
        ))}
      </div>
      <div className="bp-hex">
        <span className="bp-hex-now" style={{ background: value ?? "transparent" }} />
        <label htmlFor={`bp-hex-${p.id}`}>Hex</label>
        <input id={`bp-hex-${p.id}`} className="field" value={hex} spellCheck={false} autoComplete="off" onChange={(e) => setHex(e.target.value)} />
      </div>
      <div className="bp-pop-foot">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!value} onClick={() => value && onPick({ value })}>
          Done
        </button>
      </div>
    </div>
  );
}
