// A release's files (DESIGN-I1 1 and 5.3), made from one commit of this repository: kitespan-<v>.tar.gz (git archive of
// the tag), install.sh (the tag's own, byte for byte), SHA256SUMS (the two of them), kitespan.rb (the Homebrew formula
// with the version and the archive's SHA-256 filled in) and release-notes.md, in an empty or new folder. It imports only
// shared/release.ts and node: and Bun built-ins, so it runs with no `bun install`. release.yml's archive job runs it;
// it publishes nothing.
//
// Usage: bun scripts/release.ts --tag v<version> --out <folder> [--ref <commit>]
//
// The tag must be v + the version in package.json at the ref (refs/tags/<tag> unless --ref names another, for a test or
// a trial). In a GitHub Actions run (GITHUB_REPOSITORY), the repository must be RELEASE_REPO, the one that install.sh,
// the update check, the formula and the notes download from. Every check runs before anything is made. Exit 0 done; 1 a
// refusal or a failed step; 2 a usage error.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { archiveName, BREW_FORMULA, INSTALLER_FILE, RELEASE_REPO, RELEASE_VERSION, RELEASES_URL, releaseTag, SUMS_FILE } from "../shared/release";

const ROOT = resolve(import.meta.dir, "..");
const FORMULA = "packaging/homebrew/kitespan.rb";
/** v and a release version, nothing else. */
const TAG = new RegExp(`^v${RELEASE_VERSION.source.slice(1)}`);
const USAGE = "Usage: bun scripts/release.ts --tag v<version> --out <folder> [--ref <commit>]";

class Refusal extends Error {}

function usage(line: string): never {
  console.error(`release.ts: ${line}\n${USAGE}`);
  process.exit(2);
}

function args(argv: string[]): { tag: string; out: string; ref: string | null } {
  const got = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!;
    if (name !== "--tag" && name !== "--out" && name !== "--ref") usage(`unknown option ${name}`);
    if (got.has(name)) usage(`${name} is given twice`);
    const value = argv[i + 1];
    if (value === undefined || value === "") usage(`${name} needs a value`);
    got.set(name, value);
  }
  const tag = got.get("--tag");
  const out = got.get("--out");
  if (tag === undefined) usage("--tag is missing");
  if (out === undefined) usage("--out is missing");
  return { tag, out: resolve(out), ref: got.get("--ref") ?? null };
}

