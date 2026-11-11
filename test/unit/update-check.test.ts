// About's update lines (DESIGN.md 4.10; build checklist S3, S4, L18), in scratch repositories that no user or system
// git config reaches. "Update available" by the ancestor rule against a scratch bare origin: a commit that this clone
// lacks, a clone that is ahead, one that fetched and did not merge, one that diverged, and none with no upstream; git
// never prompts and never runs a program from the repository's config. The commit a read found, read again with no
// network (a restart, row 108). "Restart to apply" from the build stamp: its
// three states.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failingProgram, gitHead, gitOptions, updateGitEnv, type GitOptions } from "../../server/update/git";
import { checkRemote as checkWithOrigin, keptRemote, remoteUrlOk, type RemoteCheck } from "../../server/update/remote";
import { BUILD_STAMP, buildKind, readStamp, stampText } from "../../server/update/stamp";
import { createUpdates } from "../../server/update/updates";

const GIT = ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g)) ?? null;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-update-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const HOME = join(ROOT, "home");
mkdirSync(HOME);
const BASE = { PATH: "/usr/bin:/bin", HOME };
const ISOLATED = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const opts = (): GitOptions => gitOptions(BASE, ISOLATED, 5_000);
/** The check's line alone (the commit it read has a test of its own). */
const checkRemote = async (root: string, o: GitOptions): Promise<RemoteCheck> => {
  const { origin: _, ...r } = await checkWithOrigin(root, o);
  return r;
};

