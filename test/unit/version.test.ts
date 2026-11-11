// kitespan's version in step (DESIGN-I1 1.4): package.json's `version` passes the release rule; `kitespan --version`
// prints `kitespan <it>` and exits 0 before the start environment's check, as --help does, also through bin/kitespan;
// and a booted server's welcome.version and GET /api/settings server.version are the same. The server runs on the test
// port with a scratch HOME and XDG folders and the fake claude first on PATH; the test stops only the process it
// spawned, through its own handle.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { RELEASE_VERSION } from "../../shared/release";
import { pickTestPort } from "../click/ports";
import { installFakeClaude } from "../fake-claude/install";
import { readInto } from "./read-into";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const BIN = join(ROOT, "bin", "kitespan");
const PKG = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: unknown }).version;
/** What --version prints: package.json's version (the server's own fallback while it has none). */
const VERSION = typeof PKG === "string" ? PKG : "0.1.0";

const dir = mkdtempSync(join(tmpdir(), "kitespan-version-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fake = installFakeClaude({});
afterAll(() => fake.cleanup());

function cleanEnv(name: string, extra: Record<string, string> = {}): Record<string, string> {
  const base = join(dir, name);
  for (const d of ["home", "state", "config", "data", "tmp"]) mkdirSync(join(base, d), { recursive: true });
  return {
    PATH: `${fake.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(base, "home"),
    XDG_STATE_HOME: join(base, "state"),
    XDG_CONFIG_HOME: join(base, "config"),
    XDG_DATA_HOME: join(base, "data"),
    TMPDIR: join(base, "tmp"),
    SHELL: "/bin/sh",
    ...extra,
  };
}

function run(cmd: string[], env: Record<string, string>) {
  const r = Bun.spawnSync(cmd, { env, cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("the version", () => {
  test("package.json names one, and it passes the release rule (three numbers, nothing after them)", () => {
    if (typeof PKG !== "string") throw new Error('package.json has no "version" yet: PACKAGING adds "version": "0.1.0" right after "name" (DESIGN-I1 1.1)');
    expect(RELEASE_VERSION.test(PKG)).toBe(true);
  });

  test("--version prints `kitespan <version>` and exits 0, before the start environment's check; as a value it is the value", () => {
    const env = cleanEnv("flag");
    const want = { code: 0, out: `kitespan ${VERSION}\n`, err: "" };
    for (const args of [["--version"], ["--port", "7999", "--version"], ["--dist", "/nowhere", "--version"]]) expect(run([process.execPath, "--no-env-file", MAIN, ...args], env)).toEqual(want);
    // A start environment that bin/kitespan did not clean, and no --no-env-file: it starts nothing, so it says it.
    expect(run([process.execPath, "--no-env-file", MAIN, "--version"], { ...env, CLAUDECODE: "1" })).toEqual(want);
    // --help wins when both are there; --version as --origin's value is that value.
    expect(run([process.execPath, "--no-env-file", MAIN, "--help", "--version"], env).out).toStartWith("Usage: bin/kitespan");
    expect(run([process.execPath, "--no-env-file", MAIN, "--origin", "--version"], env).err).toContain("--origin --version: not an exact origin");
    expect(run([process.execPath, "--no-env-file", MAIN, "--help"], env).out).toContain("\n  --version            print kitespan's version\n");
  }, 60_000);

  test("through bin/kitespan too, which passes it on unchanged", () => {
    expect(run([BIN, "--version"], cleanEnv("bin"))).toEqual({ code: 0, out: `kitespan ${VERSION}\n`, err: "" });
  }, 30_000);
});

describe("a booted server says the same version", () => {
  const PORT = pickTestPort();
  const OWN = `http://127.0.0.1:${PORT}`;
  let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let out = "";

  beforeAll(async () => {
    const env = cleanEnv("boot");
    const dist = join(dir, "boot", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>kitespan</title>");
    proc = Bun.spawn([process.execPath, "--no-env-file", MAIN, "--port", String(PORT), "--dist", dist], { env, cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    // Read from the first byte to the end by one reader (test/unit/read-into.ts), so no chunk is lost.
    await readInto(proc.stdout as ReadableStream<Uint8Array>, (s) => (out += s)).until(() => out.includes(`kitespan listens on ${OWN}`), 20_000);
  }, 25_000); // its own wait is 20 s, past the hook's 5 s default

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      proc.kill("SIGTERM");
      const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
      if (!done && proc.exitCode === null) proc.kill("SIGKILL");
      await proc.exited;
    }
  }, 20_000); // its own wait is 15 s

  test("welcome.version and GET /api/settings server.version are package.json's", async () => {
    expect(out).toContain(`kitespan listens on ${OWN}`);
    const s = (await (await fetch(`${OWN}/api/settings`)).json()) as { server: { version: string } };
    expect(s.server.version).toBe(VERSION);
    const welcome = await new Promise<{ t: string; version?: string }>((resolveIt, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: OWN } } as unknown as string[]);
      const timer = setTimeout(() => reject(new Error("no welcome")), 5_000);
      ws.onopen = () => ws.send(JSON.stringify({ t: "hello", v: 1, tab: "version-test" }));
      ws.onmessage = (m) => {
        clearTimeout(timer);
        ws.close();
        resolveIt(JSON.parse(String(m.data)));
      };
      ws.onerror = () => reject(new Error("refused"));
    });
    expect(welcome.t).toBe("welcome");
    expect(welcome.version).toBe(VERSION);
  });
});
