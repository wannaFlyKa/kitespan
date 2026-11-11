// T-31 (DESIGN-T1 2.7): where a name or a path may wrap. A path line's name, a row menu's first line and the Open on
// phone link break at their own punctuation first: before each "." and "_" (never at the start, so ".env" stays whole)
// and after each "/"; a hyphen already lets a line break after it. Inside a run of these signs ("__", "/.") there is
// one break point, before the run. The point is a <wbr>, which is no character, so a selection and a copy of the text
// stay exact (a zero-width space would be copied). `overflow-wrap: anywhere` in the line's style then breaks inside a
// part only when that part alone is wider than the line.
import { Fragment, type ReactNode } from "react";

const SIGN = /[._/]/;

/** The text cut at its break points; the parts joined are the text exactly. */
export function breakParts(text: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 1; i < text.length; i++) {
    const before = text[i - 1]!;
    const ch = text[i]!;
    if (before === "/" || ((ch === "." || ch === "_") && !SIGN.test(before))) {
      parts.push(text.slice(from, i));
      from = i;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/** The text with a <wbr> at each break point; a text with none is the string itself. */
export function breakable(text: string): ReactNode {
  const parts = breakParts(text);
  if (parts.length < 2) return text;
  return parts.map((p, i) => (
    <Fragment key={i}>
      {i > 0 ? <wbr /> : null}
      {p}
    </Fragment>
  ));
}
