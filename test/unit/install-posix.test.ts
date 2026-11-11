// install.sh is POSIX sh (DESIGN-I1 2.1, 2.2 and 2.14): it parses with `sh -n`, `bash --posix -n` and `dash -n` (each
// where it is installed; CI's ubuntu-24.04 and macOS have dash), holds none of the usual bashisms or non-POSIX tools
// outside its comments, runs nothing at its top level before its last line (so a download cut short runs nothing), keeps
// LF line ends, and repeats the TypeScript values it names. The same parse runs on the other scripts of this round.

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_CODE_MINIMUM } from "../../server/agents/claude/background";
import { RELEASES_URL, SUMS_MAX_BYTES } from "../../shared/release";
import { INSTALL, ROOT } from "../install/home";

const TEXT = readFileSync(INSTALL, "utf8");
const LINES = TEXT.split("\n");
/** The lines that are code: not blank, not a comment. */
const CODE = LINES.map((l, i) => ({ n: i + 1, l })).filter(({ l }) => l.trim() !== "" && !l.trim().startsWith("#"));
const SCRIPTS = ["install.sh", "bin/kitespan", "bin/update.sh", "scripts/install-trial.sh", ...["bun", "claude", "curl", "ps", "uname", "wget"].map((f) => `test/install/fakes/${f}`)];

describe("the parse", () => {
  const shells: [string, string[]][] = [["/bin/sh", ["-n"]]];
  const bash = Bun.which("bash");
  if (bash) shells.push([bash, ["--posix", "-n"]]);
  const dash = Bun.which("dash");
  if (dash) shells.push([dash, ["-n"]]);
  for (const [sh, flags] of shells) {
    test(`${sh} ${flags.join(" ")} on each script`, () => {
      for (const f of SCRIPTS) {
        const r = Bun.spawnSync([sh, ...flags, join(ROOT, f)], { stdout: "pipe", stderr: "pipe" });
        expect({ f, code: r.exitCode, err: r.stderr.toString() }).toEqual({ f, code: 0, err: "" });
      }
    });
  }
  if (!dash) test.skip("dash -n (no dash on this machine: CI's ubuntu-24.04 and macOS have it)", () => {});
});

describe("install.sh's shape", () => {
  test("mode 0755, #!/bin/sh first, LF line ends only", () => {
    expect((statSync(INSTALL).mode & 0o777).toString(8)).toBe("755");
    expect(LINES[0]).toBe("#!/bin/sh");
    expect(TEXT.includes("\r")).toBe(false);
    expect(TEXT.endsWith("\n")).toBe(true);
  });

  test("at the top level only comments, set -eu, umask 077, constants and functions; the last line calls main", () => {
    const top = LINES.map((l, i) => ({ n: i + 1, l })).filter(({ l }) => l !== "" && !/^\s/.test(l));
    const odd = top.filter(
      ({ l }) => !/^#/.test(l) && !/^set -eu$/.test(l) && !/^umask 077$/.test(l) && !/^[A-Z][A-Z0-9_]*=[^\s;&|`$()]+(\s+#.*)?$/.test(l) && !/^[a-z][a-z0-9_]*\(\) \{$/.test(l) && !/^\}$/.test(l),
    );
    expect(odd).toEqual([{ n: LINES.length - 1, l: 'main "$@"' }]);
    expect(LINES.at(-1)).toBe("");
    expect(LINES.at(-2)).toBe('main "$@"');
    const order = top.filter(({ l }) => !l.startsWith("#")).map(({ l }) => (/^[A-Z]/.test(l) ? "const" : l));
    expect(order.slice(0, 2)).toEqual(["set -eu", "umask 077"]);
  });

  test("no bashism, and none of the tools that POSIX or macOS lacks, outside comments", () => {
    const rules: [string, RegExp][] = [
      ["local", /(^\s*|[;&|]\s*)local\s+[A-Za-z_]/],
      ["[[", /(^|\s)\[\[\s/],
      ["an array", /(^\s*|\s)[A-Za-z_][A-Za-z0-9_]*=\(|\$\{[A-Za-z_][A-Za-z0-9_]*\[/],
      ["function", /(^\s*|[;&|]\s*)function\s+[A-Za-z_]/],
      ["$'...'", /(^|[\s=])\$'/],
      ["a substring", /\$\{[A-Za-z_][A-Za-z0-9_]*:([0-9]|\s+-?[0-9])/],
      ["a replacement", /\$\{[A-Za-z_][A-Za-z0-9_]*\/|\$\{[A-Za-z_][A-Za-z0-9_]*[\^,]|\$\{!/],
      ["source", /(^\s*|[;&|]\s*)source\s/],
      ["== in [", /\[\s[^\]]*\s==\s/],
      ["&>, |&, <<<, <( or >(", /&>|\|&|<<<|<\(|>\(/],
      ["(( ))", /(^\s*|[;&|]\s*)\(\(/],
      ["pipefail, $RANDOM, declare, typeset or shopt", /pipefail|\$RANDOM|(^\s*|[;&|]\s*)(declare|typeset|shopt)\s/],
      ["read -a", /\bread\s+-a/],
      ["echo", /(^\s*|[\s;&|(])echo(\s|$)/],
      ["test -O", /(\[|\btest)\s+-O\s/],
      ["mktemp, timeout or realpath", /(^\s*|[\s;&|(])(mktemp|timeout|realpath)(\s|$)/],
      ["readlink -f", /readlink\s+-f/],
      ["sed -i", /\bsed\s+-i/],
      ["grep -o or -P", /\bgrep\s+-[A-Za-z]*[oP]/],
    ];
    const hits = CODE.flatMap(({ n, l }) => rules.filter(([, re]) => re.test(l)).map(([what]) => `${n}: ${what}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });

  test("its constants are the TypeScript values they name", () => {
    const consts = new Map<string, string>();
    for (const l of LINES) {
      const m = /^([A-Z][A-Z0-9_]*)=(\S+)/.exec(l);
      if (m) consts.set(m[1]!, m[2]!);
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { devDependencies: { "@types/bun": string } };
    expect(Object.fromEntries(consts)).toEqual({
      RELEASES: RELEASES_URL,
      BUN_MIN: pkg.devDependencies["@types/bun"],
      CLAUDE_MIN: CLAUDE_CODE_MINIMUM,
      SUMS_MAX: String(SUMS_MAX_BYTES),
      ARCHIVE_MAX: String(100 * 1024 * 1024),
      UNPACKED_MAX: String(200 * 1024 * 1024),
      ENTRIES_MAX: "20000",
    });
  });
});
