// The public-clean audit: search a git repository's tree and its whole history for what a public repository must not
// hold. The built-in detectors are generic; the names of a company, its hosts, its tools and its people come from a
// patterns file kept outside the repository.
//
// Usage: bun scripts/audit-public-clean.ts --repo <path> [--patterns <file>] [--scope <list>]
//
// --scope: only these of tree, history, message, author and ref, comma-separated (default: all five). CI's check job
// searches the tree only: on a public repository's pull requests, the history's author lines and sign-offs hold each
// contributor's own email by design.
//
// What it searches:
// - the tree: every file that git ls-files lists (tracked files, and untracked files that .gitignore does not
//   ignore), as it is on disk, and each file's path;
// - the history: every line that a commit of any ref adds (git log --all -p; a merge as its dense combined diff, so
//   only the lines that the merge itself brings), the paths those commits touch, each commit message, and the author
//   and committer lines;
// - the refs: every branch, tag, remote and other ref name, and each annotated tag's message and tagger line.
// Built-in detectors: 12-digit numbers that look like cloud account ids, cloud access key ids, private key headers,
// and email addresses other than a GitHub noreply address (an address at a domain that RFC 2606 reserves for
// examples, such as example.com, reaches no one and is not a hit).
// The patterns file: one JavaScript regular expression per line, matched case-insensitively ("/source/flags" sets
// the flags instead); blank lines and lines that start with # are skipped.
//
// It prints one line per hit (where it is, the rules that matched, an excerpt) and a summary. Exit 0: clean.
// Exit 1: at least one hit. Exit 2: the audit could not run (bad arguments, not a git repository, a bad pattern).
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Rule {
  name: string;
  /** The matched texts in one line (empty when the rule does not match). */
  find(line: string): string[];
}

export type Scope = "tree" | "history" | "message" | "author" | "ref";
export const SCOPES: readonly Scope[] = ["tree", "history", "message", "author", "ref"];
const SCOPE_LABEL: Record<Scope, string> = { tree: "tree", history: "history", message: "messages", author: "authors", ref: "refs" };

export interface Hit {
  scope: Scope;
  where: string;
  rules: string[];
  excerpt: string;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;

function allMatches(re: RegExp, line: string, keep: (m: RegExpExecArray) => boolean = () => true): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[0] === "") re.lastIndex++;
    else if (keep(m)) out.push(m[0]);
    if (out.length >= 20) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Built-in detectors

const ACCOUNT_ID = /(?<![\w.])\d{12}(?!\w)/g;
const UUID_HEAD = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-$/i;
const ACCESS_KEY_ID = /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
const EMAIL = /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;

/** True for an address that may stay in a public repository: a GitHub noreply address. */
export function isNoreply(address: string): boolean {
  const a = address.toLowerCase();
  return a.endsWith("@users.noreply.github.com") || a === "noreply@github.com";
}

/** True for a domain that RFC 2606 reserves for examples (example.com, .example, .test, .invalid, .localhost). */
export function isExampleDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return /(?:^|\.)example\.(?:com|net|org)$/.test(d) || /\.(?:example|test|invalid|localhost)$/.test(d);
}

export const DETECTORS: Rule[] = [
  {
    name: "account id",
    // Twelve digits on their own; the last group of a UUID is not one.
    find: (line) => allMatches(ACCOUNT_ID, line, (m) => !UUID_HEAD.test(line.slice(Math.max(0, m.index - 24), m.index))),
  },
  { name: "access key id", find: (line) => [...allMatches(ACCESS_KEY_ID, line), ...allMatches(GOOGLE_API_KEY, line)] },
  { name: "private key", find: (line) => allMatches(PRIVATE_KEY, line) },
  {
    name: "email address",
    find: (line) =>
      allMatches(EMAIL, line, (m) => {
        const [local, domain] = [m[0].slice(0, m[0].indexOf("@")), m[0].slice(m[0].indexOf("@") + 1)];
        if (isNoreply(m[0]) || isExampleDomain(domain)) return false;
        if (/^\d+(?:\.\d+)?x\./i.test(domain)) return false; // an image name such as icon@2x.png
        if (local === "git" && line[m.index + m[0].length] === ":") return false; // a git remote such as git@host:owner/repo
        return true;
      }),
  },
];

