// Claude Code's model list as projects.json keeps it with a project (row 81; types.ts ProjectModelsRecord). It is a cache
// of what Claude Code reported, so it is read defensively, as a project's command list is (store/commands.ts): anything
// that is not exactly such a record reads as none, and the projects file is never set aside for it. A write keeps what
// the read takes back: a row whose value cannot be a model is dropped, long texts are cut, unknown effort levels are
// left out, and the list is cut to its rows and its JSON budget, in Claude Code's order. Row 95: a provider's ARN in a
// row's name or description (the default row's names the model it resolves to) reads as "[an ARN]", on a write and on
// a read of an older file.

import { CONTROL_CHARS, EFFORT_IDS, LIMITS, capText, type EffortId, type ModelInfo } from "../../shared/protocol";
import { isProviderArn, maskArns } from "../agents/types";
import { STORE_LIMITS, type ProjectModelsRecord } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const CONTROL_ALL = new RegExp(CONTROL_CHARS.source, "g");

/** A model value: 1 to 120 characters, no control character (what set_model and new_chat send), never an ARN (row 95). */
const isValue = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= LIMITS.name && !CONTROL_CHARS.test(v) && !isProviderArn(v);
/** A row's name: at most 120 characters, no control character. */
const isName = (v: unknown): v is string => typeof v === "string" && v.length <= LIMITS.name && !CONTROL_CHARS.test(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length <= LIMITS.taskText;
const isEffort = (v: unknown): v is EffortId => typeof v === "string" && (EFFORT_IDS as readonly string[]).includes(v);
/** A time as toISOString() writes it. */
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;

/** One row exactly as a write leaves it, else null. */
function rowFrom(v: unknown): ModelInfo | null {
  if (!isObj(v)) return null;
  const value = own(v, "value");
  const displayName = own(v, "displayName");
  const description = own(v, "description");
  const efforts = own(v, "efforts");
  const supportsAutoMode = own(v, "supportsAutoMode");
  if (!isValue(value) || !isName(displayName) || !isText(description) || typeof supportsAutoMode !== "boolean") return null;
  if (!Array.isArray(efforts) || !efforts.every(isEffort) || new Set(efforts).size !== efforts.length) return null;
  return { value, displayName: maskArns(displayName), description: maskArns(description), efforts: [...efforts], supportsAutoMode };
}

/** The kept model list of a project record, or undefined when the value is not exactly one (never throws). */
export function projectModelsFrom(v: unknown): ProjectModelsRecord | undefined {
  if (!isObj(v)) return undefined;
  const at = own(v, "at");
  const list = own(v, "list");
  if (!isTime(at) || !Array.isArray(list) || list.length > STORE_LIMITS.projectModels) return undefined;
  const rows: ModelInfo[] = [];
  for (const r of list) {
    const row = rowFrom(r);
    if (!row) return undefined;
    rows.push(row);
  }
  if (Buffer.byteLength(JSON.stringify({ at, list: rows })) > STORE_LIMITS.projectModelsBytes) return undefined;
  return { at, list: rows };
}

/** The record a write keeps for `list`, read at `at` (an ISO time). */
export function projectModelsForSave(list: readonly ModelInfo[], at: string): ProjectModelsRecord {
  const rows: ModelInfo[] = [];
  // The JSON of `{"at":"...","list":[]}`, then each row and its comma.
  let bytes = Buffer.byteLength(JSON.stringify({ at, list: [] }));
  for (const m of list) {
    if (rows.length >= STORE_LIMITS.projectModels) break;
    if (!isObj(m) || !isValue(m.value)) continue;
    const efforts = Array.isArray(m.efforts) ? m.efforts.filter(isEffort) : [];
    const row: ModelInfo = {
      value: m.value,
      displayName: capText(typeof m.displayName === "string" ? maskArns(m.displayName.replace(CONTROL_ALL, " ")) : "", LIMITS.name),
      description: capText(typeof m.description === "string" ? maskArns(m.description) : "", LIMITS.taskText),
      efforts: [...new Set(efforts)],
      supportsAutoMode: m.supportsAutoMode === true,
    };
    const size = Buffer.byteLength(JSON.stringify(row)) + (rows.length > 0 ? 1 : 0);
    if (bytes + size > STORE_LIMITS.projectModelsBytes) break;
    bytes += size;
    rows.push(row);
  }
  return { at, list: rows };
}

/** The same list (every row and every field), whatever the times. */
export function sameModels(a: readonly ModelInfo[], b: readonly ModelInfo[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}
