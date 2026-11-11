// bin/kitespan and bin/update.sh find their own folder through any link to them (DESIGN-I1 2.4): install.sh's
// ~/.local/bin/kitespan -> <kit>/current -> versions/<v>/bin/kitespan, Homebrew's bin.install_symlink, and a package
// runner's .bin link. Run through an absolute link, a relative one, a chain of them across folders, and a PATH lookup,
// `kitespan --help` and `--version` print kitespan's own, and `update.sh --bogus` is refused by cli.ts (so Bun ran each
// from the real root; with the old root line the start failed with "Module not found"). A chain longer than 32 links is
// refused with one line: the script's own, or the system's where the system itself does not open so long a chain. The
// real Bun runs; no server starts and no claude runs.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ROOT } from "../install/home";

const KITESPAN = join(ROOT, "bin", "kitespan");
const UPDATE = join(ROOT, "bin", "update.sh");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const DIR = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-link-")));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

for (const d of ["home", "config", "state", "tmp"]) mkdirSync(join(DIR, d));
const ENV = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: join(DIR, "home"),
  XDG_CONFIG_HOME: join(DIR, "config"),
  XDG_STATE_HOME: join(DIR, "state"),
  TMPDIR: join(DIR, "tmp"),
};
if (Bun.which("claude", { PATH: ENV.PATH }) !== null) throw new Error("a claude is on this test's PATH; it must never run");

/** A symbolic link at `at` (its folder made) to `to`. */
function link(at: string, to: string): string {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(to, at);
  return at;
}

function run(cmd: string[], env: Record<string, string> = ENV): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { cwd: DIR, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** True when the system itself refuses to open `path`: more links lead to it than its limit (ELOOP). */
function systemRefuses(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ELOOP";
  }
}

/**
 * A chain of 33 links to `script`. The script's own walk refuses it with its one line and exit 1: `sh -c` runs the
 * script's text with the chain as $0, so the walk runs on every system. Run through the chain itself, the script says
 * the same where the system opens a chain that long (Linux allows 40 links); where the system allows fewer (macOS
 * allows 32), sh cannot open the file at all, and its own one line names the chain, with exit 126.
 */
function tooMany(chain: string, script: string, arg: string, name: string): void {
  const own = { code: 1, out: "", err: `${name}: too many links lead to ${chain}\n` };
  expect(run(["/bin/sh", "-c", readFileSync(script, "utf8"), chain, arg])).toEqual(own);
  const r = run(["/bin/sh", chain, arg]);
  if (!systemRefuses(chain)) expect(r).toEqual(own);
  else {
    expect({ code: r.code, out: r.out }).toEqual({ code: 126, out: "" });
    expect(r.err.trim().split("\n")).toHaveLength(1);
    expect(r.err).toContain(chain);
  }
}

/** Each way to reach a script through links: the path that is run. */
function ways(script: string, name: string): [string, string][] {
  const abs = link(join(DIR, name, "abs", "bin", name), script);
  const rel = join(DIR, name, "rel", "bin", name);
  link(rel, relative(dirname(rel), script));
  // install.sh's own shape: an absolute link to <kit>/current, a relative link from there to versions/<v>/bin/<name>,
  // and that one an absolute link to the script (in place of the version folder's own file).
  const kit = join(DIR, name, "share", "kitespan");
  link(join(kit, "versions", "0.1.0", "bin", name), script);
  link(join(kit, "current"), `versions/0.1.0/bin/${name}`);
  const chain = link(join(DIR, name, "home", ".local", "bin", name), join(kit, "current"));
  return [
    ["an absolute link", abs],
    ["a relative link", rel],
    ["a chain of three across folders", chain],
  ];
}

describe("bin/kitespan through links", () => {
  for (const [what, path] of ways(KITESPAN, "kitespan")) {
    test(`${what}: --help and --version are kitespan's own`, () => {
      const help = run([path, "--help"]);
      expect({ code: help.code, err: help.err }).toEqual({ code: 0, err: "" });
      expect(help.out).toStartWith("Usage: bin/kitespan [dev] [options]\n");
      expect(run(["/bin/sh", path, "--version"])).toEqual({ code: 0, out: `kitespan ${VERSION}\n`, err: "" });
    });
  }

  test("found on PATH by its name", () => {
    const bin = link(join(DIR, "path", "bin", "kitespan"), join(DIR, "kitespan", "home", ".local", "bin", "kitespan"));
    const r = run(["/bin/sh", "-c", "kitespan --version"], { ...ENV, PATH: `${dirname(bin)}:${ENV.PATH}` });
    expect(r).toEqual({ code: 0, out: `kitespan ${VERSION}\n`, err: "" });
  });

  test("a chain of more than 32 links: one line, exit 1", () => {
    let to = KITESPAN;
    for (let i = 0; i < 33; i++) to = link(join(DIR, "long", String(i)), to);
    tooMany(to, KITESPAN, "--help", "kitespan");
  });
});

describe("bin/update.sh through links", () => {
  for (const [what, path] of ways(UPDATE, "update.sh")) {
    test(`${what}: cli.ts runs from the real root and refuses an unknown option`, () => {
      const r = run([path, "--bogus"]);
      expect(r.code).toBe(2);
      expect(r.err).toStartWith("update.sh: unknown option --bogus (usage: bin/update.sh [--dist <build folder>])");
    });
  }

  test("a chain of more than 32 links: one line, exit 1", () => {
    let to = UPDATE;
    for (let i = 0; i < 33; i++) to = link(join(DIR, "long-update", String(i)), to);
    tooMany(to, UPDATE, "--bogus", "update.sh");
  });
});
