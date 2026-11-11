// Row 99: the sidebar's order of the projects (the environments). Until the user moves one, no project has an `order`
// and the last used comes first, as before. A move numbers every project in the order shown, with the one moved in its
// new place, so from then on the user's order holds on every device, and a project added later goes at the top. A
// project with no order among ordered ones (written by a kitespan from before) goes at the top too, the newest first.

import type { ProjectRecord } from "./types";

const byLastUse = (a: ProjectRecord, b: ProjectRecord) => (a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0);
const newestFirst = (a: ProjectRecord, b: ProjectRecord) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1);

/** The projects in the sidebar's order (a new list; the one given is left as it was). */
export function projectOrder(list: readonly ProjectRecord[]): ProjectRecord[] {
  if (!list.some((p) => p.order !== undefined)) return [...list].sort(byLastUse);
  const none = list.filter((p) => p.order === undefined).sort(newestFirst);
  const placed = list.filter((p) => p.order !== undefined).sort((a, b) => a.order! - b.order! || newestFirst(a, b));
  return [...none, ...placed];
}

/** The order of a project added now: none while no project has one, else one above the top. */
export function topOrder(list: readonly ProjectRecord[]): Pick<ProjectRecord, "order"> {
  const orders = list.flatMap((p) => (p.order === undefined ? [] : [p.order]));
  return orders.length ? { order: Math.min(...orders) - 1 } : {};
}

/**
 * One move: `id` goes just before `before` (null: to the end). Every project, in the new order, with `order` its place;
 * null when either project is not in the list, or `before` is `id` itself.
 */
export function movedOrder(list: readonly ProjectRecord[], id: string, before: string | null): ProjectRecord[] | null {
  if (before === id) return null;
  const shown = projectOrder(list);
  const moving = shown.find((p) => p.id === id);
  if (!moving || (before !== null && !shown.some((p) => p.id === before))) return null;
  const rest = shown.filter((p) => p.id !== id);
  const at = before === null ? rest.length : rest.findIndex((p) => p.id === before);
  rest.splice(at, 0, moving);
  return rest.map((p, i) => ({ ...p, order: i }));
}
