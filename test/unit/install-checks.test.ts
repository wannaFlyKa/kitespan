// install.sh's arguments and its checks (DESIGN-I1 2.6 and 2.7): each refusal's one line and exit code, with the home
// folder the same before and after (nothing is made or changed before every check has passed); and the Claude Code
// line, which never stops an install (rows 118, 119): none on PATH, a stock build below the minimum, a company's build
// below it, one at it, an unreadable version, and one that never answers (ended after 15 s). Every run is `sh
// install.sh` in a fresh home with the fakes of test/install/fakes as its whole PATH, so nothing reaches the network
// and the real claude never runs.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_CODE_MINIMUM } from "../../server/agents/claude/background";
import { CLAUDE_MINIMUM_WORDS } from "../../shared/protocol";
import { archiveName } from "../../shared/release";
import { calls, good, type Home, install, localRelease, makeHome, removeHomes, snapshot } from "../install/home";

afterAll(removeHomes);

const USAGE = "(usage: sh install.sh [--list | --uninstall])";

/** A home with one good local release (0.1.0) to install from. */
function withRelease(o: { omit?: string[] } = {}): { h: Home; from: string } {
  const h = makeHome(o);
  return { h, from: localRelease(h, "release", [good("0.1.0")]) };
}

/** The run is refused with this one line and exit code, prints nothing on stdout, and changes nothing in the home. */
function refused(h: Home, env: Record<string, string | undefined>, line: string, args: string[] = [], code = 1): void {
  const before = snapshot(h.home);
  const r = install(h, args, env);
  expect({ code: r.code, err: r.err, out: r.out }).toEqual({ code, err: `install.sh: ${line}\n`, out: "" });
  expect(snapshot(h.home)).toEqual(before);
  expect(calls(h)).toEqual([]);
}

describe("the arguments (exit 2, nothing changed)", () => {
  test("two or more", () => {
    const h = makeHome();
    refused(h, {}, `one option at most ${USAGE}`, ["--list", "--uninstall"], 2);
  });
  test("one that it does not know", () => {
    const h = makeHome();
    refused(h, {}, `unknown option --bogus ${USAGE}`, ["--bogus"], 2);
    refused(h, {}, `unknown option list ${USAGE}`, ["list"], 2);
  });
});