// ---------------------------------------------------------------------------------------------------------------
// The patterns file

/** Parse a patterns file: one regular expression per line; # starts a comment line. Throws on a bad pattern. */
export function parsePatterns(text: string, file = "the patterns file"): Rule[] {
  const rules: Rule[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const slashed = /^\/(.+)\/([dimsuvy]*)$/.exec(line);
    const source = slashed ? slashed[1]! : line;
    const flags = slashed ? slashed[2]! : "i";
    let re: RegExp;
    try {
      re = new RegExp(source, `${flags}g`);
    } catch (e) {
      throw new Error(`${file} line ${i + 1}: ${(e as Error).message}`);
    }
    re.lastIndex = 0;
    if (re.test("")) throw new Error(`${file} line ${i + 1}: the pattern matches an empty string`);
    rules.push({ name: `pattern ${line}`, find: (s) => allMatches(re, s) });
  });
  return rules;
}

// ---------------------------------------------------------------------------------------------------------------
// Matching

function excerpt(line: string, match: string): string {
  const flat = line.replace(/\s+/g, " ").trim();
  const at = Math.max(0, flat.indexOf(match.replace(/\s+/g, " ")));
  const from = Math.max(0, at - 60);
  const to = Math.min(flat.length, at + match.length + 60);
  return `${from > 0 ? "..." : ""}${flat.slice(from, to)}${to < flat.length ? "..." : ""}`;
}

/** The rules that match one line, with an excerpt around the first match; null when none matches. */
export function matchLine(line: string, rules: Rule[]): { rules: string[]; excerpt: string } | null {
  let first = "";
  const names: string[] = [];
  for (const r of rules) {
    const found = r.find(line);
    if (!found.length) continue;
    names.push(r.name);
    if (!first) first = found[0]!;
  }
  return names.length ? { rules: names, excerpt: excerpt(line, first) } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// git

async function git(cwd: string, args: string[], allowFail = false): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "core.quotePath=false", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !allowFail) throw new Error(`git ${args[0]} failed: ${err.trim().split("\n")[0] ?? `exit ${code}`}`);
  return code === 0 ? out : "";
}

