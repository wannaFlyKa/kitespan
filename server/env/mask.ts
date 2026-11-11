// D60 (build checklist E7, L36): the one place where kitespan changes text it shows: the stderr tail of a chat's `exit`
// event, kitespan's own diagnostic line. Each stored value of 4 or more characters reads as one fixed mask. Claude Code's
// own output (a tool that prints a value) is the user's, as in the terminal, and is never changed.

import type { EnvVar } from "../agents/types";

/** The page's own mask for a saved value (web/env/vars.ts), the same for every value. */
const ENV_MASK = "••••••••";
/** A shorter value would mask ordinary words. */
const MASK_MIN = 4;

/**
 * `text` with every stored value (and its trimmed form) of MASK_MIN or more characters replaced by ENV_MASK. `cut`: the
 * text was cut off (a process ended in the middle of a line), so a start of a value of MASK_MIN or more characters at
 * its end reads as the mask too.
 */
export function maskValues(text: string, vars: readonly EnvVar[] | null | undefined, cut = false): string {
  if (!vars?.length) return text;
  const values = [...new Set(vars.flatMap((v) => [v.value, v.value.trim()]))].filter((v) => v.length >= MASK_MIN);
  // The longest first, so a value that holds another is masked whole.
  values.sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) if (out.includes(v)) out = out.split(v).join(ENV_MASK);
  if (!cut) return out;
  let longest = 0;
  for (const v of values) {
    for (let k = Math.min(v.length - 1, out.length); k > longest && k >= MASK_MIN; k--) {
      if (out.charCodeAt(out.length - k) === v.charCodeAt(0) && out.endsWith(v.slice(0, k))) {
        longest = k;
        break;
      }
    }
  }
  return longest > 0 ? out.slice(0, out.length - longest) + ENV_MASK : out;
}
