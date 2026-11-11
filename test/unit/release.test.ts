// The release (DESIGN-I1 1 and 5.3): package.json's version is a release version; scripts/release.ts takes the tag
// v<version> of package.json and refuses any other before it makes anything; the archive is `git archive` of the
// commit with one top folder and every tracked file, plain files and folders only, the sh scripts with LF line ends
// (.gitattributes), the same bytes at every run; SHA256SUMS lists the archive, then install.sh; the formula and the
// release notes are filled in. Everything runs in a scratch repository (test/release-tree.ts), never on a commit of this
// checkout.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fillFormula, releaseNotes } from "../../scripts/release";
import { archiveName, BREW_FORMULA, RELEASE_REPO, RELEASE_VERSION, RELEASES_URL, releaseTag } from "../../shared/release";
import { baseEnv, git, must, release, releaseTree, ROOT, run, type ReleaseTree } from "../release-tree";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
const TEMPLATE = readFileSync(join(ROOT, "packaging/homebrew/kitespan.rb"), "utf8");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const FILES = (v: string) => ["SHA256SUMS", "install.sh", archiveName(v), "kitespan.rb", "release-notes.md"].sort();

describe("the version and the line ends", () => {
  test("package.json's version is a release version, and the formula's template names no version or digest of its own", () => {
    expect(pkg.version).toMatch(RELEASE_VERSION);
    expect(TEMPLATE).not.toMatch(/\d+\.\d+\.\d+/);
    expect(TEMPLATE).not.toMatch(/[0-9a-f]{64}/);
  });

  test(".gitattributes keeps LF for the sh scripts and bin/, and leaves nothing out of an archive", () => {
    const text = readFileSync(join(ROOT, ".gitattributes"), "utf8");
    // Two rules and nothing else: no export-ignore and no export-subst, so an archive is the tag's tree exactly.
    expect(text.split("\n").filter((l) => l !== "" && !l.startsWith("#"))).toEqual(["*.sh   text eol=lf", "bin/*  text eol=lf"]);
    const attrs = must(["git", "-C", ROOT, "check-attr", "eol", "--", "install.sh", "bin/kitespan", "bin/update.sh", "scripts/brew-trial.sh", "scripts/install-trial.sh"], ROOT);
    expect(attrs.trim().split("\n")).toEqual(["install.sh: eol: lf", "bin/kitespan: eol: lf", "bin/update.sh: eol: lf", "scripts/brew-trial.sh: eol: lf", "scripts/install-trial.sh: eol: lf"]);
  });
});

