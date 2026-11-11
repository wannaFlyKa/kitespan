// The app-drawn pickers' rules (DESIGN-B1 4.5; PAGE 6 and 17), as plain functions: the select list's keys and type to
// find, the date grid's keys and its month grid with the locale's first day of the week, ISO weeks, the value forms
// that each kind sets (shared/browser.ts BROWSER_PICK_PATTERNS), min and max, and where a picker sits against its
// control (below it, above it when the room below is short, never past the stage's edges).
import type { BrowserSelectItem, BrowserValueKind } from "../../shared/browser";

// ---- the select list

/** The option a key moves to from `index` (Up, Down, Home, End), skipping disabled ones; null for another key. */
export function selectKey(key: string, index: number, items: readonly Pick<BrowserSelectItem, "disabled">[]): number | null {
  const ok = (i: number) => i >= 0 && i < items.length && !items[i]!.disabled;
  if (key === "Home") return items.findIndex((x) => !x.disabled);
  if (key === "End") {
    for (let i = items.length - 1; i >= 0; i--) if (ok(i)) return i;
    return -1;
  }
  const step = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  if (!step) return null;
  for (let i = index + step; i >= 0 && i < items.length; i += step) if (ok(i)) return i;
  return index;
}

/** Type to find: the next option after `index` (wrapping) whose label starts with `typed`, or one at `index` itself. */
export function typeToFind(typed: string, index: number, items: readonly Pick<BrowserSelectItem, "label" | "disabled">[]): number | null {
  const t = typed.toLowerCase();
  if (!t) return null;
  const n = items.length;
  const start = t.length > 1 ? index : index + 1;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (!items[i]!.disabled && items[i]!.label.toLowerCase().startsWith(t)) return i;
  }
  return null;
}

// ---- dates, as YYYY-MM-DD in UTC arithmetic (no time zone moves a day)

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const isoDay = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

/**
 * The day a key moves to in the date grid (the grid pattern): the arrows by a day and a week, Page Up and Page Down by
 * a month (with Shift a year), Home and End to the week's ends (`weekStart`: 0 Sunday, 1 Monday). Null for another key.
 */
export function dateKey(key: string, day: string, shift: boolean, weekStart: number): string | null {
  const d = parseDay(day);
  if (!d) return null;
  switch (key) {
    case "ArrowRight":
      return isoDay(addDays(d, 1));
    case "ArrowLeft":
      return isoDay(addDays(d, -1));
    case "ArrowDown":
      return isoDay(addDays(d, 7));
    case "ArrowUp":
      return isoDay(addDays(d, -7));
    case "PageDown":
      return isoDay(addMonths(d, shift ? 12 : 1));
    case "PageUp":
      return isoDay(addMonths(d, shift ? -12 : -1));
    case "Home":
      return isoDay(addDays(d, -((d.getUTCDay() - weekStart + 7) % 7)));
    case "End":
      return isoDay(addDays(d, 6 - ((d.getUTCDay() - weekStart + 7) % 7)));
  }
  return null;
}

/** A month's grid (month 0-11), whole weeks from the locale's first day: blanks (null) outside the month. */
export function monthGrid(year: number, month: number, weekStart: number): (string | null)[] {
  const first = new Date(Date.UTC(year, month, 1));
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() - weekStart + 7) % 7;
  const out: (string | null)[] = Array(lead).fill(null);
  for (let i = 1; i <= days; i++) out.push(`${year}-${pad(month + 1)}-${pad(i)}`);
  while (out.length % 7) out.push(null);
  return out;
}

/** The locale's first day of the week (Intl.Locale's week info where the browser has it), else Monday. */
export function weekStartOf(locale?: string): number {
  try {
    const l = new Intl.Locale(locale ?? (typeof navigator !== "undefined" ? navigator.language : "en-GB")) as Intl.Locale & { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } };
    const info = l.getWeekInfo?.() ?? l.weekInfo;
    if (info && Number.isInteger(info.firstDay)) return info.firstDay % 7;
  } catch {
    // no week info
  }
  return 1;
}

/** Whether a value lies within the control's min and max (the same form compares as text). */
export function inRange(v: string, min: string | null, max: string | null): boolean {
  if (min && v < min) return false;
  if (max && v > max) return false;
  return true;
}

/** The ISO week of a day, as `YYYY-Www`. */
export function isoWeekOf(day: string): string {
  const d = parseDay(day)!;
  const wd = (d.getUTCDay() + 6) % 7; // Monday 0
  const thursday = addDays(d, 3 - wd);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((thursday.getTime() - addDays(jan4, -((jan4.getUTCDay() + 6) % 7)).getTime()) / (7 * 86_400_000));
  return `${year}-W${pad(week)}`;
}

/** The first day of an ISO week `YYYY-Www` (its Monday), for the grid to show it. */
export function weekDay(week: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return null;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const monday = addDays(jan4, -((jan4.getUTCDay() + 6) % 7));
  return isoDay(addDays(monday, (Number(m[2]) - 1) * 7));
}

/**
 * The value a pick sets, in the form the browser writes for each kind: a day, a time, both, a month, a week, or a
 * colour in lowercase #rrggbb. A date-like kind with no day is the empty value (Clear); a colour must be whole.
 */
export function valueFor(kind: BrowserValueKind, parts: { day?: string; time?: string; color?: string }): string | null {
  switch (kind) {
    case "date":
      return parts.day ?? "";
    case "datetime-local":
      return parts.day ? `${parts.day}T${parts.time || "00:00"}` : "";
    case "month":
      return parts.day ? parts.day.slice(0, 7) : "";
    case "week":
      return parts.day ? isoWeekOf(parts.day) : "";
    case "time":
      return parts.time ?? "";
    case "color": {
      const c = (parts.color ?? "").trim().toLowerCase();
      return /^#[0-9a-f]{6}$/.test(c) ? c : null;
    }
  }
}

/** The day a control's value shows in the grid (its own day, a month's first, a week's Monday). */
export function dayOfValue(kind: BrowserValueKind, value: string): string | null {
  if (!value) return null;
  if (kind === "date" || kind === "datetime-local") return parseDay(value) ? value.slice(0, 10) : null;
  if (kind === "month") return /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : null;
  if (kind === "week") return weekDay(value);
  return null;
}

/** The twelve fixed swatches a colour picker offers after the page's own list (values offered to the page, not the look's). */
export const SWATCHES = ["#2f6b4f", "#1d5fd6", "#7b3fbf", "#c42929", "#d27306", "#a17510", "#3a7d8c", "#5f5f5f", "#1f1f1f", "#ffffff", "#e86f9a", "#6aa1ff"] as const;

// ---- where a picker sits

const EDGE = 8;
const GAP = 4;

/** A picker's place on the stage: below its control at its left edge; above when the room below is short; inside the stage. */
export function placePicker(control: { x: number; y: number; w: number; h: number }, stage: { w: number; h: number }, pop: { w: number; h: number }): { left: number; top: number } {
  const left = Math.max(EDGE, Math.min(control.x, stage.w - pop.w - EDGE));
  const below = control.y + control.h + GAP;
  let top = below;
  if (below + pop.h > stage.h - EDGE) {
    const above = control.y - GAP - pop.h;
    top = above >= EDGE ? above : Math.max(EDGE, Math.min(below, stage.h - pop.h - EDGE));
  }
  return { left: Math.round(left), top: Math.round(top) };
}
