// The sign-off check of a pull request (CONTRIBUTING: the Developer Certificate of Origin 1.1,
// https://developercertificate.org/; P1 DESIGN 4.6). Every commit of the range needs a `Signed-off-by:` trailer, read as
// git reads trailers (the last paragraph of the message, so a line of that form in the middle of the body does not
// count), that names the commit's author: the same name, after trimming, and the same email, in any case. Other
// sign-offs may be there too. Only a clean merge is skipped: two parents, and the tree that git's own merge of them
// gives (`git merge-tree --write-tree`, git 2.38 or later), such as GitHub's Update branch makes. A merge with changes of
// its own (a conflict resolved by hand, a hand-made "merge", more than two parents) is checked as any commit is.
// Dependabot's own commits are skipped only in Dependabot's own pull request (`--pr-author dependabot[bot]`): a bot
// cannot certify the DCO, and any other commit there needs its own sign-off.
//
// Usage: bun scripts/dco.ts --base <commit> --head <commit> [--pr-author <login>] [--repo <folder>]
//
// It uses git and Bun only, and imports nothing of the repository's: CI runs the base commit's copy of this file from a
// folder of its own, so a pull request cannot change the rule it is checked by. Exit 0: every commit is signed off.
// Exit 1: at least one is not (one line each, then how to fix it). Exit 2: the check could not run.

export const DEPENDABOT = { login: "dependabot[bot]", name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };

export interface DcoOptions {
  repo: string;
  base: string;
  head: string;
  prAuthor?: string;
}

export interface DcoResult {
  /** The commits that were checked, oldest first. */
  checked: string[];
  /** Clean merges in the range (two parents, and git's own merge of them as the tree): never checked. */
  merges: number;
  /** Dependabot's own commits in its own pull request: never checked. */
  bot: number;
  /** One line per commit that is not signed off by its author. */
  failures: string[];
}

class CannotRun extends Error {}

function git(repo: string, args: string[]): string {
  // No pager, no prompt, and paths and messages as they are.
  const r = Bun.spawnSync(["git", "-C", repo, "-c", "core.quotePath=false", "--no-pager", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.exitCode !== 0) throw new CannotRun(`git ${args[0]}: ${r.stderr.toString().trim().split("\n")[0] || `exit ${r.exitCode}`}`);
  return r.stdout.toString();
}

function commitOf(repo: string, rev: string, what: string): string {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]).trim();
  } catch {
    throw new CannotRun(`the ${what} commit ${rev} is not in this clone (CI checks out with fetch-depth: 0)`);
  }
}

/**
 * True when a merge brings no change of its own: two parents, and its tree is the one that git's own merge of them gives.
 * A conflict (exit 1), an error or another tree: false, so the merge is checked as any commit is.
 */
function cleanMerge(repo: string, tree: string, parents: readonly string[]): boolean {
  if (parents.length !== 2) return false;
  const r = Bun.spawnSync(["git", "-C", repo, "--no-pager", "merge-tree", "--write-tree", "--end-of-options", parents[0]!, parents[1]!], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return r.exitCode === 0 && r.stdout.toString().split("\n")[0]!.trim() === tree;
}

/** `Name <email>` of one trailer value; null when it is not of that form. */
export function parseSignoff(value: string): { name: string; email: string } | null {
  const m = /^(.*?)\s*<([^<>\s]+)>\s*$/.exec(value.trim());
  return m ? { name: m[1]!.trim(), email: m[2]! } : null;
}

/** True when one of the sign-offs names this author: the name exactly (trimmed), the email in any case. */
export function signedBy(signoffs: readonly string[], name: string, email: string): boolean {
  return signoffs.some((v) => {
    const s = parseSignoff(v);
    return s !== null && s.name === name.trim() && s.email.toLowerCase() === email.trim().toLowerCase();
  });
}

export function checkDco(o: DcoOptions): DcoResult {
  const base = commitOf(o.repo, o.base, "base");
  const head = commitOf(o.repo, o.head, "head");
  const range = `${base}..${head}`;
  const all = git(o.repo, ["rev-list", "--reverse", range]).split("\n").filter(Boolean);
  const result: DcoResult = { checked: [], merges: 0, bot: 0, failures: [] };
  const botPullRequest = o.prAuthor === DEPENDABOT.login;
  for (const sha of all) {
    const [name = "", email = "", tree = "", parentList = "", trailers = ""] = git(o.repo, [
      "log",
      "-1",
      "--no-mailmap",
      "--format=%an%x00%ae%x00%T%x00%P%x00%(trailers:key=Signed-off-by,valueonly,unfold,separator=%x1f)",
      sha,
    ])
      .replace(/\n$/, "")
      .split("\0");
    const parents = parentList.split(" ").filter(Boolean);
    if (parents.length > 1 && cleanMerge(o.repo, tree, parents)) {
      result.merges++;
      continue;
    }
    if (botPullRequest && name === DEPENDABOT.name && email === DEPENDABOT.email) {
      result.bot++;
      continue;
    }
    result.checked.push(sha);
    const signoffs = trailers.split("\x1f").map((s) => s.trim()).filter(Boolean);
    const who = `${name.trim()} <${email.trim()}>`;
    const merge = parents.length > 2 ? "; a merge of more than two parents is checked too" : parents.length === 2 ? "; this merge has changes of its own" : "";
    if (!signoffs.length) result.failures.push(`${sha.slice(0, 12)}: no Signed-off-by: trailer (the author is ${who})${merge}`);
    else if (!signedBy(signoffs, name, email)) result.failures.push(`${sha.slice(0, 12)}: no Signed-off-by: trailer names the author, ${who}${merge}`);
  }
  return result;
}

const USAGE = "Usage: bun scripts/dco.ts --base <commit> --head <commit> [--pr-author <login>] [--repo <folder>]";

function main(argv: string[]): number {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return 0;
    }
    if (!["--base", "--head", "--pr-author", "--repo"].includes(a)) {
      console.error(`dco: unknown argument "${a}"\n${USAGE}`);
      return 2;
    }
    const v = argv[++i];
    if (v === undefined || v === "") {
      console.error(`dco: ${a} needs a value\n${USAGE}`);
      return 2;
    }
    opts[a.slice(2)] = v;
  }
  if (!opts.base || !opts.head) {
    console.error(USAGE);
    return 2;
  }
  let r: DcoResult;
  try {
    r = checkDco({ repo: opts.repo ?? process.cwd(), base: opts.base, head: opts.head, prAuthor: opts["pr-author"] });
  } catch (e) {
    console.error(`dco: ${(e as Error).message}`);
    return 2;
  }
  const skipped = [r.merges && `${r.merges} clean merge commit${r.merges === 1 ? "" : "s"}`, r.bot && `${r.bot} of Dependabot's own`].filter(Boolean);
  const also = skipped.length ? `; skipped: ${skipped.join(", ")}` : "";
  if (!r.failures.length) {
    console.log(`dco: ${r.checked.length ? `${r.checked.length} commit${r.checked.length === 1 ? "" : "s"}, each signed off by its author` : "no commit to check"}${also}`);
    return 0;
  }
  for (const f of r.failures) console.log(f);
  console.log(`dco: ${r.failures.length} of ${r.checked.length} commits are not signed off by their author${also}.`);
  console.log("dco: sign each commit off with your author name and email (git commit -s), for example with");
  console.log(`dco:   git rebase --signoff ${opts.base}`);
  console.log("dco: and push again with --force-with-lease. A sign-off certifies the Developer Certificate of Origin 1.1: https://developercertificate.org/");
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
