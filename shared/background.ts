// R131 (owner row 131; DESIGN-R131 section 4): the launch line that `claude --bg` prints, the only tie between a chat
// and a background session it starts (Claude Code records no parent link). Pure: the server matches a tool result's
// whole text with it, before the text is cut for the page, and the page may read the same rules. No DOM, no Bun API,
// no import from outside shared/. Written with no backslash: `[(]` and `[)]` are parentheses.

import { BG_ID } from "./ids";
import { BG_LIMITS, CONTROL_CHARS, capText, type BgLaunch } from "./protocol";

/** Claude Code's short id of a background session (2.1.318 `IM`): 8 lowercase hex characters. */
export const BG_ID_RE = BG_ID;

/** ESC, then a CSI sequence: what Claude Code's colours add (the cyan id, the dim suffix and hint lines). */
const CSI = new RegExp(String.fromCharCode(27) + "[[][0-9;?]*[ -/]*[@-~]", "g");

/**
 * Claude Code's launch line (2.1.317 and 2.1.318, function Xtt; the docs' "backgrounded · 7c5dcf5d · flaky-test-fix"):
 * "backgrounded", U+00B7 with one space each side, the 8-hex id, then " · <name>" when the session has a name, then
 * " (idle — send a prompt to start)" (U+2014) when it got no prompt. A whole line: JavaScript's multiline `$` also stops
 * before a carriage return, and `.` matches no line end.
 */
export const BG_LAUNCH_RE = new RegExp("^backgrounded · ([a-f0-9]{8})(?: · (.+?))?( [(]idle — send a prompt to start[)])?$", "gm");

/** The words every launch line starts with: a text without them is never searched. */
const PREFIX = "backgrounded ";

const CONTROL_ALL = new RegExp(CONTROL_CHARS.source, "g");

/** A session's name as kitespan keeps one: control characters out, trimmed, cut at 120; null when nothing is left. */
export function bgName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = capText(v.replace(CONTROL_ALL, "").trim(), BG_LIMITS.name).trim();
  return s || null;
}

/**
 * Every launch line of a tool result's whole text, in their order, one per id (the first), at most 16; [] for a text
 * with none. Colour codes go first; every line counts (one command can start two sessions).
 */
export function launchesIn(text: unknown): BgLaunch[] {
  if (typeof text !== "string" || !text.includes(PREFIX)) return [];
  const plain = text.replace(CSI, "");
  const out: BgLaunch[] = [];
  // A copy each time: a global pattern's lastIndex is state that another caller may have moved.
  for (const m of plain.matchAll(new RegExp(BG_LAUNCH_RE.source, "gm"))) {
    const id = m[1]!;
    if (out.some((l) => l.id === id)) continue;
    out.push({ id, name: bgName(m[2]), idle: m[3] !== undefined });
    if (out.length >= BG_LIMITS.perResult) break;
  }
  return out;
}

/** The folder of a worktree that Claude Code made for a session (`<origin>/.claude/worktrees/<name>`): its origin. */
export function originFolder(cwd: string): string | null {
  const at = cwd.indexOf("/.claude/worktrees/");
  return at > 0 ? cwd.slice(0, at) : null;
}