describe("the checks of an install, in order (exit 1, nothing changed)", () => {
  test("1: HOME must be absolute", () => {
    const { h, from } = withRelease();
    refused(h, { KITESPAN_INSTALL_FROM: from, HOME: "home" }, "HOME must be an absolute path.");
    refused(h, { KITESPAN_INSTALL_FROM: from, HOME: undefined }, "HOME must be an absolute path.");
  });

  test("2: Linux or macOS only", () => {
    const { h, from } = withRelease();
    refused(h, { KITESPAN_INSTALL_FROM: from, FAKE_UNAME: "FreeBSD" }, "kitespan runs on Linux and macOS only; this system is FreeBSD.");
    for (const os of ["Linux", "Darwin"]) expect(install(h, [], { KITESPAN_INSTALL_FROM: from, FAKE_UNAME: os }).code).toBe(0);
  });

  test("3: KITESPAN_VERSION must be a version", () => {
    const { h, from } = withRelease();
    for (const bad of ["0.1", "v0.1", "0.1.0-rc.1", "01.2.3", "0.1.0 ", "latest"]) {
      refused(h, { KITESPAN_INSTALL_FROM: from, KITESPAN_VERSION: bad }, `KITESPAN_VERSION must be a version such as 0.1.0, not "${bad}".`);
    }
  });

  test("4: KITESPAN_INSTALL_FROM must be absolute", () => {
    const { h } = withRelease();
    refused(h, { KITESPAN_INSTALL_FROM: "release" }, 'KITESPAN_INSTALL_FROM must be an absolute path, not "release".');
  });

  test("5: a folder with SHA256SUMS, or a kitespan-<x.y.z>.tar.gz file with SHA256SUMS beside it", () => {
    const { h, from } = withRelease();
    const empty = join(h.dir, "empty");
    mkdirSync(empty);
    const lone = join(h.dir, "lone");
    mkdirSync(lone);
    writeFileSync(join(lone, archiveName("0.1.0")), "x");
    writeFileSync(join(h.dir, "kitespan.tar.gz"), "x");
    const line = (p: string) => `KITESPAN_INSTALL_FROM names ${p}, which is neither a folder with SHA256SUMS nor a kitespan-<x.y.z>.tar.gz file with SHA256SUMS beside it.`;
    for (const p of [empty, join(lone, archiveName("0.1.0")), join(h.dir, "kitespan.tar.gz"), join(from, "SHA256SUMS"), join(h.dir, "missing")]) {
      refused(h, { KITESPAN_INSTALL_FROM: p }, line(p));
    }
  });

  test("6: an archive's version must be KITESPAN_VERSION's", () => {
    const { h, from } = withRelease();
    refused(
      h,
      { KITESPAN_INSTALL_FROM: join(from, archiveName("0.1.0")), KITESPAN_VERSION: "v0.2.0" },
      "KITESPAN_VERSION is 0.2.0, but KITESPAN_INSTALL_FROM names kitespan-0.1.0.tar.gz.",
    );
  });

  test("7: curl or wget, unless it installs from a local release", () => {
    const { h, from } = withRelease({ omit: ["curl", "wget"] });
    refused(h, {}, "it needs curl or wget to download the release.");
    expect(install(h, [], { KITESPAN_INSTALL_FROM: from }).code).toBe(0);
  });

  test("8: tar and gzip", () => {
    for (const tool of ["tar", "gzip"]) {
      const { h, from } = withRelease({ omit: [tool] });
      refused(h, { KITESPAN_INSTALL_FROM: from }, "it needs tar and gzip to unpack the release.");
    }
  });

  test("9: sha256sum or shasum", () => {
    const { h, from } = withRelease({ omit: ["sha256sum", "shasum"] });
    refused(h, { KITESPAN_INSTALL_FROM: from }, "it needs sha256sum or shasum to check the download.");
  });

  test("10: Bun on PATH, and it never installs Bun", () => {
    const { h, from } = withRelease({ omit: ["bun"] });
    refused(
      h,
      { KITESPAN_INSTALL_FROM: from },
      "kitespan needs Bun 1.3.14 or later, and there is no bun on your PATH. Install Bun (https://bun.com/docs/installation), then run this again.",
    );
  });

  test("11: Bun 1.3.14 or later, on its first three numbers", () => {
    const { h, from } = withRelease();
    const old = (shown: string) => `kitespan needs Bun 1.3.14 or later; the bun on your PATH is ${shown}. Update Bun (https://bun.com/docs/installation), then run this again.`;
    refused(h, { KITESPAN_INSTALL_FROM: from, FAKE_BUN_VERSION: "1.3.13" }, old("1.3.13"));
    refused(h, { KITESPAN_INSTALL_FROM: from, FAKE_BUN_VERSION: "1.2.99-canary.4" }, old("1.2.99-canary.4"));
    refused(h, { KITESPAN_INSTALL_FROM: from, FAKE_BUN_VERSION: "0.9.100" }, old("0.9.100"));
    const none = "kitespan needs Bun 1.3.14 or later; the bun on your PATH printed no version. Update Bun (https://bun.com/docs/installation), then run this again.";
    refused(h, { KITESPAN_INSTALL_FROM: from, FAKE_BUN_VERSION: "bun" }, none);
    refused(h, { KITESPAN_INSTALL_FROM: from, FAKE_BUN_VERSION_EXIT: "1" }, none);
    for (const ok of ["1.3.14", "1.3.15-canary.1+abc", "1.4.0", "2.0.0"]) {
      const g = withRelease();
      expect(install(g.h, [], { KITESPAN_INSTALL_FROM: g.from, FAKE_BUN_VERSION: ok }).code).toBe(0);
    }
  });

  test("12: kitespan's folder and its versions folder are folders, not links or files", () => {
    for (const [what, make] of [
      ["kit", (h: Home) => (mkdirSync(join(h.home, ".local", "share"), { recursive: true }), writeFileSync(h.kit, ""))],
      ["kit", (h: Home) => (mkdirSync(join(h.dir, "elsewhere")), mkdirSync(join(h.home, ".local", "share"), { recursive: true }), symlinkSync(join(h.dir, "elsewhere"), h.kit))],
      ["versions", (h: Home) => (mkdirSync(join(h.dir, "elsewhere")), mkdirSync(h.kit, { recursive: true }), symlinkSync(join(h.dir, "elsewhere"), h.versions))],
    ] as const) {
      const { h, from } = withRelease();
      make(h);
      const path = what === "kit" ? h.kit : h.versions;
      refused(h, { KITESPAN_INSTALL_FROM: from }, `${path} must be a folder of yours, not a link or a file.`);
    }
  });

  test("13: anything at <kit>/current is a link that does not lead to a folder", () => {
    for (const make of [
      (h: Home) => writeFileSync(h.current, "x"),
      (h: Home) => mkdirSync(h.current),
      (h: Home) => (mkdirSync(join(h.versions, "0.1.0"), { recursive: true }), symlinkSync("versions/0.1.0", h.current)),
    ]) {
      const { h, from } = withRelease();
      mkdirSync(h.kit, { recursive: true });
      make(h);
      refused(h, { KITESPAN_INSTALL_FROM: from }, `${h.current} is not kitespan's link, so install.sh does not touch it.`);
    }
  });

  test("14: ~/.local/bin, when it is there, is a folder", () => {
    const { h, from } = withRelease();
    mkdirSync(join(h.home, ".local"), { recursive: true });
    writeFileSync(h.bindir, "");
    refused(h, { KITESPAN_INSTALL_FROM: from }, `${h.bindir} is not a folder.`);
  });

  test("15: anything at ~/.local/bin/kitespan is kitespan's link", () => {
    const line = (h: Home) => `${h.link} is there and is not kitespan's link, so install.sh does not replace it. Move it away, then run this again.`;
    for (const make of [
      (h: Home) => writeFileSync(h.link, "#!/bin/sh\n"),
      (h: Home) => symlinkSync(join(h.dir, "other", "current"), h.link),
      (h: Home) => symlinkSync(join(h.kit, "kitespan"), h.link),
    ]) {
      const { h, from } = withRelease();
      mkdirSync(h.bindir, { recursive: true });
      make(h);
      refused(h, { KITESPAN_INSTALL_FROM: from }, line(h));
    }
  });

  test("kitespan's own link is not refused: by its spelling, or by the real path of its folder", () => {
    const { h, from } = withRelease();
    mkdirSync(h.bindir, { recursive: true });
    symlinkSync(h.current, h.link);
    expect(install(h, [], { KITESPAN_INSTALL_FROM: from }).code).toBe(0);
    const g = withRelease();
    mkdirSync(g.h.bindir, { recursive: true });
    mkdirSync(g.h.kit, { recursive: true });
    symlinkSync("../share/kitespan/current", g.h.link);
    const r = install(g.h, [], { KITESPAN_INSTALL_FROM: g.from });
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toBe(`Start it: ${g.h.link}`);
  });
});

