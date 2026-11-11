// The DESIGN.md 5.4 lines for a link that could not be read in full. They never repeat a value from the link.
import type { Route } from "../router";

// The pre-fills whose over-cap line ("That link's text is too long to fill in ...") the screen shows itself, at the
// field: the composer (text, cmd, args), the rename field (title), the new-chat form (text), a setting (value), and the
// search pane's field and the @ picker's filter (q, v0.3 search).
const PREFILL_KEYS = new Set(["text", "cmd", "args", "title", "value", "q"]);

/** True when every query value the router dropped is one of those pre-fills, over its cap: 5.4 gives it one line. */
function onlyOverCapPrefill(route: Route): boolean {
  if (typeof location === "undefined") return false;
  const search = new URLSearchParams(location.search);
  const bad = Object.keys(route.def.query).filter((k) => search.has(k) && !(k in route.query));
  return (
    bad.length > 0 &&
    bad.every((k) => {
      const spec = route.def.query[k]!;
      return PREFILL_KEYS.has(k) && spec.type === "text" && (search.get(k) ?? "").length > spec.max;
    })
  );
}

/** The line for this route, or null when the link was read in full. */
export function linkNoticeLine(route: Route): string | null {
  if (route.fallbackFrom) return "That link could not be read.";
  if (route.dropped && !onlyOverCapPrefill(route)) return "Part of that link could not be read.";
  return null;
}

/**
 * The one 5.4 line a chat's conversation shows for its route (principle 0: one line at most). `own`: the line about
 * the path's own target (a message or block that is gone, a card that does not wait on that path), which shows alone.
 * `elsewhere`: the path's target is not there and its line shows in another place (the archived composer's "This chat
 * is archived."), so none shows here. Else the router's line for a link that was not read in full.
 */
export function chatLinkLine(route: Route, own: string | null, elsewhere: boolean): string | null {
  if (own) return own;
  return elsewhere ? null : linkNoticeLine(route);
}

export function LinkNotice({ route }: { route: Route }) {
  const line = linkNoticeLine(route);
  return line ? (
    <p className="notice fallback-line" data-testid="link-notice">
      {line}
    </p>
  ) : null;
}