/** git's environment: the user's, without the variables that would point git at another repository. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"].includes(k)) env[k] = v;
  return env;
}

/** A file of the commit, as git stores it (the bytes of `git show <ref>:<path>`). */
function show(ref: string, path: string): Buffer {
  const r = Bun.spawnSync(["git", "-C", ROOT, "show", `${ref}:${path}`], { env: gitEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Refusal(`git show ${ref}:${path} failed: ${r.stderr.toString().trim().split("\n").at(-1) ?? `exit ${r.exitCode}`}`);
  return r.stdout;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The formula's template with the version and the archive's digest in place of each @VERSION@ and the one @SHA256@ of
 * its code. Comment lines stay as they are (the header names the placeholders to say how the file is made).
 */
export function fillFormula(template: string, version: string, digest: string): string {
  const lines = template.split("\n");
  const code = (l: string) => !/^\s*#/.test(l);
  const count = (token: string) => lines.filter(code).reduce((n, l) => n + l.split(token).length - 1, 0);
  if (count("@VERSION@") === 0 || count("@SHA256@") !== 1) throw new Refusal(`${FORMULA} has no @VERSION@, or not exactly one @SHA256@, in its code.`);
  const filled = lines.map((l) => (code(l) ? l.replaceAll("@VERSION@", version).replace("@SHA256@", digest) : l));
  for (const l of filled) {
    const left = code(l) ? /@[A-Z0-9_]+@/.exec(l) : null;
    if (left) throw new Refusal(`${FORMULA} still holds ${left[0]} once it is filled in.`);
  }
  return filled.join("\n");
}

/** The release notes: what the release is, the two ways to install it, and how to check its files. */
export function releaseNotes(version: string): string {
  const archive = archiveName(version);
  return [
    `kitespan ${version}`,
    "",
    `Install: \`curl -fsSL ${RELEASES_URL}/latest/download/${INSTALLER_FILE} | sh\`, or \`brew install ${BREW_FORMULA}\`.`,
    "",
    `\`${archive}\` is \`git archive\` of the tag \`${releaseTag(version)}\`; \`${SUMS_FILE}\` holds its SHA-256 and ${INSTALLER_FILE}'s. To check`,
    `their build provenance: \`gh attestation verify ${archive} --repo ${RELEASE_REPO}\`.`,
    "",
  ].join("\n");
}

/** `git archive --format=tar --prefix=kitespan-<v>/ <ref> | gzip -n -9 > <file>`: the programs themselves, so the bytes are the ones that command makes. */
async function archive(ref: string, version: string, file: string): Promise<void> {
  const git = Bun.spawn(["git", "-C", ROOT, "archive", "--format=tar", `--prefix=kitespan-${version}/`, ref], { env: gitEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const gzip = Bun.spawn(["gzip", "-n", "-9"], { stdin: git.stdout, stdout: Bun.file(file), stderr: "pipe" });
  const [g, z] = await Promise.all([git.exited, gzip.exited]);
  if (g !== 0) throw new Refusal(`git archive ${ref} exited ${g}: ${(await new Response(git.stderr).text()).trim().split("\n").at(-1) ?? ""}`);
  if (z !== 0) throw new Refusal(`gzip exited ${z}: ${(await new Response(gzip.stderr).text()).trim().split("\n").at(-1) ?? ""}`);
}

async function main(argv: string[]): Promise<void> {
  const o = args(argv);
  // GitHub's owner and repository names are not case-sensitive.
  const here = process.env.GITHUB_REPOSITORY;
  if (here && here.toLowerCase() !== RELEASE_REPO.toLowerCase()) {
    throw new Refusal(`this repository is ${here}, but shared/release.ts RELEASE_REPO is ${RELEASE_REPO}, which install.sh, the update check, the formula and the notes download from.`);
  }
  if (!TAG.test(o.tag)) throw new Refusal(`${o.tag} is not a release tag such as v0.1.0.`);
  const version = o.tag.slice(1);
  const ref = o.ref ?? `refs/tags/${o.tag}`;

  // Every check before anything is made: the version at the ref, the installer and the formula's template there, and
  // an empty or new folder.
  let stated: unknown;
  try {
    stated = (JSON.parse(show(ref, "package.json").toString("utf8")) as { version?: unknown }).version;
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal(`package.json at ${ref} is not JSON.`);
  }
  if (stated !== version) throw new Refusal(`the tag ${o.tag} is not v${typeof stated === "string" ? stated : "(none)"} of package.json at ${ref}.`);
  const installer = show(ref, INSTALLER_FILE);
  const template = show(ref, FORMULA).toString("utf8");
  fillFormula(template, version, "0".repeat(64));
  if (existsSync(o.out)) {
    if (!statSync(o.out).isDirectory() || readdirSync(o.out).length > 0) throw new Refusal(`${o.out} is not an empty folder.`);
  } else mkdirSync(o.out, { recursive: true });

  const files: string[] = [];
  const tarball = join(o.out, archiveName(version));
  await archive(ref, version, tarball);
  files.push(tarball);
  const installerPath = join(o.out, INSTALLER_FILE);
  writeFileSync(installerPath, installer, { mode: 0o755 });
  files.push(installerPath);
  const digest = sha256(readFileSync(tarball));
  const sums = join(o.out, SUMS_FILE);
  writeFileSync(sums, `${digest}  ${archiveName(version)}\n${sha256(installer)}  ${INSTALLER_FILE}\n`);
  files.push(sums);
  const formula = join(o.out, "kitespan.rb");
  writeFileSync(formula, fillFormula(template, version, digest));
  files.push(formula);
  const notes = join(o.out, "release-notes.md");
  writeFileSync(notes, releaseNotes(version));
  files.push(notes);
  for (const f of files) console.log(`${sha256(readFileSync(f))}  ${f}`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.error(`release.ts: ${e.message}`);
    process.exit(1);
  }
}
