// How kitespan was installed (DESIGN-I1 3.1; server/update/kind.ts), from mkdtemp layouts: a Homebrew keg (with and
// without its receipt), install.sh's version folder (its name and package.json's version, a .git, the folders' names),
// and anything else a checkout; then the root that the next start runs: a release's `current` link (moved, dangling,
// pointing outside versions/) and brew's opt link (moved, missing, pointing elsewhere).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentVersion, installKind, nextRoot, versionAt, type Install } from "../../server/update/kind";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-update-kind-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

/** A kitespan folder: package.json with `version` (none when null). */
function app(dir: string, version: string | null): string {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "kitespan", ...(version === null ? {} : { version }) }));
  writeFileSync(join(dir, "bin", "kitespan"), "#!/bin/sh\n");
  return dir;
}

/** install.sh's layout: <base>/kitespan/versions/<v>... with `current` naming `cur` (none when null). */
function release(versions: string[], cur: string | null, o: { kitName?: string; versionsName?: string } = {}) {
  const base = join(ROOT, `rel-${++n}`);
  const kit = join(base, o.kitName ?? "kitespan");
  const vdir = join(kit, o.versionsName ?? "versions");
  for (const v of versions) app(join(vdir, v), v);
  if (cur !== null) symlinkSync(`${o.versionsName ?? "versions"}/${cur}/bin/kitespan`, join(kit, "current"));
  return { base, kit, vdir };
}

/** Homebrew's layout: <prefix>/Cellar/kitespan/<x>/libexec, the receipt, and opt naming `opt` (none when null). */
function brew(kegs: string[], opt: string | null, receipt = true) {
  const prefix = join(ROOT, `brew-${++n}`);
  for (const k of kegs) {
    app(join(prefix, "Cellar", "kitespan", k, "libexec"), k.replace(/_\d+$/, ""));
    if (receipt) writeFileSync(join(prefix, "Cellar", "kitespan", k, "INSTALL_RECEIPT.json"), "{}");
  }
  mkdirSync(join(prefix, "opt"), { recursive: true });
  if (opt !== null) symlinkSync(`../Cellar/kitespan/${opt}`, join(prefix, "opt", "kitespan"));
  return { prefix, keg: (k: string) => join(prefix, "Cellar", "kitespan", k), libexec: (k: string) => join(prefix, "Cellar", "kitespan", k, "libexec") };
}

describe("the kind, from the real root (DESIGN-I1 3.1)", () => {
  test("a version folder of install.sh: <kit>/versions/<v> whose package.json says <v>, kit named kitespan, no .git", () => {
    const r = release(["0.1.0"], "0.1.0");
    const root = join(r.vdir, "0.1.0");
    const i = installKind(root, versionAt(root));
    expect(i).toEqual({ kind: "release", root, version: "0.1.0", kit: r.kit, versions: r.vdir, current: join(r.kit, "current") });
  });

  test("not a release: another version in package.json, none, a .git, another folder name, a name that is no version", () => {
    const r = release(["0.1.0", "0.2.0"], "0.1.0");
    expect(installKind(join(r.vdir, "0.1.0"), "0.1.1").kind).toBe("checkout");
    expect(installKind(join(r.vdir, "0.1.0"), null).kind).toBe("checkout");
    mkdirSync(join(r.vdir, "0.2.0", ".git"));
    expect(installKind(join(r.vdir, "0.2.0"), "0.2.0").kind).toBe("checkout");
    const other = release(["0.1.0"], "0.1.0", { kitName: "kitespan-old" });
    expect(installKind(join(other.vdir, "0.1.0"), "0.1.0").kind).toBe("checkout");
    const named = release(["0.1.0"], null, { versionsName: "builds" });
    expect(installKind(join(named.vdir, "0.1.0"), "0.1.0").kind).toBe("checkout");
    for (const v of ["0.1.0-rc.1", "01.2.3", "v0.1.0", "0.1"]) {
      const odd = release([v], null);
      expect([v, installKind(join(odd.vdir, v), v).kind]).toEqual([v, "checkout"]);
    }
  });

  test("a Homebrew keg: .../Cellar/kitespan/<x>/libexec with the keg's INSTALL_RECEIPT.json; without the receipt, a checkout", () => {
    const b = brew(["0.1.0"], "0.1.0");
    const root = b.libexec("0.1.0");
    expect(installKind(root, "0.1.0")).toEqual({ kind: "brew", root, keg: b.keg("0.1.0"), prefix: b.prefix, opt: join(b.prefix, "opt", "kitespan", "libexec") });
    // A revision of the same version is a keg of its own.
    const rev = brew(["0.1.0_1"], "0.1.0_1");
    expect(installKind(rev.libexec("0.1.0_1"), "0.1.0").kind).toBe("brew");
    const bare = brew(["0.1.0"], "0.1.0", false);
    expect(installKind(bare.libexec("0.1.0"), "0.1.0").kind).toBe("checkout");
    // A folder in the receipt's place is not Homebrew's file.
    const dirReceipt = brew(["0.1.0"], "0.1.0", false);
    mkdirSync(join(dirReceipt.keg("0.1.0"), "INSTALL_RECEIPT.json"));
    expect(installKind(dirReceipt.libexec("0.1.0"), "0.1.0").kind).toBe("checkout");
  });

  test("anything else is a checkout, and its next root is its own", () => {
    const dir = app(join(ROOT, `checkout-${++n}`), "0.1.0");
    const i = installKind(dir, "0.1.0");
    expect(i).toEqual({ kind: "checkout", root: dir });
    expect(nextRoot(i)).toBe(dir);
  });

  test("versionAt: package.json's version, or null for none, a bad one or no file", () => {
    expect(versionAt(app(join(ROOT, `v-${++n}`), "0.3.1"))).toBe("0.3.1");
    expect(versionAt(app(join(ROOT, `v-${++n}`), null))).toBeNull();
    const bad = app(join(ROOT, `v-${++n}`), null);
    writeFileSync(join(bad, "package.json"), "{ not json");
    expect(versionAt(bad)).toBeNull();
    expect(versionAt(join(ROOT, "nothing-here"))).toBeNull();
  });
});

