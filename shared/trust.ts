// R127 (owner rows 126, 127, 129): Claude Code's refusal of a background session in a folder that is not trusted, and
// the rules of a folder that kitespan may ask Claude Code to trust. Pure: the server matches a tool result's whole text
// with it, and the page may read the same rules. No DOM, no Bun API, no import from outside shared/.

import { CONTROL_CHARS, TRUST_LIMITS } from "./protocol";

/**
 * Claude Code's line when `claude --bg` (or a restart of a background session) finds no saved trust for its folder:
 * the CLI's own words (2.1.317 and 2.1.318, the `--bg` check's refusal; the errors page, "Workspace not trusted when
 * dispatching a background session"). The path is the real path of the session's folder, never `~` and never cut.
 * The line must be a whole line of the text; a carriage return before its line feed is allowed (JavaScript's
 * multiline `$` stops before one). Written with no backslash: `[.]` is a dot and `[/]` a slash.
 */
export const TRUST_REFUSAL_RE = new RegExp("^Workspace not trusted[.] Run `claude` in ([/].*) once and accept the trust prompt, then retry[.]$", "m");

/** The words every refusal line starts with: a text without them is never searched. */
const PREFIX = "Workspace not trusted. Run `claude` in ";

/**
 * The folder of the first refusal line in a tool result's text, or null. The home folder's line ("The home directory
 * is trusted one session at a time ..."), the "could not be resolved on disk" line and every "Error: Workspace not
 * trusted." line of other commands give null: none of them names a folder that a trust start can record.
 */
export function refusedFolder(text: unknown): string | null {
  if (typeof text !== "string" || !text.includes(PREFIX)) return null;
  const m = TRUST_REFUSAL_RE.exec(text);
  return m ? m[1]! : null;
}

/** UTF-8 length of a string (TextEncoder is in both the server and the page). */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Why `path` is not one that kitespan asks Claude Code to trust, by its text alone: `bad`, not absolute or with a
 * control character (C0, C1, DEL, a bidirectional mark or a line separator); `too_long`, over 4,096 bytes of UTF-8.
 * Null: the text is fine (the server then checks the folder on disk: there, a folder, its real path, not home).
 */
export function trustPathProblem(path: string): "bad" | "too_long" | null {
  if (typeof path !== "string" || !path.startsWith("/") || CONTROL_CHARS.test(path)) return "bad";
  return utf8Length(path) > TRUST_LIMITS.pathBytes ? "too_long" : null;
}

/** True when `outer` holds `inner` (or is it): the same path, the root, or a folder above it. */
export function holdsPath(outer: string, inner: string): boolean {
  if (outer === inner || outer === "/") return true;
  return inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
}
