// A project's last command list as projects.json keeps it (D59; types.ts ProjectCommandsRecord). It is a cache of what
// Claude Code reported, so it is read defensively: anything that is not exactly such a record reads as none (and the
// projects file is never set aside for it). A write keeps what the read takes back: a row whose name cannot be a
// command is dropped, long texts are cut, and the list is cut to its rows and its JSON budget, in Claude Code's order.

import { CONTROL_CHARS, LIMITS, capText, type CommandInfo } from "../../shared/protocol";
import { STORE_LIMITS, type ProjectCommandsRecord } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** A name or an alias: 1 to 120 characters, no control character (a menu row's label). */
const isLabel = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= LIMITS.name && !CONTROL_CHARS.test(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length <= LIMITS.taskText;
/** A time as toISOString() writes it. */
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;

/** One row exactly as a write leaves it, else null. */
function rowFrom(v: unknown): CommandInfo | null {
  if (!isObj(v)) return null;
  const name = own(v, "name");
  const description = own(v, "description");
  const argumentHint = own(v, "argumentHint");
  const aliases = own(v, "aliases");
  const builtin = own(v, "builtin");
  const terminalOnly = own(v, "terminalOnly");
  if (!isLabel(name) || !isText(description) || !isText(argumentHint)) return null;
  if (!Array.isArray(aliases) || aliases.length > STORE_LIMITS.commandAliases || !aliases.every(isLabel)) return null;
  if (typeof builtin !== "boolean" || typeof terminalOnly !== "boolean") return null;
  return { name, description, argumentHint, aliases: [...aliases], builtin, terminalOnly };
}

/** The kept list of a project record, or undefined when the value is not exactly one (never throws). */
export function projectCommandsFrom(v: unknown): ProjectCommandsRecord | undefined {
  if (!isObj(v)) return undefined;
  const at = own(v, "at");
  const list = own(v, "list");
  if (!isTime(at) || !Array.isArray(list) || list.length > STORE_LIMITS.projectCommands) return undefined;
  const rows: CommandInfo[] = [];
  for (const r of list) {
    const row = rowFrom(r);
    if (!row) return undefined;
    rows.push(row);
  }
  if (Buffer.byteLength(JSON.stringify({ at, list: rows })) > STORE_LIMITS.projectCommandsBytes) return undefined;
  return { at, list: rows };
}

/** The record a write keeps for `list`, read at `at` (an ISO time). */
export function projectCommandsForSave(list: readonly CommandInfo[], at: string): ProjectCommandsRecord {
  const rows: CommandInfo[] = [];
  // The JSON of `{"at":"...","list":[]}`, then each row and its comma.
  let bytes = Buffer.byteLength(JSON.stringify({ at, list: [] }));
  for (const c of list) {
    if (rows.length >= STORE_LIMITS.projectCommands) break;
    if (!isObj(c) || !isLabel(c.name)) continue;
    const row: CommandInfo = {
      name: c.name,
      description: capText(typeof c.description === "string" ? c.description : "", LIMITS.taskText),
      argumentHint: capText(typeof c.argumentHint === "string" ? c.argumentHint : "", LIMITS.taskText),
      aliases: (Array.isArray(c.aliases) ? c.aliases : []).filter(isLabel).slice(0, STORE_LIMITS.commandAliases),
      builtin: c.builtin === true,
      terminalOnly: c.terminalOnly === true,
    };
    const size = Buffer.byteLength(JSON.stringify(row)) + (rows.length > 0 ? 1 : 0);
    if (bytes + size > STORE_LIMITS.projectCommandsBytes) break;
    bytes += size;
    rows.push(row);
  }
  return { at, list: rows };
}

/** The same list (every row and every field), whatever the times. */
export function sameCommands(a: readonly CommandInfo[], b: readonly CommandInfo[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}
