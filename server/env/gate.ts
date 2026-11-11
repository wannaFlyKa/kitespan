// The raw-options gate's `env` row (D60, build checklist G1, G2; R-env 4.3), called by checkOptions() in
// server/agents/claude/options.ts. The value must be exactly the server's start environment with the environment's
// stored variables over it: every start name with its own value unless the environment sets that name, every other
// name a stored one with its stored value, every stored variable present, no refused name (compared without case), no
// value with NUL, CR or LF. The snapshot form that last-options.json keeps holds names only: `{"[inherited]": true,
// "NAME": "[set]", ...}`. A problem line names no variable and holds no value.

import type { EnvVar } from "../agents/types";
import { nameProblem, setProblem, valueProblem } from "./names";

/** The two context fields the row needs (GateContext). */
export interface EnvGateContext {
  /** The server's start environment that a chat's `env` spreads (START_ENV); absent: `env` is refused. */
  startEnv?: Readonly<Record<string, string | undefined>>;
  /** The variables stored for the chat's environment, in the user's order; absent, null or empty: `env` is refused. */
  envVars?: readonly EnvVar[] | null;
}

const INHERITED = "[inherited]";
const SET = "[set]";

/** last-options.json's form of `env`: that the start environment was spread, and each stored name. */
export function envSnapshot(names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries([[INHERITED, true], ...names.map((n) => [n, SET])]);
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Every reason why `value` is not this environment's `env`, one line each; empty when it passes. */
export function envProblems(value: unknown, ctx: EnvGateContext): string[] {
  const vars = ctx.envVars;
  if (!vars || vars.length === 0) return [`"env" is passed for an environment with no variables`];
  const out: string[] = [];
  const stored = new Map<string, string>();
  for (const v of vars) {
    if (nameProblem(v.name) !== null) out.push(`"env" holds a name that kitespan refuses, or one that is not a name`);
    if (valueProblem(v.value) !== null) out.push(`"env" holds a value that is not one line of text within its limit`);
    if (stored.has(v.name)) out.push(`"env" names one variable twice`);
    stored.set(v.name, v.value);
  }
  if (setProblem(vars) !== null) out.push(`"env" holds more variables or bytes than an environment may`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [...out, `"env" is not an object of variables`];
  const env = value as Record<string, unknown>;

  if (env[INHERITED] === true) {
    // The snapshot: names only, exactly the stored ones.
    const names = Object.keys(env).filter((k) => k !== INHERITED);
    if (names.some((k) => !stored.has(k) || env[k] !== SET) || [...stored.keys()].some((k) => !has(env, k)))
      out.push(`"env" in a snapshot must hold "[inherited]" and each stored name as "[set]", and nothing else`);
    return out;
  }

  const base = ctx.startEnv;
  if (!base) return [...out, `"env" is passed, but the gate was not given the start environment`];
  if (Object.values(env).some((v) => typeof v !== "string")) out.push(`"env" is not an object of variables`);
  let dropped = false;
  for (const [k, v] of Object.entries(base)) if (typeof v === "string" && !stored.has(k) && (!has(env, k) || env[k] !== v)) dropped = true;
  if (dropped) out.push(`"env" drops or changes a variable of the server's start environment`);
  if (Object.keys(env).some((k) => !stored.has(k) && !(has(base, k) && typeof base[k] === "string"))) out.push(`"env" holds a variable that the environment does not store`);
  if ([...stored].some(([k, v]) => !has(env, k) || env[k] !== v)) out.push(`"env" leaves out or changes a variable that the environment stores`);
  return out;
}
