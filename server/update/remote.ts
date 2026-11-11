// "Update available" (DESIGN.md 4.10; build checklist S4, L18): origin's commit for the checkout's branch, by the
// ancestor rule, not by "the two differ" (a checkout that is ahead of its origin, as the owner's is, would show the
// line for ever, and an update would find nothing to pull).
//
// The branch is the checkout's own (none when HEAD is detached), its upstream the branch's configured remote and merge
// ref (`branch.<name>.remote` and `.merge`); no upstream, a remote with no URL or a URL of another transport shows
// nothing, as a normal state, with the reason (row 108: Check now says why it found nothing; an Update refuses with the
// same line). kitespan's folder must be the top of its checkout: a folder inside another repository is not one. Then
// `git ls-remote <url> <merge ref>` (git.ts: outside the repository, 10 s, no prompt) gives origin's commit:
// - not in the local objects: origin has new work, "Update available";
// - an ancestor of HEAD (or HEAD itself): nothing to pull, no line;
// - a descendant of HEAD (fetched, not merged yet): the update fast-forwards to it, "Update available";
// - neither: the two have diverged, and a fast-forward is refused: one line that says so.
// A read that fails (the network, the remote, a branch that origin no longer has) shows nothing; the caller logs its
// error code only. A read that found origin's commit names it, with its ref (row 108: update.json keeps them, so a
// restart reads the line again by the same rule against that commit, with no network: keptRemote).

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { CONTROL_CHARS } from "../../shared/protocol";
import type { UpdateRefusal } from "../../shared/update";
import { COMMIT_ID, REMOTE_FLAGS, runGit, type GitOptions } from "./git";

export type RemoteKind = "none" | "available" | "diverged";

export interface RemoteCheck {
  kind: RemoteKind;
  /** A configured upstream could not be read (logged as an error code); false for every normal state. */
  failed: boolean;
  /** Why the check could not look (no git, no checkout, no branch, no upstream, a URL it does not read); else absent. */
  why?: Extract<UpdateRefusal, "no_git" | "not_checkout" | "detached" | "no_upstream" | "remote">;
  /** Origin's commit that the line was read from, and the upstream's ref; absent when no commit was read. */
  origin?: OriginCommit;
}

/** Origin's commit for the branch's upstream (`ref`, a refs/heads/ name), as a check read it. */
export interface OriginCommit {
  commit: string;
  ref: string;
}

const NOTHING: RemoteCheck = { kind: "none", failed: false };
const FAILED: RemoteCheck = { kind: "none", failed: true };

/** A remote's name and a branch name as git config may hold them, with no option-like or control character start. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/;
const MERGE_REF = /^refs\/heads\/[A-Za-z0-9_][A-Za-z0-9._/-]{0,240}$/;

/** A kept OriginCommit as update.json may hold it, or null. */
export function originCommitOf(v: unknown): OriginCommit | null {
  const o = v as { commit?: unknown; ref?: unknown } | null;
  if (!o || typeof o !== "object" || typeof o.commit !== "string" || typeof o.ref !== "string" || !COMMIT_ID.test(o.commit) || !MERGE_REF.test(o.ref)) return null;
  return { commit: o.commit, ref: o.ref };
}

/**
 * A remote URL that ls-remote may read: http(s), ssh, git or file URLs, the scp-like ssh form (`user@host:path`), or
 * a local path. Never a remote helper (`<transport>::<address>`, `ext::`), another scheme, a value that starts with a
 * dash (an option to git or ssh), or one with a control character.
 */
export function remoteUrlOk(url: string): boolean {
  if (!url || url.length > 2048 || url.startsWith("-") || CONTROL_CHARS.test(url) || url.includes("::")) return false;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme) return ["http", "https", "ssh", "git", "file"].includes(scheme[1]!.toLowerCase());
  return true;
}

