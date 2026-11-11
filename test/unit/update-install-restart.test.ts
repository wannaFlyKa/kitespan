// The restart of an installed kitespan (DESIGN-I1 3.5): the preflight reads T, the root that the next start runs
// (kind.ts nextRoot): T's page and a stamp that reads (any head), else "The update did not finish"; for T the running
// root, the server's own build folder's; then T's own server code with --check, in T, with the server's options less a
// --dist of the running root's own build folder. The successor is T's bin/kitespan, in T, with the same options and the
// port wait. Fake roots: a server/main.ts and a bin/kitespan that record their arguments and working folder.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight, PREFLIGHT_LINES } from "../../server/update/preflight";
import { ownOptions, spawnSuccessor, successorArgv } from "../../server/update/successor";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-install-restart-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

/** A fake version folder: server/main.ts records its argv and cwd (exit `code`), bin/kitespan too; the page unless `page` is false. */
function fakeRoot(name: string, o: { page?: boolean; stamp?: string | null; code?: number } = {}): string {
  const dir = join(ROOT, `case-${n}`, name);
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(
    join(dir, "server", "main.ts"),
    `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "check.json"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exit(${o.code ?? 0});\n`,
  );
  writeFileSync(join(dir, "bin", "kitespan"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\npwd -P > '${dir}/cwd'\n`);
  chmodSync(join(dir, "bin", "kitespan"), 0o755);
  if (o.page !== false) {
    mkdirSync(join(dir, "dist", "web"), { recursive: true });
    writeFileSync(join(dir, "dist", "web", "index.html"), "page");
    if (o.stamp !== undefined) writeFileSync(join(dir, "dist", "web", "build.json"), o.stamp === null ? "not json" : o.stamp);
    else writeFileSync(join(dir, "dist", "web", "build.json"), `${JSON.stringify({ v: 1, head: null })}\n`);
  }
  return dir;
}

function logsDir(): string {
  const d = join(ROOT, `case-${n}`, "logs");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

const ENV = { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home" };

describe("the options: a --dist of the running root's own build folder is left out", () => {
  test("absolute, relative or through a link; another --dist stays", () => {
    n++;
    const root = fakeRoot("0.1.0");
    const own = join(root, "dist", "web");
    expect(ownOptions(["--port", "7948", "--dist", own], "/", own)).toEqual({ dev: false, options: ["--port", "7948"] });
    expect(ownOptions(["--dist", "dist/web", "--port", "7948"], root, own)).toEqual({ dev: false, options: ["--port", "7948"] });
    symlinkSync(root, join(ROOT, `case-${n}`, "link"));
    expect(ownOptions(["--dist", join(ROOT, `case-${n}`, "link", "dist", "web")], "/", own)).toEqual({ dev: false, options: [] });
    expect(ownOptions(["--dist", "/srv/other/web"], "/", own)).toEqual({ dev: false, options: ["--dist", "/srv/other/web"] });
    // A checkout passes none: every --dist stays, as before.
    expect(ownOptions(["--dist", own], "/")).toEqual({ dev: false, options: ["--dist", own] });
    expect(successorArgv("/v/0.2.0", ["--port", "7948", "--dist", own, "--bind-wait", "10"], "/", undefined, own)).toEqual(["/v/0.2.0/bin/kitespan", "--port", "7948", "--bind-wait", "10"]);
  });
});

describe("the preflight of an install", () => {
  test("T another version: its page and stamp, then T's own --check in T, without the running root's --dist", async () => {
    n++;
    const running = fakeRoot("0.1.0");
    const next = fakeRoot("0.2.0");
    const argv = ["--port", "7948", "--dist", join(running, "dist", "web"), "--origin", "https://box.example.com"];
    const line = await preflight({ root: running, dist: join(running, "dist", "web"), dev: false, argv, cwd: "/", env: ENV, git: { git: null, env: {} }, logs: logsDir(), bun: process.execPath, install: { next } });
    expect(line).toBeNull();
    expect(JSON.parse(readFileSync(join(next, "check.json"), "utf8"))).toEqual({ argv: ["--check", "--port", "7948", "--origin", "https://box.example.com"], cwd: next });
  });

  test("T unreadable, T with no page or with a stamp that does not read: the update did not finish; nothing runs", async () => {
    n++;
    const running = fakeRoot("0.1.0");
    const base = { root: running, dist: join(running, "dist", "web"), dev: false, argv: ["--port", "7948"], cwd: "/", env: ENV, git: { git: null, env: {} }, logs: logsDir(), bun: process.execPath };
    expect(await preflight({ ...base, install: { next: null } })).toBe(PREFLIGHT_LINES.unfinished);
    expect(PREFLIGHT_LINES.unfinished).toBe("The update did not finish. Update again first.");
    const bare = fakeRoot("0.2.0", { page: false });
    expect(await preflight({ ...base, install: { next: bare } })).toBe(PREFLIGHT_LINES.unfinished);
    const badStamp = fakeRoot("0.3.0", { stamp: null });
    expect(await preflight({ ...base, install: { next: badStamp } })).toBe(PREFLIGHT_LINES.unfinished);
    // Any head: a stamp of a checkout's build reads too.
    const headed = fakeRoot("0.4.0", { stamp: `${JSON.stringify({ v: 1, head: "a".repeat(40) })}\n` });
    expect(await preflight({ ...base, install: { next: headed } })).toBeNull();
    for (const t of [bare, badStamp]) expect(() => readFileSync(join(t, "check.json"))).toThrow();
  });

  test("T the running root: the server's own build folder; a failed --check of T refuses; an update that runs refuses first", async () => {
    n++;
    const running = fakeRoot("0.1.0");
    const base = { root: running, dist: join(running, "dist", "web"), dev: false, argv: ["--port", "7948"], cwd: "/", env: ENV, git: { git: null, env: {} }, logs: logsDir(), bun: process.execPath };
    expect(await preflight({ ...base, install: { next: running } })).toBeNull();
    expect(JSON.parse(readFileSync(join(running, "check.json"), "utf8")).cwd).toBe(running);
    const failing = fakeRoot("0.2.0", { code: 1 });
    expect(await preflight({ ...base, install: { next: failing } })).toBe(PREFLIGHT_LINES.check);
    expect(await preflight({ ...base, install: { next: failing }, updating: async () => true })).toBe(PREFLIGHT_LINES.updating);
  });
});

describe("the successor of an install", () => {
  test("T's own bin/kitespan, in T, with the server's options less the running root's --dist, and the port wait", async () => {
    n++;
    const running = fakeRoot("0.1.0");
    const next = fakeRoot("0.2.0");
    const s = spawnSuccessor({ root: next, argv: ["--port", "7948", "--dist", join(running, "dist", "web")], cwd: "/", env: ENV, logs: logsDir(), dropDist: join(running, "dist", "web") });
    expect(await s.exited).toBe(0);
    expect(readFileSync(join(next, "args"), "utf8").split("\n").filter(Boolean)).toEqual(["--port", "7948", "--bind-wait", "10"]);
    expect(readFileSync(join(next, "cwd"), "utf8").trim()).toBe(next);
  });
});
