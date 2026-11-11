// Row 97: the account provider and the start facts (fast mode, skills, plugins, output style) that a live chat's Claude
// Code last reported, as projects.json keeps them with a project (ProjectRecord.account and .facts). Caches of what
// Claude Code reported, read defensively as the model list is (store/models.ts): anything that is not exactly such a
// value reads as none, and never sets the projects file aside. A write keeps what the read takes back (the session
// event's own caps, events.ts loadedFacts). No string that starts with "arn:" is kept (isProviderArn: a provider's
// resource name holds the account id).

import { CONTROL_CHARS, FAST_MODE_STATES, LIMITS, type FastModeInfo, type PluginInfo } from "../../shared/protocol";
import { isProviderArn } from "../agents/types";
import type { KeptAccount, KeptFacts } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
/** A name as the session event carries it: 1 to `max` characters, no control character, never an ARN. */
const isText = (v: unknown, max: number = LIMITS.name): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !CONTROL_CHARS.test(v) && !isProviderArn(v);
const textOrNull = (v: unknown, max?: number): v is string | null => v === null || isText(v, max);

/** A project's kept provider, or undefined when the value is not exactly one (never throws). */
export function keptAccountFrom(v: unknown): KeptAccount | undefined {
  if (!isObj(v)) return undefined;
  const at = own(v, "at");
  const provider = own(v, "provider");
  return isTime(at) && textOrNull(provider) ? { at, provider } : undefined;
}

function fastModeFrom(v: unknown): FastModeInfo | null | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const state = own(v, "state");
  const reason = own(v, "reason");
  if (!(FAST_MODE_STATES as readonly unknown[]).includes(state) || !textOrNull(reason)) return undefined;
  return { state: state as FastModeInfo["state"], reason };
}

/** A project's kept start facts, or undefined when the value is not exactly such a record (never throws). */
export function keptFactsFrom(v: unknown): KeptFacts | undefined {
  if (!isObj(v)) return undefined;
  const at = own(v, "at");
  const fastMode = fastModeFrom(own(v, "fastMode"));
  const skills = own(v, "skills");
  const plugins = own(v, "plugins");
  const outputStyle = own(v, "outputStyle");
  if (!isTime(at) || fastMode === undefined || !textOrNull(outputStyle)) return undefined;
  if (!Array.isArray(skills) || skills.length > LIMITS.loaded || !skills.every((s) => isText(s))) return undefined;
  if (!Array.isArray(plugins) || plugins.length > LIMITS.loaded) return undefined;
  const list: PluginInfo[] = [];
  for (const p of plugins) {
    if (!isObj(p)) return undefined;
    const name = own(p, "name");
    const version = own(p, "version");
    if (!isText(name) || !textOrNull(version, LIMITS.pluginVersion)) return undefined;
    list.push({ name, version });
  }
  return { at, fastMode, skills: [...skills], plugins: list, outputStyle };
}
