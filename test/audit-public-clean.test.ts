// The public-clean audit (scripts/audit-public-clean.ts) on throwaway git repositories in a temporary folder.
// Every planted value is put together at run time, so this file holds none of them and stays clean under the audit.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DETECTORS, matchLine, parsePatterns } from "../scripts/audit-public-clean";

const SCRIPT = join(import.meta.dir, "..", "scripts", "audit-public-clean.ts");
const ROOT = mkdtempSync(join(tmpdir(), "audit-public-clean-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const NOREPLY = ["1+tester", "users.noreply.github.com"].join("@");
// No global or system git config (hooks, signing, templates): the repositories behave the same everywhere.
const ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Tester",
  GIT_AUTHOR_EMAIL: NOREPLY,
  GIT_COMMITTER_NAME: "Tester",
  GIT_COMMITTER_EMAIL: NOREPLY,
};

// Planted values.
const ACCOUNT = String(123456 * 1e6 + 789012); // twelve digits
const KEY_ID = "AKIA" + "Q".repeat(16);
const KEY_HEADER = "-----BEGIN " + "OPENSSH PRIVATE KEY-----";
const ADDRESS = ["jane.roe", "corp-mail.org"].join("@");
const NAME = "zorblax"; // an internal name that only the patterns file knows

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let repos = 0;
function newRepo(): string {
  const dir = join(ROOT, `repo-${++repos}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

function write(dir: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

/** Write the files, commit everything, and return the short id of the commit. */
function commit(dir: string, files: Record<string, string>, message: string, env: Record<string, string> = {}): string {
  write(dir, files);
  git(dir, "add", "-A");
  const r = Bun.spawnSync(["git", "-C", dir, "commit", "-q", "-m", message], { env: { ...ENV, ...env } });
  if (r.exitCode !== 0) throw new Error(`git commit: ${r.stderr.toString()}`);
  return git(dir, "rev-parse", "--short=7", "HEAD");
}

function patternsFile(text: string): string {
  const file = join(ROOT, `patterns-${++repos}.txt`);
  writeFileSync(file, text);
  return file;
}

async function runAudit(dir: string, patterns?: string, more: string[] = []): Promise<{ code: number; out: string; err: string; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, SCRIPT, "--repo", dir, ...(patterns ? ["--patterns", patterns] : []), ...more], { env: ENV, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err, lines: out.split("\n") };
}

const PATTERNS = `# internal names (comment lines and blank lines are skipped)\n\n${NAME}\n/\\bQXZ\\b/\n`;

describe("the audit on a throwaway repository", () => {
  test("a clean repository passes", async () => {
    const dir = newRepo();
    commit(dir, { "README.md": "# demo\n\nA small demo. Write to example@example.com for nothing.\n", "src/a.ts": "export const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';\n" }, "Add the demo");
    commit(dir, { "src/b.ts": "export const qxz = 'lower case does not match the case-sensitive pattern';\n" }, "Add b");
    const r = await runAudit(dir, patternsFile(PATTERNS));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("audit: clean");
  });

  test("finds a planted hit in a file and in a commit message", async () => {
    const dir = newRepo();
    const c1 = commit(dir, { "src/config.ts": `export const region = "eu";\nexport const account = "${ACCOUNT}";\n` }, "Add the config");
    const c2 = commit(dir, { "src/other.ts": "export const x = 1;\n" }, `Point the client at the ${NAME} host`);
    const r = await runAudit(dir, patternsFile(PATTERNS));
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith("tree") && l.includes("src/config.ts:2") && l.includes("[account id]"))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("history") && l.includes(`commit ${c1} src/config.ts:2`) && l.includes("[account id]"))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("message") && l.includes(`commit ${c2} message line 1`) && l.includes(`[pattern ${NAME}]`))).toBe(true);
    expect(r.out).toContain("audit: 3 hits");
  });

  test("history keeps a hit that the tree no longer has", async () => {
    const dir = newRepo();
    const c1 = commit(dir, { "notes.txt": `first line\nkey ${KEY_ID}\n` }, "Add notes");
    commit(dir, { "notes.txt": "first line\n" }, "Drop the key line");
    const r = await runAudit(dir);
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith("tree"))).toBe(false);
    expect(r.lines.some((l) => l.startsWith("history") && l.includes(`commit ${c1} notes.txt:2`) && l.includes("[access key id]"))).toBe(true);
  });

  test("finds the lines that a merge brings, and only once the lines of a merged branch", async () => {
    const dir = newRepo();
    commit(dir, { "f.txt": "a\nb\nc\n" }, "Base");
    git(dir, "checkout", "-q", "-b", "side");
    commit(dir, { "f.txt": "a\nside\nc\n" }, "Side edit");
    const side = commit(dir, { "side.txt": `from the side branch: ${NAME}\n` }, "Side file");
    git(dir, "checkout", "-q", "main");
    commit(dir, { "f.txt": "a\nmain\nc\n" }, "Main edit");
    const conflicted = Bun.spawnSync(["git", "-C", dir, "merge", "-q", "side"], { env: ENV });
    expect(conflicted.exitCode).not.toBe(0);
    write(dir, { "f.txt": `a\nmain and side\n${NAME} in the resolution\nc\n` });
    git(dir, "add", "f.txt");
    git(dir, "commit", "-q", "--no-edit");
    const merge = git(dir, "rev-parse", "--short=7", "HEAD");
    const r = await runAudit(dir, patternsFile(PATTERNS));
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith("history") && l.includes(`commit ${merge} f.txt:3`))).toBe(true);
    const sideHits = r.lines.filter((l) => l.startsWith("history") && l.includes("side.txt:1"));
    expect(sideHits.length).toBe(1);
    expect(sideHits[0]).toContain(`commit ${side} side.txt:1`);
  });

  test("finds an author address, a branch name, a file name and an untracked file, and skips ignored files", async () => {
    const dir = newRepo();
    commit(dir, { ".gitignore": "secret.local\n", "ok.txt": "fine\n" }, "Start", { GIT_AUTHOR_EMAIL: ADDRESS });
    commit(dir, { [`docs/${NAME}.md`]: "a page\n" }, "Add a page");
    git(dir, "branch", `feature/${NAME}-port`);
    write(dir, { "draft.md": `${KEY_HEADER}\n`, "secret.local": `${KEY_HEADER}\n` });
    const r = await runAudit(dir, patternsFile(PATTERNS));
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith("author") && l.includes(ADDRESS) && l.includes("[email address]"))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("ref") && l.includes(`refs/heads/feature/${NAME}-port`))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("tree") && l.includes(`docs/${NAME}.md (its path)`))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("tree") && l.includes("draft.md (untracked):1") && l.includes("[private key]"))).toBe(true);
    expect(r.out).not.toContain("secret.local");
    // The noreply committer of every commit is not a hit.
    expect(r.out).not.toContain(NOREPLY);
  });

  test("--scope tree (CI's check job) searches the tree only: the history, messages, authors and refs are not searched", async () => {
    const dir = newRepo();
    commit(dir, { "notes.txt": `key ${KEY_ID}\n` }, `Point the client at the ${NAME} host`, { GIT_AUTHOR_EMAIL: ADDRESS });
    commit(dir, { "notes.txt": "nothing here\n" }, "Drop the key line");
    git(dir, "branch", `feature/${NAME}-port`);
    const all = await runAudit(dir, patternsFile(PATTERNS));
    expect(all.code).toBe(1);
    const clean = await runAudit(dir, patternsFile(PATTERNS), ["--scope", "tree"]);
    expect(clean.err).toBe("");
    expect(clean.code).toBe(0);
    expect(clean.lines[0]).toContain(": scope tree: 1 tracked and 0 untracked files;");
    expect(clean.out).toContain("audit: clean (tree 0); not searched: history, messages, authors, refs");
    write(dir, { "draft.md": `${KEY_HEADER}\n` });
    const hit = await runAudit(dir, undefined, ["--scope", "tree"]);
    expect(hit.code).toBe(1);
    expect(hit.lines.filter((l) => /^(tree|history|message|author|ref)\s/.test(l)).map((l) => l.split(" ")[0])).toEqual(["tree"]);
    expect(hit.out).toContain("audit: 1 hits (tree 1); not searched");
    // Two scopes, and a name that is not one.
    expect((await runAudit(dir, patternsFile(PATTERNS), ["--scope", "message,author"])).out).toContain("(messages 1, authors 1); not searched: tree, history, refs");
    const bad = await runAudit(dir, undefined, ["--scope", "tree,commits"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--scope takes names from tree, history, message, author, ref, comma-separated, not "tree,commits"');
  });

  test("a bad pattern stops the audit with exit 2", async () => {
    const dir = newRepo();
    commit(dir, { "a.txt": "a\n" }, "A");
    const r = await runAudit(dir, patternsFile("# one bad line\n(unclosed\n"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("line 2");
  });

  test("a folder outside any git repository stops the audit with exit 2", async () => {
    const dir = join(ROOT, "not-a-repo");
    mkdirSync(dir);
    const r = await runAudit(dir);
    expect(r.code).toBe(2);
  });
});

describe("the detectors and the patterns file", () => {
  const hit = (line: string) => matchLine(line, DETECTORS)?.rules ?? [];

  test("each built-in detector finds its kind", () => {
    expect(hit(`arn:aws:iam::${ACCOUNT}:role/x`)).toEqual(["account id"]);
    expect(hit(`id=${KEY_ID}`)).toEqual(["access key id"]);
    expect(hit(KEY_HEADER)).toEqual(["private key"]);
    expect(hit(`mail ${ADDRESS}`)).toEqual(["email address"]);
  });

  test("they leave UUIDs, longer numbers, noreply and example addresses, image names and git remotes alone", () => {
    for (const line of [
      `session 7c9e6679-7425-40de-944b-${ACCOUNT}`,
      `${ACCOUNT}9 is thirteen digits`,
      `v${ACCOUNT}`,
      `author ${NOREPLY}`,
      ["mailto:team", "example.com"].join("@"),
      ["icon", "2x.png"].join("@"),
      ["git", "github.com:owner/repo.git"].join("@"),
      "react@19.3.1 and @types/bun",
      "-----BEGIN PUBLIC KEY-----",
    ])
      expect(hit(line)).toEqual([]);
  });

  test("patterns are case-insensitive unless written as /source/flags; comments and blank lines are skipped", () => {
    const rules = parsePatterns(`# a comment\n\n${NAME}\n/\\bQXZ\\b/\n`);
    expect(rules.length).toBe(2);
    expect(matchLine(`${NAME.toUpperCase()} here`, rules)?.rules).toEqual([`pattern ${NAME}`]);
    expect(matchLine("QXZ here", rules)?.rules).toEqual(["pattern /\\bQXZ\\b/"]);
    expect(matchLine("qxz here", rules)).toBeNull();
    expect(() => parsePatterns("a*\n")).toThrow("matches an empty string");
  });
});
