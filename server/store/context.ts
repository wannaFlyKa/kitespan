// Row 94: a chat's last live context read (NotesRecord.context) and each model's context window (ProjectRecord.
// contextWindows), as the notes and projects.json keep them. Both are caches of what Claude Code reported, read
// defensively as the model list is (store/models.ts): anything that is not exactly such a value reads as none, and
// never sets its file aside. A write keeps what the read takes back: long names cut, the parts and the windows cut to
// their caps. A provider's ARN is never a model id here (it holds the account id): a read with one reads as none.

import { CONTROL_CHARS, LIMITS, capText, type ContextInfo } from "../../shared/protocol";
import { isProviderArn } from "../agents/types";
import { STORE_LIMITS, type ContextNote } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const CONTROL_ALL = new RegExp(CONTROL_CHARS.source, "g");
const PART_KINDS = ["used", "free", "buffer", "deferred"] as const;

/** A count of tokens: a whole number from 0 to 2^53 - 1. */
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** A part's name: at most 120 characters, no control character. */
const isName = (v: unknown): v is string => typeof v === "string" && v.length <= LIMITS.name && !CONTROL_CHARS.test(v);
/** A model id: a name, never a provider's ARN (it holds the account id: never kept). */
const isModel = (v: unknown): v is string => isName(v) && v.length > 0 && !isProviderArn(v);
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;

function infoFrom(v: unknown): ContextInfo | undefined {
  if (!isObj(v)) return undefined;
  const model = own(v, "model");
  const usedTokens = own(v, "usedTokens");
  const maxTokens = own(v, "maxTokens");
  const percent = own(v, "percent");
  const parts = own(v, "parts");
  if (!(model === null || isModel(model)) || !isCount(usedTokens) || !isCount(maxTokens) || maxTokens === 0) return undefined;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  if (!Array.isArray(parts) || parts.length > STORE_LIMITS.contextParts) return undefined;
  const out: ContextInfo["parts"] = [];
  for (const p of parts) {
    if (!isObj(p)) return undefined;
    const name = own(p, "name");
    const tokens = own(p, "tokens");
    const kind = own(p, "kind");
    if (!isName(name) || !isCount(tokens) || !(PART_KINDS as readonly unknown[]).includes(kind)) return undefined;
    out.push({ name, tokens, kind: kind as ContextInfo["parts"][number]["kind"] });
  }
  return { model: model as string | null, usedTokens, maxTokens, percent, parts: out };
}

/** The notes' context read, or undefined when the value is not exactly one (never throws). */
export function contextNoteFrom(v: unknown): ContextNote | undefined {
  if (!isObj(v)) return undefined;
  const at = own(v, "at");
  const info = infoFrom(own(v, "info"));
  return isTime(at) && info ? { at, info } : undefined;
}

/** The note a write keeps for a live read that came at `at` (an ISO time); undefined for a read that cannot be one. */
export function contextNoteOf(info: ContextInfo, at: string): ContextNote | undefined {
  const name = (s: string) => capText(s.replace(CONTROL_ALL, " "), LIMITS.name);
  const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(n)) : 0);
  return contextNoteFrom({
    at,
    info: {
      model: typeof info.model === "string" && info.model && !isProviderArn(info.model) ? name(info.model) : null,
      usedTokens: count(info.usedTokens),
      maxTokens: count(info.maxTokens),
      percent: Number.isFinite(info.percent) ? Math.min(100, Math.max(0, info.percent)) : 0,
      parts: info.parts.slice(0, STORE_LIMITS.contextParts).map((p) => ({ name: name(p.name), tokens: count(p.tokens), kind: p.kind })),
    },
  });
}

/** A project's context windows (model id to tokens), or undefined when the value is not exactly such a map. */
export function contextWindowsFrom(v: unknown): Record<string, number> | undefined {
  if (!isObj(v)) return undefined;
  const keys = Object.keys(v);
  if (keys.length === 0 || keys.length > STORE_LIMITS.contextWindows) return undefined;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const n = v[k];
    if (!isModel(k) || !isCount(n) || n === 0) return undefined;
    out[k] = n;
  }
  return out;
}