describe("the next start's root, read again at each look (DESIGN-I1 3.1)", () => {
  test("a release: the version folder that current names, as current moves; null for a dangling or a stray link", () => {
    const r = release(["0.1.0", "0.1.1"], "0.1.0");
    const i = installKind(join(r.vdir, "0.1.0"), "0.1.0") as Extract<Install, { kind: "release" }>;
    expect(nextRoot(i)).toBe(join(r.vdir, "0.1.0"));
    expect(currentVersion(i)).toBe("0.1.0");
    unlinkSync(join(r.kit, "current"));
    symlinkSync("versions/0.1.1/bin/kitespan", join(r.kit, "current"));
    expect(nextRoot(i)).toBe(join(r.vdir, "0.1.1"));
    expect(currentVersion(i)).toBe("0.1.1");
    unlinkSync(join(r.kit, "current"));
    symlinkSync("versions/0.9.0/bin/kitespan", join(r.kit, "current"));
    expect(nextRoot(i)).toBeNull();
    expect(currentVersion(i)).toBeNull();
    // A link to a kitespan outside versions/ is not install.sh's.
    const stray = app(join(ROOT, `stray-${++n}`, "0.1.2"), "0.1.2");
    unlinkSync(join(r.kit, "current"));
    symlinkSync(join(stray, "bin", "kitespan"), join(r.kit, "current"));
    expect(nextRoot(i)).toBeNull();
    unlinkSync(join(r.kit, "current"));
    expect(nextRoot(i)).toBeNull();
  });

  test("brew: the keg that opt names, as `brew upgrade` moves it; null when opt is gone or names no kitespan keg", () => {
    const b = brew(["0.1.0", "0.1.1"], "0.1.0");
    const i = installKind(b.libexec("0.1.0"), "0.1.0");
    expect(nextRoot(i)).toBe(b.libexec("0.1.0"));
    unlinkSync(join(b.prefix, "opt", "kitespan"));
    symlinkSync("../Cellar/kitespan/0.1.1", join(b.prefix, "opt", "kitespan"));
    expect(nextRoot(i)).toBe(b.libexec("0.1.1"));
    unlinkSync(join(b.prefix, "opt", "kitespan"));
    expect(nextRoot(i)).toBeNull();
    mkdirSync(join(b.prefix, "elsewhere", "libexec"), { recursive: true });
    symlinkSync("../elsewhere", join(b.prefix, "opt", "kitespan"));
    expect(nextRoot(i)).toBeNull();
  });
});
