// The real installer end to end (DESIGN-I1 2.15), offline by construction: every step runs in `unshare -rn` (a network
// namespace of its own with no way out; loopback up where a server listens), with the real Bun, Bun's own package cache
// (BUN_INSTALL_CACHE_DIR, so the locked production install needs no network) and the repository's fake claude. The
// releases are scripts/release.ts's, made from a scratch commit of this working tree (test/release-tree.ts) and from one
// more commit with the next patch version: install the first, kitespan --help and --version, a start on
// KITESPAN_TEST_PORT with one page load and a stop by its pid (scripts/install-trial.sh start), the second installed
// beside it and switched, --list, and --uninstall. The home, the XDG folders and TMPDIR are in the scratch folder.
// Where `unshare -rn` or `ip` does not work (CI's ubuntu-24.04 restricts user namespaces; macOS), it skips with its
// reason, and release.yml's install jobs run the installer there.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { installFakeClaude } from "../fake-claude/install";
import { ROOT } from "../install/home";
import { git, release, releaseTree, type ReleaseTree } from "../release-tree";

const UNSHARE = Bun.which("unshare");
const IP = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"].find((p) => existsSync(p)) ?? null;
const OFFLINE = UNSHARE !== null && IP !== null && Bun.spawnSync([UNSHARE, "-rn", IP, "link", "set", "lo", "up"]).exitCode === 0;
const CACHE = process.env.BUN_INSTALL_CACHE_DIR || join(homedir(), ".bun", "install", "cache");
const PORT = Number(process.env.KITESPAN_TEST_PORT) || 7941;
const TRIAL = join(ROOT, "scripts", "install-trial.sh");
const SKIP = !OFFLINE ? " (needs unshare -rn and ip: offline by construction)" : !existsSync(CACHE) ? " (needs Bun's package cache)" : "";

