// How this kitespan was installed (DESIGN-I1 3.1), read once at start from the real path of the server's root (the
// folder above server/main.ts; bin/kitespan runs Bun with `--cwd=<pwd -P root>`, so it is a real path already):
//
// - `brew`: the root ends with /Cellar/kitespan/<x>/libexec and the keg (the folder above libexec) holds the regular
//   file INSTALL_RECEIPT.json, which Homebrew writes into every keg. Its `opt` is <prefix>/opt/kitespan/libexec, the
//   prefix four folders above the root: `brew upgrade` moves that link to the new keg.
// - `release`: install.sh's folder for one version, <kit>/versions/<v>, where kit's last part is kitespan, <v> passes
//   the version rule and equals package.json's version, and the root holds no .git. `<kit>/current` names the version
//   that kitespan starts (a link to versions/<v>/bin/kitespan; install.sh switches it).
// - `checkout`: anything else, today's source and its rules.
//
// nextRoot is the root that the next start runs, a real path, or null when it cannot be read. It is read again at each
// About read, preflight and spawn (never kept): a switch of `current` or of brew's opt link changes it.

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RELEASE_VERSION } from "../../shared/release";

export type InstallKindName = "checkout" | "release" | "brew";

export type Install =
  | { kind: "checkout"; root: string }
  | { kind: "release"; root: string; version: string; kit: string; versions: string; current: string }
  | { kind: "brew"; root: string; keg: string; prefix: string; opt: string };

const BREW_ROOT = /\/Cellar\/kitespan\/[^/]+\/libexec$/;

function lstatOf(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The `version` of `<root>/package.json`, or null when it has none that reads. */
export function versionAt(root: string): string | null {
  try {
    const st = lstatSync(join(root, "package.json"));
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const v = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown } | null)?.version;
    return typeof v === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The kind of the install whose real root is `root`, with `version` its package.json's version. */
export function installKind(root: string, version: string | null): Install {
  if (BREW_ROOT.test(root)) {
    const keg = dirname(root);
    if (lstatOf(join(keg, "INSTALL_RECEIPT.json"))?.isFile()) {
      const prefix = dirname(dirname(dirname(keg)));
      return { kind: "brew", root, keg, prefix, opt: join(prefix, "opt", "kitespan", "libexec") };
    }
  }
  const v = basename(root);
  const versions = dirname(root);
  const kit = dirname(versions);
  if (
    RELEASE_VERSION.test(v) &&
    v === version &&
    basename(versions) === "versions" &&
    basename(kit) === "kitespan" &&
    lstatOf(join(root, ".git")) === null
  ) {
    return { kind: "release", root, version: v, kit, versions, current: join(kit, "current") };
  }
  return { kind: "checkout", root };
}

/**
 * The root that the next start runs (a real path), or null when it cannot be read: a checkout's own root; a release's
 * version folder that `<kit>/current` names; brew's keg that opt names now.
 */
export function nextRoot(i: Install): string | null {
  if (i.kind === "checkout") return i.root;
  if (i.kind === "release") {
    const bin = realOf(i.current);
    if (!bin || basename(bin) !== "kitespan" || basename(dirname(bin)) !== "bin") return null;
    const t = dirname(dirname(bin));
    const versions = realOf(i.versions) ?? i.versions;
    return dirname(t) === versions && RELEASE_VERSION.test(basename(t)) ? t : null;
  }
  const t = realOf(i.opt);
  return t && BREW_ROOT.test(t) ? t : null;
}

/** The version that `<kit>/current` names (its version folder's name), or null. */
export function currentVersion(i: Extract<Install, { kind: "release" }>): string | null {
  const t = nextRoot(i);
  return t ? basename(t) : null;
}