describe("the Claude Code line: never a stop (rows 118, 119)", () => {
  const NONE = `There is no claude on your PATH, so no chat can start until there is one: kitespan runs your own Claude Code, ${CLAUDE_CODE_MINIMUM} or later (https://code.claude.com/docs/en/setup).`;
  const claudeLines = (lines: string[]) => lines.filter((l) => l.includes("claude") || l.includes("Claude"));

  test("no claude on PATH: the line, and the install goes on", () => {
    const { h, from } = withRelease({ omit: ["claude"] });
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from });
    expect(r.code).toBe(0);
    expect(claudeLines(r.lines)).toEqual([NONE]);
    expect(r.lines.indexOf(NONE)).toBeLessThan(r.lines.findIndex((l) => l.startsWith("Step 1 of 3")));
  });

  test("below the minimum: the server's own words, for a stock build and for a company's build", () => {
    for (const [printed, version, stock] of [
      ["2.1.250 (Claude Code)", "2.1.250", true],
      ["2.1.250-acme.2 (Claude Code)", "2.1.250-acme.2", false],
      ["2.1.295.1", "2.1.295.1", false],
      ["1.0.0", "1.0.0", true],
    ] as const) {
      const { h, from } = withRelease();
      const r = install(h, [], { KITESPAN_INSTALL_FROM: from, FAKE_CLAUDE_VERSION: printed });
      expect(r.code).toBe(0);
      expect(claudeLines(r.lines)).toEqual([CLAUDE_MINIMUM_WORDS.plain({ version, minimum: CLAUDE_CODE_MINIMUM, stock })]);
    }
  });

  test("at or above the minimum, or a version it cannot read: no line", () => {
    for (const printed of [`${CLAUDE_CODE_MINIMUM} (Claude Code)`, "2.1.317.1", "3.0.0", "Claude Code", ""]) {
      const { h, from } = withRelease();
      const r = install(h, [], { KITESPAN_INSTALL_FROM: from, FAKE_CLAUDE_VERSION: printed });
      expect(r.code).toBe(0);
      expect(claudeLines(r.lines)).toEqual([]);
    }
  });

  test("a claude that never answers is ended after 15 s, with no line, and the install goes on", () => {
    const { h, from } = withRelease();
    const t0 = Date.now();
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from, FAKE_CLAUDE_SLEEP: "30" });
    const took = Date.now() - t0;
    expect(r.code).toBe(0);
    expect(claudeLines(r.lines)).toEqual([]);
    expect(took).toBeGreaterThanOrEqual(14_000);
    expect(took).toBeLessThan(25_000);
  }, 40_000);
});
