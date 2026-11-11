// The Homebrew formula (DESIGN-I1 4), checked without brew (there is none here; release.yml's brew job runs the real
// `brew install --build-from-source`, `brew test` and `brew audit --strict` on macOS): packaging/homebrew/kitespan.rb
// parses (`ruby -c`); its lines are the release's url and digest placeholders, homebrew-core's bun, the installer's own
// two steps and the link; its install done by hand in a fresh prefix, offline, with the links that `brew link` makes,
// then its test block's two commands through that link; and scripts/brew-trial.sh's steps in order, with a fake brew.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { archiveName, RELEASE_REPO, RELEASES_URL, releaseTag } from "../../shared/release";
import { must, release, releaseTree, ROOT, run, type ReleaseTree } from "../release-tree";

const FORMULA = join(ROOT, "packaging/homebrew/kitespan.rb");
const text = readFileSync(FORMULA, "utf8");
const lines = text.split("\n");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { license: string };

/** The formula's `system` lines as the commands they run. */
const systems = () =>
  lines
    .filter((l) => /^\s+system /.test(l))
    .map((l) => [...l.matchAll(/"([^"]*)"/g)].map((m) => m[1]!).join(" "));

describe("packaging/homebrew/kitespan.rb", () => {
  test.skipIf(!Bun.which("ruby"))("ruby -c says Syntax OK", () => {
    expect(must(["ruby", "-c", FORMULA], ROOT).trim()).toBe("Syntax OK");
  });

  test("its url and sha256 are the release's placeholders, and it names no version or digest of its own", () => {
    expect(lines).toContain("class Kitespan < Formula");
    expect(lines).toContain(`  homepage "https://github.com/${RELEASE_REPO}"`);
    expect(lines).toContain(`  url "${RELEASES_URL}/download/${releaseTag("@VERSION@")}/${archiveName("@VERSION@")}"`);
    expect(lines).toContain('  sha256 "@SHA256@"');
    expect(lines).toContain(`  license "${pkg.license}"`);
    expect(text).not.toMatch(/\d+\.\d+\.\d+/);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  test("it depends on homebrew-core's bun only, installs the installer's own two steps in libexec, and links bin/kitespan", () => {
    expect(lines.filter((l) => /^\s*depends_on /.test(l))).toEqual(['  depends_on "bun"']);
    expect(lines).toContain('    libexec.install Dir["*"]');
    expect(lines).toContain("    cd libexec do");
    expect(systems()).toEqual(["bun install --frozen-lockfile --omit=optional --production", "bun run build"]);
    // The same commands as install.sh's step 2 and step 3 lines (DESIGN-I1 2.9).
    const installer = readFileSync(join(ROOT, "install.sh"), "utf8");
    expect(installer).toContain(`Step 2 of 3, install: ${systems()[0]}`);
    expect(installer).toContain(`Step 3 of 3, build: ${systems()[1]}`);
    expect(lines).toContain('    bin.install_symlink libexec/"bin/kitespan"');
  });

  test("its test block runs kitespan --version and --help with Homebrew's bun first on PATH, and nothing else", () => {
    const start = lines.indexOf("  test do");
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start, start + 5)).toEqual([
      "  test do",
      '    ENV.prepend_path "PATH", formula_opt_bin("bun")',
      '    assert_match "kitespan #{version}", shell_output("#{bin}/kitespan --version")',
      '    assert_match "Usage:", shell_output("#{bin}/kitespan --help")',
      "  end",
    ]);
  });
});

// The formula's install, by hand, as Homebrew would run it: the archive's top folder in <prefix>/Cellar/kitespan/<v>/libexec
// (Dir["*"]: its entries that do not start with a dot), the locked production install without optional packages and
// the build there, offline (unshare -cn: no network at all; Bun's packages come from the user's cache), then
// <keg>/bin/kitespan -> ../libexec/bin/kitespan and <prefix>/bin/kitespan -> ../Cellar/kitespan/<v>/bin/kitespan, as
// `brew link` makes them.
const OFFLINE = Bun.which("unshare") !== null && Bun.spawnSync(["unshare", "-cn", "true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode === 0;

describe.skipIf(!OFFLINE)("the formula's install by hand, in a fresh prefix (needs unshare -cn: offline by construction)", () => {
  let tree: ReleaseTree;
  let v: string;
  let prefix: string;
  let env: Record<string, string>;
  /** The user's own Bun cache, read before any HOME of the test's. */
  const cache = must([process.execPath, "pm", "cache"], ROOT).trim();

  beforeAll(() => {
    tree = releaseTree("kitespan-formula-");
    v = tree.version;
    const out = join(tree.tmp, "out");
    const r = release(tree, ["--tag", releaseTag(v), "--ref", "HEAD", "--out", out]);
    if (r.code !== 0) throw new Error(`release.ts failed: ${r.err}`);
    const unpack = join(tree.tmp, "unpack");
    mkdirSync(unpack);
    must(["tar", "-xzf", join(out, archiveName(v)), "-C", unpack], tree.tmp);
    prefix = join(tree.tmp, "prefix");
    const keg = join(prefix, "Cellar", "kitespan", v);
    const libexec = join(keg, "libexec");
    mkdirSync(libexec, { recursive: true });
    const top = join(unpack, `kitespan-${v}`);
    for (const name of readdirSync(top)) if (!name.startsWith(".")) renameSync(join(top, name), join(libexec, name));

    const home = join(tree.tmp, "home");
    mkdirSync(home);
    const bunDir = join(tree.tmp, "bun-bin");
    mkdirSync(bunDir);
    symlinkSync(process.execPath, join(bunDir, "bun"));
    // A node on this PATH too (Bun itself), so the scripts' `#!/usr/bin/env node` tools run without Bun's own node
    // alias: Bun makes that alias once per version in the system's /tmp, pointing at the bun it ran from, and this
    // folder goes when the test ends, which would leave the alias dangling for every later run without a node.
    symlinkSync(process.execPath, join(bunDir, "node"));
    env = {
      PATH: `${bunDir}:/usr/bin:/bin`,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      TMPDIR: tmpdir(),
      LANG: "C.UTF-8",
      BUN_INSTALL_CACHE_DIR: cache,
    };
    // The real claude can never run here: there is none on this PATH.
    if (Bun.which("claude", { PATH: env.PATH }) !== null) throw new Error("a claude is on the test's PATH");
    const step = (args: string[]) => {
      const s = run(["unshare", "-cn", join(bunDir, "bun"), ...args], libexec, { env, ms: 300_000 });
      if (s.code !== 0) throw new Error(`bun ${args.join(" ")} exited ${s.code}: ${s.err.trim().split("\n").slice(-5).join(" | ")}`);
    };
    step(["install", "--frozen-lockfile", "--omit=optional", "--production"]);
    step(["run", "build"]);
    mkdirSync(join(keg, "bin"));
    symlinkSync("../libexec/bin/kitespan", join(keg, "bin", "kitespan"));
    mkdirSync(join(prefix, "bin"));
    symlinkSync(`../Cellar/kitespan/${v}/bin/kitespan`, join(prefix, "bin", "kitespan"));
  }, 300_000);
  afterAll(() => tree?.remove());

  test("the keg holds the production packages without the optional ones, and the built page", () => {
    const libexec = join(prefix, "Cellar", "kitespan", v, "libexec");
    expect(existsSync(join(libexec, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"))).toBe(true);
    expect(existsSync(join(libexec, "node_modules", "typescript"))).toBe(false);
    // No SDK platform package (each holds a claude binary): only the claude on PATH runs.
    expect(readdirSync(join(libexec, "node_modules", "@anthropic-ai")).filter((n) => n.startsWith("claude-agent-sdk-"))).toEqual([]);
    expect(existsSync(join(libexec, "dist", "web", "index.html"))).toBe(true);
    expect(existsSync(join(libexec, "dist", "web", "build.json"))).toBe(true);
    expect(existsSync(join(libexec, ".github"))).toBe(false);
  });

  test("the test block's commands, through <prefix>/bin/kitespan: --version prints the version, --help the usage", () => {
    const bin = join(prefix, "bin", "kitespan");
    const version = run([bin, "--version"], tree.tmp, { env, ms: 60_000 });
    expect(version.err).toBe("");
    expect([version.code, version.out]).toEqual([0, `kitespan ${v}\n`]);
    const help = run([bin, "--help"], tree.tmp, { env, ms: 60_000 });
    expect(help.code, help.err).toBe(0);
    expect(help.out).toContain("Usage:");
    // Neither wrote into the user's folders of this fresh home.
    expect(existsSync(join(env.XDG_STATE_HOME!, "kitespan"))).toBe(false);
  });
});

// scripts/brew-trial.sh with a fake brew and a fake install-trial.sh beside a copy of it: the steps in order, the local
// url for the install and the test, the real url for the audit, and the first failure's line.
describe("scripts/brew-trial.sh, with a fake brew", () => {
  let tmp: string;
  let folder: string;
  let scripts: string;
  let fakes: string;
  const v = "0.1.0";
  const digest = "ab".repeat(32);

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-brew-trial-")));
    folder = join(tmp, "release");
    mkdirSync(folder);
    writeFileSync(join(folder, archiveName(v)), "not really an archive");
    writeFileSync(join(folder, "SHA256SUMS"), `${digest}  ${archiveName(v)}\n${"cd".repeat(32)}  install.sh\n`);
    writeFileSync(join(folder, "kitespan.rb"), text.replaceAll("@VERSION@", v).replace('sha256 "@SHA256@"', `sha256 "${digest}"`));
    scripts = join(tmp, "scripts");
    mkdirSync(scripts);
    copyFileSync(join(ROOT, "scripts/brew-trial.sh"), join(scripts, "brew-trial.sh"));
    writeFileSync(join(scripts, "install-trial.sh"), '#!/bin/sh\nprintf "install-trial %s\\n" "$*" >>"$FAKE_LOG"\n[ "${FAKE_FAIL:-}" != start ]\n');
    fakes = join(tmp, "fakes");
    mkdirSync(fakes);
    // brew: each call is a line of the log; install and audit add the formula's url line as it is then.
    writeFileSync(
      join(fakes, "brew"),
      [
        "#!/bin/sh",
        'printf "brew %s\\n" "$*" >>"$FAKE_LOG"',
        'tap="$FAKE_ROOT/Library/Taps/kitespan/homebrew-local"',
        'case "$1" in',
        '  tap-new) [ ! -d "$tap" ] || exit 1; mkdir -p "$tap" ;;',
        '  --repository) printf "%s\\n" "$tap" ;;',
        '  --prefix) printf "%s\\n" "$FAKE_ROOT/prefix" ;;',
        '  install|audit) grep "^  url " "$tap/Formula/kitespan.rb" >>"$FAKE_LOG" ;;',
        "esac",
        '[ "${FAKE_FAIL:-}" != "$1" ]',
        "",
      ].join("\n"),
    );
    chmodSync(join(fakes, "brew"), 0o755);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const trial = (name: string, args: string[], fail?: string) => {
    const root = join(tmp, name);
    mkdirSync(root);
    const log = join(root, "log");
    writeFileSync(log, "");
    const env: Record<string, string> = { PATH: `${fakes}:/usr/bin:/bin`, HOME: root, TMPDIR: tmpdir(), LANG: "C.UTF-8", FAKE_LOG: log, FAKE_ROOT: root, ...(fail ? { FAKE_FAIL: fail } : {}) };
    const r = run(["sh", join(scripts, "brew-trial.sh"), ...args], root, { env });
    return { ...r, log: readFileSync(log, "utf8").trim().split("\n").filter(Boolean), tap: join(root, "Library/Taps/kitespan/homebrew-local") };
  };

  test("the steps in order: the local tap, the install and the test with the archive's file url, the start, then the audit with the real url", () => {
    const r = trial("ok", [folder, "7941"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const local = `  url "file://${folder}/${archiveName(v)}"`;
    const real = `  url "${RELEASES_URL}/download/v${v}/${archiveName(v)}"`;
    expect(r.log).toEqual([
      "brew tap-new --no-git kitespan/local",
      "brew --repository kitespan/local",
      "brew install --build-from-source kitespan/local/kitespan",
      local,
      "brew test kitespan/local/kitespan",
      "brew --prefix",
      `install-trial start ${join(tmp, "ok", "prefix")}/bin/kitespan 7941 ${folder}`,
      "brew audit --strict kitespan/local/kitespan",
      real,
    ]);
    expect(r.out.trim().split("\n")).toEqual([
      `brew-trial: the local tap kitespan/local, its formula's url file://${folder}/${archiveName(v)}: ok`,
      "brew-trial: brew install --build-from-source kitespan/local/kitespan: ok",
      "brew-trial: brew test kitespan/local/kitespan: ok",
      `brew-trial: the start of ${join(tmp, "ok", "prefix")}/bin/kitespan: ok`,
      "brew-trial: brew audit --strict kitespan/local/kitespan: ok",
    ]);
    // The tap's formula is the release's, byte for byte, after the audit's step.
    expect(readFileSync(join(r.tap, "Formula", "kitespan.rb"), "utf8")).toBe(readFileSync(join(folder, "kitespan.rb"), "utf8"));
  });

  test("the first failure ends it with its line and exit 1, and no later step runs", () => {
    const install = trial("fail-install", [folder, "7941"], "install");
    expect([install.code, install.err.trim()]).toEqual([1, "brew-trial: brew install --build-from-source kitespan/local/kitespan failed"]);
    expect(install.log.some((l) => l.startsWith("brew test") || l.startsWith("install-trial") || l.startsWith("brew audit"))).toBe(false);
    const start = trial("fail-start", [folder, "7941"], "start");
    expect(start.code).toBe(1);
    expect(start.err.trim()).toBe(`brew-trial: the start of ${join(tmp, "fail-start", "prefix")}/bin/kitespan failed`);
    expect(start.log.some((l) => l.startsWith("brew audit"))).toBe(false);
  });

  test("a usage error exits 2; a folder without its files, or with an archive path that a Ruby string should not hold, exits 1 before brew runs", () => {
    const usages = [[], [folder], [folder, "x"], ["release", "7941"]];
    for (const [i, args] of usages.entries()) {
      const r = trial(`usage-${i}`, args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("Usage: sh scripts/brew-trial.sh <release folder> <port>");
      expect(r.log).toEqual([]);
    }
    const empty = join(tmp, "empty");
    mkdirSync(empty);
    const r = trial("no-files", [empty, "7941"]);
    expect([r.code, r.err.trim()]).toEqual([1, "brew-trial: the release folder's SHA256SUMS failed"]);
    const odd = join(tmp, "odd #{x}");
    mkdirSync(odd);
    for (const f of readdirSync(folder)) copyFileSync(join(folder, f), join(odd, f));
    const o = trial("odd", [odd, "7941"]);
    expect(o.code).toBe(1);
    expect(o.err).toStartWith(`brew-trial: the archive's path ${odd}/${archiveName(v)} (only letters`);
    expect(o.log).toEqual([]);
    expect(dirname(odd)).toBe(tmp);
  });
});