describe.skipIf(SKIP !== "")(`install.sh from release.ts's archives, offline, in a fresh home${SKIP}`, () => {
  let tree: ReleaseTree | null = null;
  const fake = installFakeClaude("text-thinking");
  afterAll(() => {
    tree?.remove();
    fake.cleanup();
  });

  let home = "";
  let env: Record<string, string> = {};
  let r1 = "";
  let r2 = "";
  let v1 = "";
  let v2 = "";
  let link = "";
  let kit = "";

  /** install.sh's own lines on stderr (bun's and the build's own lines go there too). */
  const complaints = (err: string) => err.split("\n").filter((l) => l.startsWith("install.sh:"));

  /** A command in a network namespace of its own; `lo` brings loopback up there first. */
  function offline(cmd: string[], o: { lo?: boolean } = {}): { code: number; out: string; err: string; lines: string[] } {
    const script = o.lo ? `"${IP}" link set lo up && exec "$@"` : 'exec "$@"';
    const r = Bun.spawnSync([UNSHARE!, "-rn", "/bin/sh", "-c", script, "sh", ...cmd], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 300_000, killSignal: "SIGKILL" });
    const out = r.stdout.toString();
    return { code: r.exitCode ?? -1, out, err: r.stderr.toString(), lines: out.split("\n").filter(Boolean) };
  }

  test("the two releases: release.ts's archive, install.sh and SHA256SUMS of each", () => {
    tree = releaseTree("kitespan-install-e2e-");
    v1 = tree.version;
    const [a, b, c] = v1.split(".").map(Number) as [number, number, number];
    v2 = `${a}.${b}.${c + 1}`;
    const first = git(tree.repo, "rev-parse", "HEAD");
    const pkg = join(tree.repo, "package.json");
    writeFileSync(pkg, readFileSync(pkg, "utf8").replace(`"version": "${v1}"`, `"version": "${v2}"`));
    git(tree.repo, "commit", "--quiet", "--no-verify", "-am", `kitespan ${v2}`);
    r1 = join(tree.tmp, "release-1");
    r2 = join(tree.tmp, "release-2");
    for (const [v, out, ref] of [[v1, r1, first], [v2, r2, "HEAD"]] as const) {
      const r = release(tree, ["--tag", `v${v}`, "--out", out, "--ref", ref]);
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      for (const f of [`kitespan-${v}.tar.gz`, "install.sh", "SHA256SUMS"]) expect(existsSync(join(out, f))).toBe(true);
    }

    home = join(tree.tmp, "home");
    for (const d of [".local/share", ".local/state", ".config", "tmp"]) mkdirSync(join(home, d), { recursive: true });
    env = {
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CONFIG_HOME: join(home, ".config"),
      TMPDIR: join(home, "tmp"),
      PATH: `${fake.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      BUN_INSTALL_CACHE_DIR: CACHE,
      LANG: "C.UTF-8",
    };
    expect(Bun.which("claude", { PATH: env.PATH })).toBe(fake.bin);
    kit = join(home, ".local", "share", "kitespan");
    link = join(home, ".local", "bin", "kitespan");
  }, 120_000);

  test("the first: installed, and its command answers --help and --version", () => {
    const r = offline(["env", `KITESPAN_INSTALL_FROM=${r1}`, "/bin/sh", join(r1, "install.sh")]);
    expect({ code: r.code, complaints: complaints(r.err) }).toEqual({ code: 0, complaints: [] });
    expect(r.lines).toContain("Step 2 of 3, install: bun install --frozen-lockfile --omit=optional --production");
    expect(r.lines).toContain(`kitespan ${v1} is installed in ${kit}/versions/${v1}; ${link} starts it.`);
    expect(readlinkSync(join(kit, "current"))).toBe(`versions/${v1}/bin/kitespan`);
    expect(existsSync(join(kit, "versions", v1, ".git"))).toBe(false);
    // In `unshare -r` tar runs as root and keeps the archive's modes (0775, 0664): install.sh makes them the user's alone.
    const mode = (p: string) => (statSync(join(kit, "versions", v1, p)).mode & 0o777).toString(8);
    expect([mode("."), mode("package.json"), mode("bin/kitespan"), mode("server")]).toEqual(["700", "600", "700", "700"]);
    const help = offline([link, "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toStartWith("Usage: bin/kitespan");
    expect(offline([link, "--version"]).out).toBe(`kitespan ${v1}\n`);
  }, 300_000);

  test("a start on the test port: health, the page, and a stop by its pid", () => {
    const r = offline(["/bin/sh", TRIAL, "start", link, String(PORT), r1], { lo: true });
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(r.lines.slice(0, 2)).toEqual([`install-trial: GET http://127.0.0.1:${PORT}/api/health: ok`, `install-trial: GET http://127.0.0.1:${PORT}/ holds <title>kitespan</title>: ok`]);
    expect(r.lines[2]).toMatch(/^install-trial: the stop of process \d+: ok$/);
  }, 120_000);

  test("the second: installed beside the first and switched; --list shows both", () => {
    const r = offline(["env", `KITESPAN_INSTALL_FROM=${r2}`, "/bin/sh", join(r2, "install.sh")]);
    expect({ code: r.code, complaints: complaints(r.err) }).toEqual({ code: 0, complaints: [] });
    expect(r.lines).toContain(`kitespan ${v2} is installed in ${kit}/versions/${v2}; ${link} starts it.`);
    expect(readdirSync(join(kit, "versions")).sort()).toEqual([v1, v2].sort());
    expect(readlinkSync(join(kit, "current"))).toBe(`versions/${v2}/bin/kitespan`);
    expect(offline([link, "--version"]).out).toBe(`kitespan ${v2}\n`);
    expect(offline(["/bin/sh", join(r2, "install.sh"), "--list"]).lines).toEqual([`${v2}  current`, v1]);
  }, 300_000);

  test("--uninstall: the link and the versions go; the state folder that the start made stays", () => {
    const r = offline(["/bin/sh", join(r2, "install.sh"), "--uninstall"]);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(r.lines[0]).toBe(`kitespan is uninstalled: ${link} and ${kit}/versions are removed.`);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(kit, "versions"))).toBe(false);
    expect(existsSync(join(home, ".local", "state", "kitespan"))).toBe(true);
  }, 60_000);
});