/** git for the test's own setup. */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(GIT!, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { env: { ...BASE, ...ISOLATED }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

let n = 0;
/** A bare origin with one commit on main, and a clone of it that tracks origin/main. */
function origin(): { bare: string; clone: (name?: string) => string } {
  const id = ++n;
  const bare = join(ROOT, `origin-${id}.git`);
  git(ROOT, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(ROOT, `seed-${id}`);
  git(ROOT, "clone", "-q", bare, seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", "a.txt");
  git(seed, "commit", "-q", "-m", "one");
  git(seed, "push", "-q", "origin", "HEAD:main");
  let k = 0;
  return {
    bare,
    clone: (name = `clone-${id}-${++k}`) => {
      const dir = join(ROOT, name);
      git(ROOT, "clone", "-q", bare, dir);
      return dir;
    },
  };
}

/** One more commit on origin's main, from a clone of its own. */
function pushNew(bare: string, file = "b.txt"): string {
  const dir = join(ROOT, `pusher-${++n}`);
  git(ROOT, "clone", "-q", bare, dir);
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", file);
  git(dir, "push", "-q", "origin", "HEAD:main");
  return git(dir, "rev-parse", "HEAD");
}

function commit(dir: string, file: string): string {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", file);
  return git(dir, "rev-parse", "HEAD");
}

describe.skipIf(!GIT)("Update available: the ancestor rule (S4)", () => {
  test("a commit of origin that this clone lacks: Update available", async () => {
    const o = origin();
    const dir = o.clone();
    pushNew(o.bare);
    expect(await checkRemote(dir, opts())).toEqual({ kind: "available", failed: false });
  });

  test("a clone that is ahead of origin (the owner's checkout): nothing", async () => {
    const o = origin();
    const dir = o.clone();
    commit(dir, "local.txt");
    commit(dir, "local2.txt");
    expect(await checkRemote(dir, opts())).toEqual({ kind: "none", failed: false });
  });

  test("the same commit as origin: nothing", async () => {
    const o = origin();
    expect(await checkRemote(o.clone(), opts())).toEqual({ kind: "none", failed: false });
  });

  test("origin's commit fetched and not merged yet: update.sh fast-forwards to it, so Update available", async () => {
    const o = origin();
    const dir = o.clone();
    pushNew(o.bare);
    git(dir, "fetch", "-q", "origin");
    expect(await checkRemote(dir, opts())).toEqual({ kind: "available", failed: false });
  });

  test("a known commit that is not an ancestor of HEAD, nor HEAD of it: diverged", async () => {
    const o = origin();
    const dir = o.clone();
    pushNew(o.bare);
    git(dir, "fetch", "-q", "origin");
    commit(dir, "mine.txt");
    expect(await checkRemote(dir, opts())).toEqual({ kind: "diverged", failed: false });
  });

  test("a read names origin's commit and ref; a start reads the line again from them with no network (row 108)", async () => {
    const o = origin();
    const dir = o.clone();
    const head = git(dir, "rev-parse", "HEAD");
    expect((await checkWithOrigin(dir, opts())).origin).toEqual({ commit: head, ref: "refs/heads/main" });
    const pushed = pushNew(o.bare);
    const read = await checkWithOrigin(dir, opts());
    expect(read).toEqual({ kind: "available", failed: false, origin: { commit: pushed, ref: "refs/heads/main" } });
    // Origin is gone now: the kept commit still says Update available, by the local objects alone.
    rmSync(o.bare, { recursive: true, force: true });
    expect(await keptRemote(dir, opts(), read.origin!)).toEqual(read);
    // Fetched and merged since (an update, a pull): nothing.
    git(dir, "fetch", "-q", join(ROOT, `pusher-${n}`), "HEAD");
    git(dir, "merge", "-q", "--ff-only", "FETCH_HEAD");
    expect(await keptRemote(dir, opts(), read.origin!)).toMatchObject({ kind: "none", failed: false });
    // Another upstream ref than the one it was read for: nothing until the next check.
    git(dir, "checkout", "-q", "-b", "topic");
    git(dir, "config", "branch.topic.remote", "origin");
    git(dir, "config", "branch.topic.merge", "refs/heads/topic");
    git(dir, "reset", "-q", "--hard", head);
    expect(await keptRemote(dir, opts(), read.origin!)).toEqual({ kind: "none", failed: false });
  });

  test("no upstream, a detached HEAD, a remote with no URL: nothing, and no failure; the reason, for Check now (row 108)", async () => {
    const o = origin();
    const dir = o.clone();
    git(dir, "checkout", "-q", "-b", "topic");
    expect(await checkRemote(dir, opts())).toEqual({ kind: "none", failed: false, why: "no_upstream" });
    git(dir, "checkout", "-q", "--detach", "main");
    expect(await checkRemote(dir, opts())).toEqual({ kind: "none", failed: false, why: "detached" });
    git(dir, "checkout", "-q", "main");
    git(dir, "config", "--unset", "remote.origin.url");
    expect(await checkRemote(dir, opts())).toEqual({ kind: "none", failed: false, why: "no_upstream" });
  });

  test("a read that fails (the origin is gone, or its branch is) shows nothing and counts as failed", async () => {
    const o = origin();
    const dir = o.clone();
    rmSync(o.bare, { recursive: true, force: true });
    expect(await checkRemote(dir, opts())).toEqual({ kind: "none", failed: true });
    const p = origin();
    const other = p.clone();
    git(other, "config", "branch.main.merge", "refs/heads/gone");
    expect(await checkRemote(other, opts())).toEqual({ kind: "none", failed: true });
  });

  test("not a git checkout, a folder inside one, or no git: nothing, with the reason", async () => {
    const plain = join(ROOT, "plain");
    mkdirSync(plain);
    expect(await checkRemote(plain, opts())).toEqual({ kind: "none", failed: false, why: "not_checkout" });
    expect(await checkRemote(plain, { ...opts(), git: null })).toEqual({ kind: "none", failed: false, why: "no_git" });
    const o = origin();
    const dir = o.clone();
    mkdirSync(join(dir, "inside"));
    expect(await checkRemote(join(dir, "inside"), opts())).toEqual({ kind: "none", failed: false, why: "not_checkout" });
  });

  test("no program from the repository's config runs: its upload-pack program, url rewrite, ssh command and fsmonitor", async () => {
    const o = origin();
    const dir = o.clone();
    pushNew(o.bare);
    const mark = join(ROOT, "ran-repo-program");
    const prog = join(ROOT, "planted.sh");
    writeFileSync(prog, `#!/bin/sh\necho ran >> '${mark}'\nexit 1\n`);
    chmodSync(prog, 0o755);
    git(dir, "config", "remote.origin.uploadpack", prog);
    git(dir, "config", "core.sshCommand", prog);
    git(dir, "config", "core.fsmonitor", prog);
    git(dir, "config", "credential.helper", `!${prog}`);
    git(dir, "config", `url.${join(ROOT, "nowhere")}/.insteadOf`, `${ROOT}/`);
    expect(await checkRemote(dir, opts())).toEqual({ kind: "available", failed: false });
    expect(existsSync(mark)).toBe(false);
  });

  test("a URL of a remote helper or another transport is never read", async () => {
    for (const bad of ["ext::sh -c touch% /tmp/x", "foo::bar", "fd://x", "-oProxyCommand=x", "a\nb", ""]) expect([bad, remoteUrlOk(bad)]).toEqual([bad, false]);
    for (const good of ["https://github.com/o/r.git", "ssh://git@host/r.git", "git@github.com:o/r.git", "/srv/git/r.git", "../r.git", "file:///srv/r.git", "/a path/with space.git"])
      expect([good, remoteUrlOk(good)]).toEqual([good, true]);
    const o = origin();
    const dir = o.clone();
    const mark = join(ROOT, "ran-ext");
    git(dir, "config", "remote.origin.url", `ext::sh -c touch% ${mark}`);
    expect(await checkRemote(dir, opts())).toEqual({ kind: "none", failed: false, why: "remote" });
    expect(existsSync(mark)).toBe(false);
  });

  test("git never prompts: no terminal prompt, password prompts that fail, ssh in batch mode, and no GIT_* of the server", () => {
    const env = updateGitEnv({ PATH: "/usr/bin:/bin:relative", HOME, GIT_DIR: "/elsewhere", GIT_ASKPASS: "/usr/bin/x-askpass", SSH_ASKPASS: "/usr/bin/x-askpass" });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    // Batch mode, and a peer that goes silent ends the read on ssh's own side too.
    expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=1");
    expect(env.GIT_ASKPASS).toBe(failingProgram("/usr/bin:/bin"));
    expect(env.SSH_ASKPASS).toBe(env.GIT_ASKPASS);
    expect(spawnSync(env.GIT_ASKPASS!, ["Password:"]).status).not.toBe(0);
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  test("the names that only choose git's config files stay, as the user's git reads them (row 108); no other GIT_*", () => {
    const env = updateGitEnv({ PATH: "/usr/bin:/bin", HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/etc/x", GIT_WORK_TREE: "/elsewhere", GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'" });
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_SYSTEM).toBe("/etc/x");
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  });
});

describe.skipIf(!GIT)("Restart to apply: the build stamp (S3)", () => {
  test("the stamp's form: the commit, or null outside a checkout; a bad or linked file reads as none", () => {
    const dist = join(ROOT, "dist-form");
    mkdirSync(dist);
    expect(readStamp(dist)).toBeNull();
    writeFileSync(join(dist, BUILD_STAMP), stampText("a".repeat(40)));
    expect(readStamp(dist)).toEqual({ head: "a".repeat(40) });
    writeFileSync(join(dist, BUILD_STAMP), stampText(null));
    expect(readStamp(dist)).toEqual({ head: null });
    for (const bad of ["{}", '{"v":1,"head":"HEAD"}', '{"v":2,"head":null}', "not json"]) {
      writeFileSync(join(dist, BUILD_STAMP), bad);
      expect(readStamp(dist)).toBeNull();
    }
  });

  test("three states in a scratch checkout: none, Restart to apply, and The update did not finish", async () => {
    const o = origin();
    const dir = o.clone();
    const dist = join(dir, "dist", "web");
    mkdirSync(dist, { recursive: true });
    const first = await gitHead(dir, opts());
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(dist, BUILD_STAMP), stampText(first));
    const updates = await createUpdates({ root: dir, dist, dev: false, git: opts() });
    expect(updates.runningHead).toBe(first);
    // The build is the checkout's and the running server's.
    expect((await updates.facts()).build).toBe("none");
    // update.sh pulled and built: the build is the checkout's, not the running server's.
    const second = commit(dir, "new.txt");
    writeFileSync(join(dist, BUILD_STAMP), stampText(second));
    expect((await updates.facts()).build).toBe("apply");
    // The checkout moved again, and the build did not (update.sh stopped at its install or its build).
    commit(dir, "newer.txt");
    expect((await updates.facts()).build).toBe("unfinished");
    // No stamp at all reads as a build that is not the checkout's.
    rmSync(join(dist, BUILD_STAMP));
    expect((await updates.facts()).build).toBe("unfinished");
  });

  test("dev mode serves the page from web/ itself: no build line", () => {
    expect(buildKind({ dev: true, stamp: null, checkout: "a".repeat(40), running: "b".repeat(40) })).toBe("none");
    expect(buildKind({ dev: false, stamp: { head: null }, checkout: null, running: null })).toBe("none");
  });
});

describe.skipIf(!GIT)("the checks over time (S4)", () => {
  test("welcome carries origin's line; each change goes to the listeners once", async () => {
    const o = origin();
    const dir = o.clone();
    const updates = await createUpdates({ root: dir, dist: join(dir, "dist"), dev: false, git: opts(), setting: async () => "manual" });
    const seen: string[] = [];
    updates.onChange((k) => seen.push(k));
    expect(updates.welcome()).toEqual({ available: false, kind: "none" });
    expect(await updates.check()).toBe("none");
    pushNew(o.bare);
    expect(await updates.check()).toBe("available");
    expect(await updates.check()).toBe("available");
    expect(updates.welcome()).toEqual({ available: true, kind: "available" });
    expect((await updates.facts()).update).toBe("available");
    git(dir, "pull", "-q", "--ff-only");
    expect(await updates.check()).toBe("none");
    expect(seen).toEqual(["available", "none"]);
  });

  test("a failed read logs the error code only", async () => {
    const o = origin();
    const dir = o.clone();
    rmSync(o.bare, { recursive: true, force: true });
    const lines: unknown[] = [];
    const updates = await createUpdates({ root: dir, dist: join(dir, "dist"), dev: false, git: opts(), log: { log: (ev, f) => lines.push([ev, f]) } });
    expect(await updates.check()).toBe("none");
    expect(lines).toEqual([["error", { err: "update" }]]);
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).toContain("[remote \"origin\"]");
  });
});

// The deadline ends git's transport helpers too (ssh; git's remote-http and git-remote-http): git runs in a process
// group of its own, and the deadline sends SIGKILL to that group, so no helper keeps the connection open after the read
// was given up. A silent local listener stands in for an origin that never answers; a unique path in its URL names the
// helpers, which this test only looks for (it signals nothing); closing the listener ends any that are left.
describe.skipIf(!GIT)("a silent origin (S4)", () => {
  function silent() {
    const conns: { end(): void }[] = [];
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (s) => void conns.push(s), data() {} } });
    return {
      port: listener.port,
      stop: () => {
        for (const c of conns) c.end();
        listener.stop(true);
      },
    };
  }
  /** The processes whose command line names `mark` (read only). */
  function named(mark: string): number[] {
    const out: number[] = [];
    for (const n of readdirSync("/proc")) {
      if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
      try {
        if (readFileSync(`/proc/${n}/cmdline`, "utf8").includes(mark)) out.push(Number(n));
      } catch {
        // gone meanwhile
      }
    }
    return out;
  }
  async function gone(mark: string, ms: number): Promise<number[]> {
    const end = Date.now() + ms;
    let left = named(mark);
    while (left.length > 0 && Date.now() < end) {
      await Bun.sleep(50);
      left = named(mark);
    }
    return left;
  }

  for (const scheme of ["http", "ssh"] as const)
    test.skipIf(!existsSync("/proc/self/cmdline") || (scheme === "ssh" && !Bun.which("ssh", { PATH: "/usr/bin:/bin" })))(
      `${scheme}: the read fails at its deadline and leaves no helper behind`,
      async () => {
        const peer = silent();
        const mark = `kitespan-silent-${crypto.randomUUID()}`;
        try {
          const o = origin();
          const dir = o.clone();
          git(dir, "config", "remote.origin.url", scheme === "http" ? `http://127.0.0.1:${peer.port}/${mark}.git` : `ssh://kitespan@127.0.0.1:${peer.port}/${mark}.git`);
          // For ssh, no user or system ssh config either (a scratch HOME is not where ssh reads it).
          const extra: Record<string, string> = scheme === "ssh" ? { GIT_SSH_COMMAND: "ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 -o UserKnownHostsFile=/dev/null" } : {};
          const t0 = Date.now();
          expect(await checkRemote(dir, gitOptions(BASE, { ...ISOLATED, ...extra }, 1_000))).toEqual({ kind: "none", failed: true });
          expect(Date.now() - t0).toBeLessThan(5_000);
          expect(await gone(mark, 1_000)).toEqual([]);
        } finally {
          peer.stop();
        }
      },
      20_000,
    );
});
