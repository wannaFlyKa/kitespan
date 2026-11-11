// The test ports (DESIGN 8.2, D52) and the port a test binds. A module of its own, whose one import is shared/, so a
// test under test/web (checked with the DOM types) can pick its port without the harness and the fake claude.

import { readEnv } from "../../shared/legacy";

const sayOnStderr = (line: string) => void process.stderr.write(`${line}\n`);

/** The test ports; 7940 is the demo and is never used here. */
export const CLICK_PORTS: readonly number[] = [7941, 7942, 7943, 7944, 7945, 7946, 7947, 7948, 7949];
/** Ports that belong to other apps on the host: never touched, never even probed. */
export const FORBIDDEN_PORTS: readonly number[] = [7681, 7936, 7937, 7940];

export function checkPort(port: number): void {
  if (FORBIDDEN_PORTS.includes(port)) throw new Error(`port ${port} belongs to another app on this host; use one from 7941 to 7949`);
  if (!CLICK_PORTS.includes(port)) throw new Error(`port ${port} is not a test port; use one from 7941 to 7949`);
}

/** True when nothing holds the port on 127.0.0.1 (a short bind proves it). */
export function portFree(port: number): boolean {
  checkPort(port);
  try {
    const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * The port for a test that binds one: KITESPAN_TEST_PORT when it is set (a test port), else `prefer` when it is free,
 * else the first free test port from 7941 to 7949. So a reviewer's harness, or another agent's server, on a test port
 * never makes a test fail, and a test never talks to a server it did not start. The variable's old name is read for
 * one release, with one line on stderr that names it (shared/legacy.ts). `free` is the probe (its own test passes one).
 */
export function pickTestPort(
  prefer?: number,
  vars: Readonly<Record<string, string | undefined>> = process.env,
  say: (line: string) => void = sayOnStderr,
  free: (port: number) => boolean = portFree,
): number {
  const env = readEnv(vars, "KITESPAN_TEST_PORT", say);
  if (env) {
    const n = Number(env);
    checkPort(n);
    return n;
  }
  const order = prefer !== undefined ? [prefer, ...CLICK_PORTS.filter((p) => p !== prefer)] : [...CLICK_PORTS];
  for (const p of order) if (free(p)) return p;
  throw new Error("every test port from 7941 to 7949 is in use; set KITESPAN_TEST_PORT to one that is free");
}