/** `git merge-base --is-ancestor a b`: true, false, or null when git could not say. */
export async function isAncestor(root: string, o: GitOptions, a: string, b: string): Promise<boolean | null> {
  const r = await runGit(o, root, ["merge-base", "--is-ancestor", a, b]);
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

async function configValue(root: string, o: GitOptions, key: string): Promise<string | null> {
  const r = await runGit(o, root, ["config", "--get", key]);
  const v = r.out.replace(/\n$/, "");
  return r.code === 0 && v ? v : null;
}

/** The checkout's branch and its upstream, as git config names them. */
export interface Upstream {
  branch: string;
  /** The remote's name (`branch.<name>.remote`). */
  remote: string;
  /** Its branch (`branch.<name>.merge`), a refs/heads/ name. */
  merge: string;
  url: string;
}

/** The real path of a folder, or the path itself when it cannot be read. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The upstream of the checkout whose top folder is `root`, or why there is none: no git, not the top of a checkout,
 * HEAD on no branch, no upstream (or one in this repository itself), a remote with no URL or one of another transport.
 */
export async function readUpstream(root: string, o: GitOptions): Promise<Upstream | { why: NonNullable<RemoteCheck["why"]> }> {
  if (!o.git) return { why: "no_git" };
  const top = await runGit(o, root, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || real(top.out.replace(/\n$/, "")) !== real(root)) return { why: "not_checkout" };
  const branchRead = await runGit(o, root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchRead.out.trim();
  if (branchRead.code !== 0 || !NAME.test(branch)) return { why: "detached" };
  const remote = await configValue(root, o, `branch.${branch}.remote`);
  const merge = await configValue(root, o, `branch.${branch}.merge`);
  if (!remote || remote === "." || !NAME.test(remote) || !merge || !MERGE_REF.test(merge)) return { why: "no_upstream" };
  const url = await configValue(root, o, `remote.${remote}.url`);
  if (!url) return { why: "no_upstream" };
  if (!remoteUrlOk(url)) return { why: "remote" };
  return { branch, remote, merge, url };
}

/** The check, once. `root` is the checkout's top folder. */
export async function checkRemote(root: string, o: GitOptions): Promise<RemoteCheck> {
  const up = await readUpstream(root, o);
  if ("why" in up) return { ...NOTHING, why: up.why };
  const { url, merge } = up;

  // Outside the repository: GIT_DIR names no repository, so none of its config applies. A relative local path is
  // the checkout's, as git reads it there.
  const listed = await runGit(o, isAbsolute(root) ? root : "/", [...REMOTE_FLAGS, "ls-remote", "--", url, merge], { ...o.env, GIT_DIR: "/dev/null" });
  if (listed.code !== 0) return FAILED;
  let remoteHead: string | null = null;
  for (const line of listed.out.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (ref === merge && sha && COMMIT_ID.test(sha)) remoteHead = sha;
  }
  if (!remoteHead) return FAILED;
  const r = await ancestorRule(root, o, remoteHead);
  return r.failed ? r : { ...r, origin: { commit: remoteHead, ref: merge } };
}

/** The ancestor rule for origin's commit against the checkout's objects and HEAD: local reads only. */
async function ancestorRule(root: string, o: GitOptions, remoteHead: string): Promise<RemoteCheck> {
  // rev-parse --verify --quiet: 0 for a commit in the local objects, 1 for none, anything else a failed read.
  const known = await runGit(o, root, ["rev-parse", "--verify", "--quiet", `${remoteHead}^{commit}`]);
  if (known.code === 1) return { kind: "available", failed: false };
  if (known.code !== 0) return FAILED;
  const behind = await isAncestor(root, o, remoteHead, "HEAD");
  if (behind === null) return FAILED;
  if (behind) return NOTHING;
  const ahead = await isAncestor(root, o, "HEAD", remoteHead);
  if (ahead === null) return FAILED;
  return { kind: ahead ? "available" : "diverged", failed: false };
}

/**
 * Origin's line again from the commit that the last check read (a start: update.json), by the ancestor rule, with no
 * network: a pull or an update since then shows nothing, a commit still missing shows Update available. Only while the
 * checkout's upstream is still the ref that commit was read for; else nothing, until the next check.
 */
export async function keptRemote(root: string, o: GitOptions, kept: OriginCommit): Promise<RemoteCheck> {
  const up = await readUpstream(root, o);
  if ("why" in up) return { ...NOTHING, why: up.why };
  if (up.merge !== kept.ref || !COMMIT_ID.test(kept.commit)) return NOTHING;
  const r = await ancestorRule(root, o, kept.commit);
  return r.failed ? r : { ...r, origin: kept };
}
