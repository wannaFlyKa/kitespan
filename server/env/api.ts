// D60's API (build checklist E5; R-env 5.8), wired into server/http/api.ts:
//
//   GET  /api/projects/:project/env                                  -> EnvReply
//   POST /api/projects/:project/env  {set, remove, discardUnreadable?} -> EnvReply, or 400 with `lines`
//
// The answers hold names, times and whether the user's own Claude Code settings set the same name (their value wins);
// never a value or a value's length. A save is checked whole (server/env/store.ts) and writes nothing on any problem;
// each refused line is its index in `set` and a fixed code (-1: the whole environment). No name is ever in a path.

import type { EnvVar } from "../agents/types";
import type { EnvChange, EnvStore } from "./store";

export const ENV_ROUTE = "/api/projects/:project/env";

/** The line of a refused save; the page names each line's problem from its code. */
export const ENV_NOT_SAVED = "The variables were not saved.";

/** One variable as a page sees it. */
export interface EnvVarView {
  name: string;
  /** When the user saved it (ISO 8601 UTC). */
  at: string;
  /** The user's own Claude Code settings `env` sets this name too, and their value wins. */
  inSettings: boolean;
}

/** GET's answer, and a save's. */
export interface EnvReply {
  vars: EnvVarView[];
  /** The environment's file could not be read, so its chats do not start (L39). */
  unreadable: boolean;
}

/** What the routes use of the environment store. */
export type EnvBook = Pick<EnvStore, "vars" | "view" | "count" | "change">;

const objOf = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));

/**
 * The POST's body as a change, or null when its shape is wrong (a plain 400): `set` a list of `{name, value}` strings,
 * `remove` a list of strings, `discardUnreadable` true or absent; nothing else. The names and values themselves are
 * the store's to check, line by line.
 */
export function envChangeOf(body: unknown): EnvChange | null {
  const o = objOf(body);
  if (!o || !onlyKeys(o, ["set", "remove", "discardUnreadable"])) return null;
  const set = o.set ?? [];
  const remove = o.remove ?? [];
  if (!Array.isArray(set) || !Array.isArray(remove)) return null;
  if (o.discardUnreadable !== undefined && o.discardUnreadable !== true) return null;
  const vars: EnvVar[] = [];
  for (const item of set) {
    const v = objOf(item);
    if (!v || !onlyKeys(v, ["name", "value"]) || typeof v.name !== "string" || typeof v.value !== "string") return null;
    vars.push({ name: v.name, value: v.value });
  }
  if (!remove.every((n) => typeof n === "string")) return null;
  return { set: vars, remove: remove as string[], discardUnreadable: o.discardUnreadable === true };
}

/** The answer for a project: its names, each with `inSettings` from `settingsNames` (a failed read marks none). */
export async function envReply(env: EnvBook, project: string, settingsNames: () => Promise<readonly string[]>): Promise<EnvReply> {
  const view = env.view(project);
  const inSettings = new Set(view.vars.length > 0 ? await settingsNames().catch(() => []) : []);
  return { vars: view.vars.map((v) => ({ name: v.name, at: v.at, inSettings: inSettings.has(v.name) })), unreadable: view.unreadable };
}
