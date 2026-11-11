// D60 (build checklist E3, E4): the environment of a child that gets an environment's variables: the server's start
// environment (server/start-env-copy.ts, as bin/kitespan cleaned it, without the names the SDK writes into the server's
// own process.env), then the variables, in a fresh object. process.env is never written.

import type { EnvVar, Marked } from "../agents/types";
import { MARK_PHRASES, markOf } from "../agents/types";

/** `{...base, ...vars}` as a new object of strings (a name in both takes the variable's value). */
export function childEnv(base: Readonly<Record<string, string | undefined>>, vars: readonly EnvVar[] = []): Record<string, string> {
  const inherited = Object.entries(base).filter((e): e is [string, string] => typeof e[1] === "string");
  return Object.fromEntries([...inherited, ...vars.map((v): [string, string] => [v.name, v.value])]);
}

/** The variables as a start passes them, with the gate's mark (L43); null when there are none, so no env key goes. */
export function markedVars(vars: readonly EnvVar[], at: Date): Marked<EnvVar[]> | null {
  return vars.length > 0 ? { value: vars.map((v) => ({ name: v.name, value: v.value })), mark: markOf(MARK_PHRASES.env, at) } : null;
}
