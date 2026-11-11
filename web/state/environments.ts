// Row 99 on the page: the order steps of an environment's Move up, Move down and a heading's drop, as the `before` of
// one move request (the project it goes just before, null: last; server/chats/environments.ts), and the leave of the
// pages of an environment that the server removes (to /, with no line: the chats' `gone` comes after). A filtered view
// shows some environments only, so a step goes past the next one shown, wherever the hidden ones are.

import { navigate, parse, type Route } from "../router";

/** The list with `id` moved just before `before` (null: last): the page's order until the server's answer. */
export function reordered<T extends { id: string }>(list: readonly T[], id: string, before: string | null): T[] {
  const moving = list.find((p) => p.id === id);
  if (!moving || before === id) return [...list];
  const rest = list.filter((p) => p.id !== id);
  const at = before === null ? -1 : rest.findIndex((p) => p.id === before);
  if (at < 0) return [...rest, moving];
  return [...rest.slice(0, at), moving, ...rest.slice(at)];
}

/** The `before` that puts `id` just after the shown environment `after` (null: last). */
function justAfter(all: readonly string[], after: string): string | null {
  return all[all.indexOf(after) + 1] ?? null;
}

/**
 * Move up (-1) or Move down (+1) among the environments the list shows (`shown`, in the order of `all`): the move's
 * `before`, or undefined when it cannot go that way (the first one up, the last one down).
 */
export function stepBefore(all: readonly string[], shown: readonly string[], id: string, dir: -1 | 1): string | null | undefined {
  const i = shown.indexOf(id);
  if (i < 0) return undefined;
  if (dir < 0) return i > 0 ? shown[i - 1] : undefined;
  const next = shown[i + 1];
  return next === undefined ? undefined : justAfter(all, next);
}

/**
 * A drop of `id`'s heading at gap `gap` of the shown headings (0: above the first, shown.length: below the last): the
 * move's `before`, or undefined when the drop leaves it where it is.
 */
export function dropBefore(all: readonly string[], shown: readonly string[], id: string, gap: number): string | null | undefined {
  const i = shown.indexOf(id);
  if (i < 0 || gap < 0 || gap > shown.length || gap === i || gap === i + 1) return undefined;
  return gap < shown.length ? shown[gap]! : justAfter(all, shown[shown.length - 1]!);
}

/** The gap a pointer at `y` points to: how many headings' middles are above it. */
export function gapAt(y: number, middles: readonly number[]): number {
  return middles.filter((m) => m < y).length;
}

/** The route shows the environment `id` or one of its chats (its page, its Rename, Remove, a session, /new in it). */
export function onEnvironment(route: Pick<Route, "name" | "params" | "query">, id: string, chats: readonly string[]): boolean {
  if (route.params.project === id) return true;
  if (route.params.chat !== undefined && chats.includes(route.params.chat)) return true;
  return route.name === "new" && route.query.project === id;
}

/** The server removes the environment `id`: a page that shows it or one of its chats goes to /, with no line. */
export function leaveRemoved(id: string, chats: readonly string[]): void {
  if (typeof location === "undefined") return;
  if (onEnvironment(parse(new URL(location.href)), id, chats)) navigate("/", { replace: true });
}
