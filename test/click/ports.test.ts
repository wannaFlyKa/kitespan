// The test port a test binds (ports.ts pickTestPort): a port held by someone else (a reviewer's harness, another
// agent's server) is passed over, so `bun test` never fails on it or talks to that server; KITESPAN_TEST_PORT wins
// when it is set (its old name too, for one release: rename-names.test.ts); nothing outside 7941 to 7949 is ever taken.
import { afterEach, describe, expect, test } from "bun:test";
import { legacyEnvName } from "../../shared/legacy";
import { CLICK_PORTS, pickTestPort, portFree } from "./ports";

const OLD = legacyEnvName("KITESPAN_TEST_PORT")!;
const saved = { now: process.env.KITESPAN_TEST_PORT, old: process.env[OLD] };
afterEach(() => {
  if (saved.now === undefined) delete process.env.KITESPAN_TEST_PORT;
  else process.env.KITESPAN_TEST_PORT = saved.now;
  if (saved.old === undefined) delete process.env[OLD];
  else process.env[OLD] = saved.old;
});

describe("pickTestPort", () => {
  test("a held port is passed over for a free test port", () => {
    // A run that names its own port (KITESPAN_TEST_PORT, as CI and a shared host's runs do) binds that port only: the
    // other test ports may be another run's, so a stand-in probe passes over them without a bind.
    const own = saved.now ?? saved.old;
    delete process.env.KITESPAN_TEST_PORT;
    delete process.env[OLD];
    const free = own === undefined ? portFree : (p: number) => (p === Number(own) ? portFree(p) : true);
    const held = own === undefined ? CLICK_PORTS.find(portFree) : portFree(Number(own)) ? Number(own) : undefined;
    if (held === undefined) return; // every test port (or the run's own) is busy on this host: nothing to hold
    const s = Bun.listen({ hostname: "127.0.0.1", port: held, socket: { data() {} } });
    try {
      const p = pickTestPort(held, process.env, undefined, free);
      expect(p).not.toBe(held);
      expect(CLICK_PORTS).toContain(p);
    } finally {
      s.stop(true);
    }
    expect(pickTestPort(held, process.env, undefined, free)).toBe(held);
  });

  test("KITESPAN_TEST_PORT wins, and must be a test port", () => {
    delete process.env[OLD];
    process.env.KITESPAN_TEST_PORT = "7949";
    expect(pickTestPort(7942)).toBe(7949);
    process.env.KITESPAN_TEST_PORT = "7940";
    expect(() => pickTestPort()).toThrow(/another app/);
    process.env.KITESPAN_TEST_PORT = "8080";
    expect(() => pickTestPort()).toThrow(/not a test port/);
  });
});
