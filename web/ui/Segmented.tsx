// The segmented control (prototype design plan v2): a --fill track and a raised segment that slides to the one that is
// on. Use it for every choice of two to four (the sidebar filter, the transcript view, the theme). It is a radio
// group: Tab reaches the segment that is on, the arrow keys move to the next segment and turn it on (wrapping), Home
// and End go to the first and the last, and a click, a tap, Space or Enter turns a segment on. Disabled segments are
// skipped. onChange runs only inside those handlers, never during a render. base.css draws it (.seg, .seg-item).
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

export interface SegmentOption<T extends string = string> {
  value: T;
  /** The segment's face: a word, or an icon (then give `title`). */
  label: ReactNode;
  /** The segment's name for a screen reader and its tooltip; needed when the label is an icon. */
  title?: string;
  disabled?: boolean;
  testId?: string;
}

/**
 * The segment a key moves to from segment `index` (-1 when none is on), given which segments are disabled. The arrow
 * keys wrap; Home and End go to the first and the last segment that is not disabled. Null when the key does not move.
 */
export function segmentFor(key: string, index: number, disabled: readonly boolean[]): number | null {
  const count = disabled.length;
  if (count === 0) return null;
  if (key === "Home" || key === "End") {
    const order = [...disabled.keys()];
    if (key === "End") order.reverse();
    return order.find((i) => !disabled[i]) ?? null;
  }
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (step === 0) return null;
  const from = index < 0 ? (step > 0 ? -1 : count) : index;
  for (let i = 1; i <= count; i++) {
    const at = (((from + step * i) % count) + count) % count;
    if (!disabled[at]) return at === index ? null : at;
  }
  return null;
}

export function Segmented<T extends string>(props: {
  /** The segment that is on; none is on when no option has this value. */
  value: T | null | undefined;
  options: readonly SegmentOption<T>[];
  /** Called with the segment the user turned on (never with the one that is on already). */
  onChange: (value: T) => void;
  /** The group's name for a screen reader, for example "Show" or "Theme". */
  label: string;
  /** Fill the width of the container (.seg-block); the segments share it equally. */
  block?: boolean;
  /** The compact size (.seg-small): 20 px segments at 12 px, for a sidebar or a toolbar. */
  small?: boolean;
  className?: string;
  testId?: string;
}) {
  const { value, options, onChange, label, block, small, className, testId } = props;
  const index = options.findIndex((o) => o.value === value);
  const tabStop = index >= 0 && !options[index]!.disabled ? index : options.findIndex((o) => !o.disabled);
  const pick = (i: number) => {
    const o = options[i];
    if (o && !o.disabled && o.value !== value) onChange(o.value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const at = Number((e.target as HTMLElement).dataset?.index ?? index);
    const next = segmentFor(e.key, Number.isInteger(at) ? at : index, options.map((o) => !!o.disabled));
    if (next === null) return;
    e.preventDefault();
    pick(next);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  const style = { "--seg-count": Math.max(1, options.length), "--seg-index": Math.max(0, index) } as CSSProperties;
  const classes = ["seg", block ? "seg-block" : "", small ? "seg-small" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div role="radiogroup" aria-label={label} className={classes} style={style} data-none={index < 0 ? "true" : undefined} data-testid={testId} onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={i === index}
          aria-label={typeof o.label === "string" ? undefined : o.title}
          title={o.title}
          tabIndex={i === tabStop ? 0 : -1}
          disabled={o.disabled}
          className="seg-item"
          data-index={i}
          data-value={o.value}
          data-testid={o.testId}
          onClick={() => pick(i)}
        >
          {typeof o.label === "string" ? (
            <span className="seg-label" data-label={o.label}>
              {o.label}
            </span>
          ) : (
            o.label
          )}
        </button>
      ))}
    </div>
  );
}
