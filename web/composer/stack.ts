// The phone's message box in two forms (DESIGN.md 7.5, round C1): "one row" (+, @, the field and the end key side by
// side) while the draft takes one line, and "stacked" (the field over the box's whole width, the keys on one row under
// it, where they were) once it takes two lines or more. Measured, never counted in characters: "lines" is the field's
// own measure with its height at auto, the read that the composer's grow effect takes, and the mode chip on a row of
// its own above the field (row 76's line under 12em) is a line too.
//
// The rule, with a band of 2em so that one character typed and deleted at the edge never switches the form twice:
// 0. a one-row line of 20em or more is one row (a rotated phone: its line beside the keys is wide already, and a row of
//    keys would cost 44 px of a short view);
// 1. an empty field is one row (its placeholder never decides);
// 2. one row to stacked: the line shows 2 lines or more in the one-row form;
// 3. stacked to one row: only when the text has no line break, the stacked line shows it on 1 line, and the one-row
//    form with the line 2em narrower shows it on 1 line too (a measure the composer takes only then);
// 4. nothing else switches it.
// A text that rule 2 stacks needs 2 lines in the one-row column, so it needs 2 in a narrower one, and rule 3 keeps it;
// a text that rule 3 brings back fits the narrower column, so it fits the one-row column, and rule 2 keeps it there.
// So a layout effect that switches the form and measures again never switches it back in the same pass. Rule 0 reads
// the same width in both forms (the keys keep their widths), so it never flips a pass either.

/** The band of rule 3, in the field's em: wider than any one character (a Latin letter, a CJK character, an emoji). */
export const STACK_BAND_EM = 2;
/**
 * Rule 0's width, in the field's em: the one-row line from which the box keeps one row. An upright phone's line is
 * about 12 to 18em (390 to 480 px wide); a rotated one's is about 23em at 568 px and 32em at 844 px (Glass, 17 px).
 */
export const STACK_ROW_EM = 20;

export interface BoxText {
  /** The field holds no text. */
  empty: boolean;
  /** The text holds a line break. */
  hasBreak: boolean;
  /** The line's rows in the form the box shows now (lineRows). */
  lines: number;
  /** The one-row form's line (beside +, @ and the end key) in the field's em, read the same in both forms. */
  rowEm: number;
  /** The line's rows in the one-row form with the line STACK_BAND_EM narrower; taken only for rule 3. */
  narrower: () => number;
}

/** Whether the box is stacked, from the form it shows now and the text's measure. */
export function nextStacked(stacked: boolean, t: BoxText): boolean {
  if (t.empty || t.rowEm >= STACK_ROW_EM) return false;
  if (!stacked) return t.lines >= 2;
  if (t.hasBreak || t.lines >= 2) return true;
  return t.narrower() >= 2;
}

/** The field's lines with its height at auto: (scrollHeight - padding) / line height, rounded; a bad read is 1. */
export function fieldLines(m: { scrollHeight: number; padding: number; lineHeight: number }): number {
  if (!(m.lineHeight > 0) || !(m.scrollHeight > 0)) return 1;
  return Math.max(1, Math.round((m.scrollHeight - m.padding) / m.lineHeight));
}

/**
 * The line's rows: the field's lines, and one more when the mode chip has a row of its own above the field (the field
 * starts under the chip's foot). Offsets, not client rects, so the chip's entrance (a scale) does not count.
 */
export function lineRows(field: { scrollHeight: number; offsetTop: number }, chip: { offsetTop: number; offsetHeight: number } | null, padding: number, lineHeight: number): number {
  const own = !!chip && field.offsetTop >= chip.offsetTop + chip.offsetHeight;
  return fieldLines({ scrollHeight: field.scrollHeight, padding, lineHeight }) + (own ? 1 : 0);
}

/**
 * Whether the grow effect scrolls the phone's field to its end after a measure: only in a pass that changed the text or
 * the form (a paste that stacks the box wraps the text again under the caret), with the focus in the field, the caret
 * at the text's end and the text past the cap. A pass for anything else (a turn that starts or ends, a hold, the `@`
 * button, a rotation) keeps the field's scroll, so a reader who scrolled up in their draft keeps their place.
 */
export function pinsEnd(p: { edited: boolean; focused: boolean; caretAtEnd: boolean; overCap: boolean }): boolean {
  return p.edited && p.focused && p.caretAtEnd && p.overCap;
}
