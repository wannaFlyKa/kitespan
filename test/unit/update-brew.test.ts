// A kitespan that Homebrew installed (DESIGN-I1 3.2, 3.3, 3.5, 3.7; server/update/brew.ts): no check ever (no read, no
// timer, no update.json), the Update button and bin/update.sh refuse with the line that names `brew upgrade kitespan`,
// and once `brew upgrade` moves the opt link to a new keg, About's facts say Restart to apply with its version.

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_REFUSAL_LINES, UPDATE_WORDS } from "../../shared/update";
import { brewSource } from "../../server/update/brew";
import { runUpdate } from "../../server/update/cli";
import { createUpdateJobs } from "../../server/update/job";
import { installKind, nextRoot } from "../../server/update/kind";
import { createUpdates, UPDATE_STATE } from "../../server/update/updates";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-update-brew-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

/** <prefix>/Cellar/kitespan/<v>/libexec (built unless `page` is false) with its receipt; opt names the first. */
function cellar(kegs: { v: string; page?: boolean }[]) {
  const prefix = join(ROOT, `prefix-${++n}`);
  const libexec = (v: string) => join(prefix, "Cellar", "kitespan", v, "libexec");
  for (const k of kegs) {
    const dir = libexec(k.v);
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "kitespan", version: k.v }));
    writeFileSync(join(prefix, "Cellar", "kitespan", k.v, "INSTALL_RECEIPT.json"), "{}");
    if (k.page !== false) {
      mkdirSync(join(dir, "dist", "web"), { recursive: true });
      writeFileSync(join(dir, "dist", "web", "index.html"), "page");
      writeFileSync(join(dir, "dist", "web", "build.json"), `${JSON.stringify({ v: 1, head: null })}\n`);
    }
  }
  mkdirSync(join(prefix, "opt"), { recursive: true });
  const optTo = (v: string) => {
    try {
      unlinkSync(join(prefix, "opt", "kitespan"));
    } catch {
      // none yet
    }
    symlinkSync(`../Cellar/kitespan/${v}`, join(prefix, "opt", "kitespan"));
  };
  optTo(kegs[0]!.v);
  return { prefix, libexec, optTo };
}

describe("Homebrew installed it: no check, ever", () => {
  test("start() sets no timer, check() reads nothing and writes no update.json, Check now gives the facts as they are", async () => {
    const c = cellar([{ v: "0.1.0" }]);
    const install = installKind(c.libexec("0.1.0"), "0.1.0");
    expect(install.kind).toBe("brew");
    const state = join(ROOT, `state-${++n}`);
    mkdirSync(state, { mode: 0o700 });
    let reads = 0;
    const u = await createUpdates({
      root: install.root,
      dist: join(install.root, "dist", "web"),
      dev: false,
      git: { git: null, env: {} },
      state,
      setting: async () => "3h",
      kind: "brew",
      next: () => nextRoot(install),
      checkOnce: async () => {
        reads++;
        return { kind: "available", failed: false };
      },
      now: () => Date.parse("2026-11-08T09:00:00.000Z"),
    });
    u.start();
    await u.settled();
    expect(u.next).toBeNull();
    expect(await u.check()).toBe("none");
    expect(u.checking).toBe(false);
    expect(u.last).toBeNull();
    expect(reads).toBe(0);
    expect(existsSync(join(state, UPDATE_STATE))).toBe(false);
    expect(await u.facts()).toEqual({ update: "none", build: "none", kind: "brew", latest: null, next: null });
    u.stop();
  });

  test("after `brew upgrade` moved opt: Restart to apply with the new keg's version; a keg with no page did not finish", async () => {
    const c = cellar([{ v: "0.1.0" }, { v: "0.1.1" }, { v: "0.1.2", page: false }]);
    const install = installKind(c.libexec("0.1.0"), "0.1.0");
    const u = await createUpdates({ root: install.root, dist: join(install.root, "dist", "web"), dev: false, git: { git: null, env: {} }, kind: "brew", next: () => nextRoot(install) });
    c.optTo("0.1.1");
    expect(await u.facts()).toEqual({ update: "none", build: "apply", kind: "brew", latest: null, next: "0.1.1" });
    c.optTo("0.1.2");
    expect(await u.facts()).toEqual({ update: "none", build: "unfinished", kind: "brew", latest: null, next: "0.1.2" });
    c.optTo("0.1.0");
    expect(await u.facts()).toEqual({ update: "none", build: "none", kind: "brew", latest: null, next: null });
  });
});

describe("Homebrew installed it: the Update button and bin/update.sh refuse", () => {
  test("the refusal's line names brew upgrade kitespan; the job starts nothing", async () => {
    expect(UPDATE_REFUSAL_LINES.brew).toBe("Homebrew installed this kitespan: update it with brew upgrade kitespan, then restart kitespan.");
    expect(UPDATE_WORDS.brewLine).toContain(UPDATE_WORDS.brewCommand);
    expect(await brewSource({ dev: false }).refusal()).toBe("brew");
    expect(await brewSource({ dev: true }).refusal()).toBe("dev");
    expect(await brewSource({ dev: false }).check()).toEqual({ kind: "none", failed: false });
    const state = join(ROOT, `state-${++n}`);
    mkdirSync(join(state, "logs"), { recursive: true, mode: 0o700 });
    const jobs = createUpdateJobs({ source: brewSource({ dev: false }), state, logs: join(state, "logs"), restarting: () => false });
    expect(await jobs.start()).toEqual({ ok: false, refusal: "brew", line: UPDATE_REFUSAL_LINES.brew });
    expect(jobs.view()).toEqual({ state: "idle" });
  });

  test("bin/update.sh's body: one line on stderr, `update.sh: ` and the refusal, exit 1", async () => {
    const c = cellar([{ v: "0.1.0" }]);
    const err: string[] = [];
    const out: string[] = [];
    const e = spyOn(process.stderr, "write").mockImplementation(((s: string) => (err.push(String(s)), true)) as typeof process.stderr.write);
    const o = spyOn(process.stdout, "write").mockImplementation(((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write);
    let code: number;
    try {
      code = await runUpdate(c.libexec("0.1.0"), [], { PATH: "/usr/bin:/bin", HOME: join(ROOT, "no-home") });
    } finally {
      e.mockRestore();
      o.mockRestore();
    }
    expect(code).toBe(1);
    expect(err).toEqual(["update.sh: Homebrew installed this kitespan: update it with brew upgrade kitespan, then restart kitespan.\n"]);
    expect(out).toEqual([]);
  });
});