describe("scripts/release.ts", () => {
  let tree: ReleaseTree;
  let v: string;
  let out: string;
  let made: { code: number; out: string; err: string };
  const outDir = (name: string) => join(tree.tmp, name);
  const bytes = (dir: string, f: string) => readFileSync(join(dir, f));
  const tar = (archive: string, ...args: string[]) => must(["tar", ...args, archive], tree.tmp);

  beforeAll(() => {
    tree = releaseTree("kitespan-release-");
    v = tree.version;
    out = outDir("out");
    made = release(tree, ["--tag", releaseTag(v), "--ref", "HEAD", "--out", out]);
  }, 120_000);
  afterAll(() => tree?.remove());

  test("v<version> at the ref: the five files of a release, each printed with its SHA-256, and nothing else", () => {
    expect(made.err).toBe("");
    expect(made.code).toBe(0);
    expect(readdirSync(out).sort()).toEqual(FILES(v));
    const lines = made.out.trim().split("\n");
    expect(lines.map((l) => l.replace(/^[0-9a-f]{64} {2}/, ""))).toEqual([archiveName(v), "install.sh", "SHA256SUMS", "kitespan.rb", "release-notes.md"].map((f) => join(out, f)));
    for (const l of lines) expect(l.slice(0, 64)).toBe(sha256(readFileSync(l.slice(66))));
  });

  test("the archive is git archive of the commit through gzip -n -9: one top folder, every tracked file, plain files and folders only, no name or time in its header", () => {
    const archive = join(out, archiveName(v));
    const by = join(tree.tmp, "by-hand.tar.gz");
    const documented = run(["sh", "-c", `git archive --format=tar --prefix=kitespan-${v}/ HEAD | gzip -n -9 > "$1"`, "sh", by], tree.repo);
    expect(documented.code, documented.err).toBe(0);
    expect(sha256(readFileSync(archive))).toBe(sha256(readFileSync(by)));
    const gz = readFileSync(archive);
    expect([gz[0], gz[1], gz[4], gz[5], gz[6], gz[7]]).toEqual([0x1f, 0x8b, 0, 0, 0, 0]);
    const entries = tar(archive, "-tzf").trim().split("\n");
    expect(entries.length).toBeLessThan(20_000);
    for (const e of entries) expect(e.startsWith(`kitespan-${v}/`) && !e.split("/").includes("..")).toBe(true);
    const files = entries.filter((e) => !e.endsWith("/")).map((e) => e.slice(`kitespan-${v}/`.length)).sort();
    expect(files).toEqual(git(tree.repo, "ls-files").split("\n").sort());
    for (const l of tar(archive, "-tvzf").trim().split("\n")) expect(l[0] === "-" || l[0] === "d").toBe(true);
  });

  test("in the archive: the commit's package.json version, install.sh and the start scripts with no CR byte", () => {
    const archive = join(out, archiveName(v));
    const one = (f: string) => must(["tar", "-xzOf", archive, `kitespan-${v}/${f}`], tree.tmp);
    expect((JSON.parse(one("package.json")) as { version: string }).version).toBe(v);
    for (const f of ["install.sh", "bin/kitespan", "bin/update.sh"]) {
      expect(one(f).length, f).toBeGreaterThan(0);
      expect(one(f).includes("\r"), f).toBe(false);
    }
  });

  test("SHA256SUMS: the archive's line, then install.sh's, in sha256sum's text form; install.sh is the commit's own, byte for byte", () => {
    expect(bytes(out, "install.sh").equals(readFileSync(join(tree.repo, "install.sh")))).toBe(true);
    expect(bytes(out, "SHA256SUMS").toString()).toBe(`${sha256(bytes(out, archiveName(v)))}  ${archiveName(v)}\n${sha256(bytes(out, "install.sh"))}  install.sh\n`);
    // The README's own check: sha256sum, or shasum -a 256 on macOS (which has no sha256sum). Each one on the PATH that
    // run() gives (Bun's folder, /usr/bin and /bin: the test's own PATH may hold others, such as Homebrew's), and one
    // at least.
    const path = baseEnv().PATH;
    const checks = [
      ["sha256sum", "-c", "SHA256SUMS"],
      ["shasum", "-a", "256", "-c", "SHA256SUMS"],
    ].filter((cmd) => Bun.which(cmd[0]!, { PATH: path }) !== null);
    expect(checks.length).toBeGreaterThan(0);
    for (const cmd of checks) {
      const check = run(cmd, out);
      expect(check.code, `${cmd[0]}: ${check.err}`).toBe(0);
      expect(check.out.trim().split("\n")).toEqual([`${archiveName(v)}: OK`, "install.sh: OK"]);
    }
  });

  test("kitespan.rb: the template with the version and the archive's SHA-256 in its code, its comments as they are", () => {
    const formula = bytes(out, "kitespan.rb").toString();
    const digest = sha256(bytes(out, archiveName(v)));
    const expected = TEMPLATE.split("\n").map((l) => (/^\s*#/.test(l) ? l : l.replaceAll("@VERSION@", v).replace("@SHA256@", digest))).join("\n");
    expect(formula).toBe(expected);
    expect(formula.split("\n")).toContain(`  url "${RELEASES_URL}/download/${releaseTag(v)}/${archiveName(v)}"`);
    expect(formula.split("\n")).toContain(`  sha256 "${digest}"`);
    for (const l of formula.split("\n").filter((x) => !/^\s*#/.test(x))) expect(l).not.toMatch(/@[A-Z0-9_]+@/);
    if (Bun.which("ruby")) expect(must(["ruby", "-c", join(out, "kitespan.rb")], out).trim()).toBe("Syntax OK");
  });

  test("release-notes.md: the version, the two ways to install, and how to check the files", () => {
    expect(bytes(out, "release-notes.md").toString()).toBe(
      [
        `kitespan ${v}`,
        "",
        `Install: \`curl -fsSL https://github.com/${RELEASE_REPO}/releases/latest/download/install.sh | sh\`, or \`brew install ${BREW_FORMULA}\`.`,
        "",
        `\`kitespan-${v}.tar.gz\` is \`git archive\` of the tag \`v${v}\`; \`SHA256SUMS\` holds its SHA-256 and install.sh's. To check`,
        `their build provenance: \`gh attestation verify kitespan-${v}.tar.gz --repo ${RELEASE_REPO}\`.`,
        "",
      ].join("\n"),
    );
    expect(releaseNotes(v)).toBe(bytes(out, "release-notes.md").toString());
  });

  test("the same bytes at every run, and from the tag's own ref (refs/tags/v<version>) when --ref is not given", () => {
    git(tree.repo, "tag", releaseTag(v));
    const again = outDir("again");
    const r = release(tree, ["--tag", releaseTag(v), "--out", again]);
    expect(r.code, r.err).toBe(0);
    for (const f of FILES(v)) expect(bytes(again, f).equals(bytes(out, f)), f).toBe(true);
  });

  test("an empty folder is taken; a folder with a file in it, or a file, is refused and left as it was", () => {
    const empty = outDir("empty");
    mkdirSync(empty);
    expect(release(tree, ["--tag", releaseTag(v), "--ref", "HEAD", "--out", empty]).code).toBe(0);
    expect(readdirSync(empty).sort()).toEqual(FILES(v));
    const full = outDir("full");
    mkdirSync(full);
    writeFileSync(join(full, "keep"), "x");
    const r = release(tree, ["--tag", releaseTag(v), "--ref", "HEAD", "--out", full]);
    expect([r.code, r.err.trim()]).toEqual([1, `release.ts: ${full} is not an empty folder.`]);
    expect(readdirSync(full)).toEqual(["keep"]);
    const file = join(full, "keep");
    const f = release(tree, ["--tag", releaseTag(v), "--ref", "HEAD", "--out", file]);
    expect([f.code, f.err.trim()]).toEqual([1, `release.ts: ${file} is not an empty folder.`]);
  });

  test("a tag that is not v and a release version is refused before anything is made", () => {
    for (const tag of ["0.1.0", "v0.1", "v0.1.0-rc.1", "v0.1.0+build.1", "v01.0.0", "V0.1.0", "v0.1.0.1", "v 0.1.0", "v0.1.0\n"]) {
      const dir = outDir(`bad-${createHash("sha1").update(tag).digest("hex").slice(0, 8)}`);
      const r = release(tree, ["--tag", tag, "--ref", "HEAD", "--out", dir]);
      expect([tag, r.code, r.err.trim()]).toEqual([tag, 1, `release.ts: ${tag} is not a release tag such as v0.1.0.`.trim()]);
      expect(existsSync(dir)).toBe(false);
    }
  });

  test("a tag that is not v + package.json's version at the ref is refused, and so is a ref that does not exist", () => {
    const dir = outDir("other");
    const r = release(tree, ["--tag", "v9.9.9", "--ref", "HEAD", "--out", dir]);
    expect([r.code, r.err.trim()]).toEqual([1, `release.ts: the tag v9.9.9 is not v${v} of package.json at HEAD.`]);
    const none = release(tree, ["--tag", "v9.9.9", "--out", dir]);
    expect(none.code).toBe(1);
    expect(none.err).toStartWith("release.ts: git show refs/tags/v9.9.9:package.json failed: ");
    expect(existsSync(dir)).toBe(false);
  });

  test("in a GitHub Actions run of a repository other than RELEASE_REPO it refuses before anything is made; in RELEASE_REPO (in any case) it goes on", () => {
    // install.sh, the update check, the formula and the notes download from RELEASE_REPO: a release made anywhere else
    // would send every user to that repository's files.
    const dir = outDir("repository");
    const other = release(tree, ["--tag", releaseTag(v), "--ref", "HEAD", "--out", dir], { GITHUB_REPOSITORY: "someone-else/kitespan" });
    expect([other.code, other.err.trim()]).toEqual([1, `release.ts: this repository is someone-else/kitespan, but shared/release.ts RELEASE_REPO is ${RELEASE_REPO}, which install.sh, the update check, the formula and the notes download from.`]);
    expect(existsSync(dir)).toBe(false);
    const same = release(tree, ["--tag", releaseTag(v), "--ref", "HEAD", "--out", dir], { GITHUB_REPOSITORY: RELEASE_REPO.toUpperCase() });
    expect([same.code, same.err]).toEqual([0, ""]);
    expect(readdirSync(dir).sort()).toEqual(FILES(v));
  });

  test("a formula template without its placeholders, or with an unknown one, is refused before anything is made", () => {
    const branch = (name: string, text: string) => {
      git(tree.repo, "switch", "--quiet", "-c", name, "main");
      writeFileSync(join(tree.repo, "packaging/homebrew/kitespan.rb"), text);
      git(tree.repo, "commit", "--quiet", "--no-verify", "-am", name);
      git(tree.repo, "switch", "--quiet", "main");
    };
    branch("no-digest", TEMPLATE.replace('sha256 "@SHA256@"', 'sha256 "0"'));
    branch("unknown", TEMPLATE.replace('license "Apache-2.0"', 'license "@LICENSE@"'));
    const dir = outDir("template");
    const a = release(tree, ["--tag", releaseTag(v), "--ref", "no-digest", "--out", dir]);
    expect([a.code, a.err.trim()]).toEqual([1, "release.ts: packaging/homebrew/kitespan.rb has no @VERSION@, or not exactly one @SHA256@, in its code."]);
    const b = release(tree, ["--tag", releaseTag(v), "--ref", "unknown", "--out", dir]);
    expect([b.code, b.err.trim()]).toEqual([1, "release.ts: packaging/homebrew/kitespan.rb still holds @LICENSE@ once it is filled in."]);
    expect(existsSync(dir)).toBe(false);
    expect(() => fillFormula("# @SHA256@\nurl @VERSION@\nsha256 @SHA256@\n", "1.2.3", "d")).not.toThrow();
    expect(fillFormula("# @VERSION@ @SHA256@\nurl @VERSION@/@VERSION@\nsha256 @SHA256@\n", "1.2.3", "d")).toBe("# @VERSION@ @SHA256@\nurl 1.2.3/1.2.3\nsha256 d\n");
  });

  test("sh scripts committed with CRLF line ends come out of the archive with LF (.gitattributes)", () => {
    git(tree.repo, "switch", "--quiet", "-c", "crlf", "main");
    writeFileSync(join(tree.repo, "scripts/crlf-probe.sh"), "#!/bin/sh\r\necho one\r\n");
    writeFileSync(join(tree.repo, "bin/crlf-probe"), "#!/bin/sh\r\necho two\r\n");
    git(tree.repo, "add", "scripts/crlf-probe.sh", "bin/crlf-probe");
    git(tree.repo, "commit", "--quiet", "--no-verify", "-m", "crlf");
    git(tree.repo, "switch", "--quiet", "main");
    const dir = outDir("crlf");
    const r = release(tree, ["--tag", releaseTag(v), "--ref", "crlf", "--out", dir]);
    expect(r.code, r.err).toBe(0);
    const archive = join(dir, archiveName(v));
    expect(must(["tar", "-xzOf", archive, `kitespan-${v}/scripts/crlf-probe.sh`], tree.tmp)).toBe("#!/bin/sh\necho one\n");
    expect(must(["tar", "-xzOf", archive, `kitespan-${v}/bin/crlf-probe`], tree.tmp)).toBe("#!/bin/sh\necho two\n");
  });

  test("usage errors exit 2 and make nothing", () => {
    for (const args of [[], ["--tag"], ["--tag", releaseTag(v)], ["--out", outDir("u")], ["--bogus", "x"], ["--tag", releaseTag(v), "--tag", releaseTag(v), "--out", outDir("u")]]) {
      const r = release(tree, args);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), 2]);
      expect(r.err).toContain("Usage: bun scripts/release.ts --tag v<version> --out <folder> [--ref <commit>]");
    }
    expect(existsSync(outDir("u"))).toBe(false);
  });
});