/** Read a command's output line by line, without holding all of it in memory. */
async function eachLine(cwd: string, args: string[], onLine: (line: string) => void): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "core.quotePath=false", ...args], { stdout: "pipe", stderr: "pipe" });
  const errText = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += dec.decode(value, { stream: true });
    let nl = rest.indexOf("\n");
    while (nl >= 0) {
      onLine(rest.slice(0, nl));
      rest = rest.slice(nl + 1);
      nl = rest.indexOf("\n");
    }
  }
  rest += dec.decode();
  if (rest) onLine(rest);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${(await errText).trim().split("\n")[0] ?? `exit ${code}`}`);
}

/** A path from a diff header: as it is, or in git's quoted form ("b/caf\303\251 file"). */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const body = raw.slice(1, raw.lastIndexOf('"'));
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...new TextEncoder().encode(c));
      continue;
    }
    const n = body[i + 1] ?? "";
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(esc[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ---------------------------------------------------------------------------------------------------------------
// The audit

export interface AuditResult {
  root: string;
  hits: Hit[];
  stats: { tracked: number; untracked: number; commits: number; refs: number; binary: number; large: number; missing: number };
}

export async function audit(repo: string, rules: Rule[], scopes: ReadonlySet<Scope> = new Set(SCOPES)): Promise<AuditResult> {
  const root = (await git(resolve(repo), ["rev-parse", "--show-toplevel"])).trim();
  const hits: Hit[] = [];
  const stats = { tracked: 0, untracked: 0, commits: 0, refs: 0, binary: 0, large: 0, missing: 0 };
  const add = (scope: Scope, where: string, text: string) => {
    if (!scopes.has(scope)) return;
    const m = matchLine(text, rules);
    if (m) hits.push({ scope, where, ...m });
  };

  // The tree, as it is on disk.
  const split = (s: string) => s.split("\0").filter(Boolean);
  const tree = scopes.has("tree");
  const tracked = tree ? split(await git(root, ["ls-files", "-z", "--cached"])) : [];
  const untracked = tree ? split(await git(root, ["ls-files", "-z", "--others", "--exclude-standard"])) : [];
  stats.tracked = tracked.length;
  stats.untracked = untracked.length;
  for (const [path, label] of [...tracked.map((p) => [p, ""]), ...untracked.map((p) => [p, " (untracked)"])] as [string, string][]) {
    add("tree", `${path}${label} (its path)`, path);
    const full = join(root, path);
    let text: string;
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) text = readlinkSync(full);
      else if (!st.isFile()) continue; // a submodule
      else if (st.size > MAX_FILE_BYTES) {
        stats.large++;
        continue;
      } else {
        const buf = readFileSync(full);
        if (buf.subarray(0, 8000).includes(0)) {
          stats.binary++;
          continue;
        }
        text = buf.toString("utf8");
      }
    } catch {
      stats.missing++; // tracked, but deleted in the work tree
      continue;
    }
    text.split("\n").forEach((line, i) => add("tree", `${path}${label}:${i + 1}`, line));
  }

  // The refs: their names, and the message and tagger of each annotated tag.
  const refs = (await git(root, ["for-each-ref", "--format=%(refname)%1f%(objecttype)%1f%(taggername) %(taggeremail)%1f%(contents)%1e"])).split("\x1e");
  for (const rec of refs) {
    const [name, type, tagger, contents] = rec.replace(/^\n/, "").split("\x1f");
    if (!name) continue;
    stats.refs++;
    add("ref", name, name);
    if (type === "tag") {
      add("ref", `${name} tagger`, tagger ?? "");
      (contents ?? "").split("\n").forEach((line, i) => add("ref", `${name} message line ${i + 1}`, line));
    }
  }
  if (!stats.refs || !(["history", "message", "author"] as const).some((s) => scopes.has(s))) return { root, hits, stats };

  // Each commit's message, and its author and committer lines (one hit per identity, with its commits).
  const identities = new Map<string, string[]>();
  const log = (await git(root, ["log", "--all", "--format=%x1e%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B"])).split("\x1e");
  for (const rec of log) {
    const [sha, author, committer, body] = rec.split("\x1f");
    if (!sha || !sha.trim()) continue;
    stats.commits++;
    const short = sha.trim().slice(0, 7);
    for (const who of new Set([author ?? "", committer ?? ""])) identities.set(who, [...(identities.get(who) ?? []), short]);
    (body ?? "").replace(/\n+$/, "").split("\n").forEach((line, i) => add("message", `commit ${short} message line ${i + 1}`, line));
  }
  for (const [who, shas] of identities) {
    const list = shas.length > 3 ? `${shas.slice(0, 3).join(", ")} and ${shas.length - 3} more` : shas.join(", ");
    add("author", `${who} (author or committer of ${list})`, who);
  }
  if (!scopes.has("history")) return { root, hits, stats };

  // Every line that a commit adds, with the line number in that commit's version of the file.
  let sha = "";
  let path: string | null = null;
  let header = false;
  let parents = 1;
  let left: number[] = []; // lines still to come in this hunk: the result first, then each parent
  let lineNo = 0;
  const seenPaths = new Set<string>();
  await eachLine(root, ["log", "--all", "-p", "--cc", "--no-color", "--no-ext-diff", "--no-textconv", "--format=%x1e%H"], (line) => {
    if (left.some((n) => n > 0)) {
      if (line.startsWith("\\")) return; // "\ No newline at end of file"
      const prefix = line.slice(0, parents);
      const inResult = !prefix.includes("-");
      if (inResult) left[0]!--;
      // A kept line is in parent p when its column is blank; a removed line is in parent p when its column is "-".
      for (let p = 0; p < parents; p++) if (inResult ? prefix[p] === " " : prefix[p] === "-") left[p + 1]!--;
      if (inResult) {
        lineNo++;
        // A line is new in this commit when no parent has it (for a merge: a "+" in every column).
        if (path && prefix === "+".repeat(parents)) add("history", `commit ${sha} ${path}:${lineNo}`, line.slice(parents));
      }
      return;
    }
    if (line.startsWith("\x1e")) {
      sha = line.slice(1).trim().slice(0, 7);
      path = null;
      header = false;
      return;
    }
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      header = true;
      path = null;
      return;
    }
    if (header && line.startsWith("+++ ")) {
      const raw = line.slice(4).replace(/\t$/, "");
      path = raw === "/dev/null" ? null : unquotePath(raw).replace(/^b\//, "");
      if (path && !seenPaths.has(path)) {
        seenPaths.add(path);
        add("history", `commit ${sha} ${path} (its path)`, path);
      }
      return;
    }
    const hunk = /^(@{2,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? @{2,}/.exec(line);
    if (hunk) {
      header = false;
      parents = hunk[1]!.length - 1;
      const olds = hunk[2]!.trim().split(" ").map((r) => (r.includes(",") ? Number(r.split(",")[1]) : 1));
      left = [hunk[4] === undefined ? 1 : Number(hunk[4]), ...olds];
      lineNo = Number(hunk[3]) - 1;
    }
  });
  return { root, hits, stats };
}

// ---------------------------------------------------------------------------------------------------------------
// The command

function usage(code: number): never {
  (code ? console.error : console.log)("Usage: bun scripts/audit-public-clean.ts --repo <path> [--patterns <file>] [--scope <list>]");
  process.exit(code);
}

/** --scope's list: names of SCOPES, comma-separated; null when a name is not one. */
export function parseScopes(list: string): Set<Scope> | null {
  const names = list.split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length || names.some((n) => !(SCOPES as readonly string[]).includes(n))) return null;
  return new Set(names as Scope[]);
}

async function main() {
  const argv = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") usage(0);
    if (a !== "--repo" && a !== "--patterns" && a !== "--scope") {
      console.error(`audit: unknown argument "${a}"`);
      usage(2);
    }
    const v = argv[++i];
    if (!v) {
      console.error(`audit: ${a} needs a value`);
      usage(2);
    }
    opts[a.slice(2)] = v;
  }
  if (!opts.repo) usage(2);
  const scopes = opts.scope === undefined ? new Set(SCOPES) : parseScopes(opts.scope);
  if (!scopes) {
    console.error(`audit: --scope takes names from ${SCOPES.join(", ")}, comma-separated, not "${opts.scope}"`);
    usage(2);
  }

  let rules = DETECTORS;
  let patternNote = "patterns: none (built-in detectors only)";
  if (opts.patterns) {
    try {
      const extra = parsePatterns(readFileSync(opts.patterns, "utf8"), opts.patterns);
      rules = [...DETECTORS, ...extra];
      patternNote = `patterns: ${extra.length} from ${opts.patterns}`;
    } catch (e) {
      console.error(`audit: ${(e as Error).message}`);
      process.exit(2);
    }
  }

  let result: AuditResult;
  try {
    result = await audit(opts.repo, rules, scopes);
  } catch (e) {
    console.error(`audit: ${(e as Error).message}`);
    process.exit(2);
  }
  const { root, hits, stats } = result;
  const all = scopes.size === SCOPES.length;
  const read = all
    ? `${stats.tracked} tracked and ${stats.untracked} untracked files, ${stats.commits} commits on ${stats.refs} refs`
    : `scope ${SCOPES.filter((s) => scopes.has(s)).join(", ")}: ${scopes.has("tree") ? `${stats.tracked} tracked and ${stats.untracked} untracked files` : `${stats.commits} commits on ${stats.refs} refs`}`;
  console.log(`audit: ${root}: ${read}; detectors: ${DETECTORS.map((d) => d.name).join(", ")}; ${patternNote}`);
  for (const h of hits) console.log(`${h.scope.padEnd(8)} ${h.where}  [${h.rules.join("; ")}]  ${h.excerpt}`);
  const count = (s: Scope) => hits.filter((h) => h.scope === s).length;
  const skipped = [stats.binary && `${stats.binary} binary`, stats.large && `${stats.large} over 20 MiB`, stats.missing && `${stats.missing} missing from the work tree`].filter(Boolean);
  const notSearched = SCOPES.filter((s) => !scopes.has(s)).map((s) => SCOPE_LABEL[s]);
  console.log(
    `audit: ${hits.length ? `${hits.length} hits` : "clean"} (${SCOPES.filter((s) => scopes.has(s)).map((s) => `${SCOPE_LABEL[s]} ${count(s)}`).join(", ")})` +
      (notSearched.length ? `; not searched: ${notSearched.join(", ")}` : "") +
      (skipped.length ? `; files not read: ${skipped.join(", ")}` : ""),
  );
  process.exit(hits.length ? 1 : 0);
}

if (import.meta.main) await main();
