// The sign-off check (scripts/dco.ts; P1 DESIGN 4.6) on scratch repositories in a temporary folder, with no global or
// system git config. The script runs as CI's dco job runs it: a copy in a folder of its own, outside the repository it
// checks (--repo), so it can import nothing of the repository's.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEPENDABOT, parseSignoff, signedBy } from "../../scripts/dco";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-dco-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const RUNNER = join(ROOT, "runner");
mkdirSync(RUNNER);
const SCRIPT = join(RUNNER, "dco.ts");
copyFileSync(join(import.meta.dir, "..", "..", "scripts", "dco.ts"), SCRIPT);

const JANE = { name: "Jane Roe", email: "jane.roe@example.com" };
const JOHN = { name: "John Doe", email: "john.doe@example.com" };
// Dependabot signs its commits off with GitHub's support address (put together here, so this file holds no address).
const BOT_SIGNOFF = `${DEPENDABOT.name} <${["support", "github.com"].join("@")}>`;
const signoff = (who: { name: string; email: string }) => `Signed-off-by: ${who.name} <${who.email}>`;

const ENV: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: ROOT, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };

function git(dir: string, args: string[], who = JANE): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...ENV, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: JANE.name, GIT_COMMITTER_EMAIL: JANE.email },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let repos = 0;
/** A repository with one first commit (the base); returns its folder and the base's sha. */
function repo(): { dir: string; base: string } {
  const dir = join(ROOT, `repo-${++repos}`);
  mkdirSync(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `Start\n\n${signoff(JANE)}`]);
  return { dir, base: git(dir, ["rev-parse", "HEAD"]) };
}

let files = 0;
/** One commit with a file of its own; returns its sha. */
function commit(dir: string, message: string, who = JANE): string {
  writeFileSync(join(dir, `f${++files}.txt`), `${files}\n`);
  git(dir, ["add", "-A"], who);
  git(dir, ["commit", "-q", "-m", message], who);
  return git(dir, ["rev-parse", "HEAD"]);
}

async function dco(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, "--no-env-file", SCRIPT, ...args], { cwd: RUNNER, env: ENV, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
const check = (r: { dir: string; base: string }, head = "HEAD", more: string[] = []) => dco(["--repo", r.dir, "--base", r.base, "--head", git(r.dir, ["rev-parse", head]), ...more]);

describe("the commits of a pull request", () => {
  test("each signed off by its author: exit 0", async () => {
    const r = repo();
    commit(r.dir, `Add a\n\n${signoff(JANE)}`);
    commit(r.dir, `Add b\n\nA body line.\n\n${signoff(JANE)}`);
    const res = await check(r);
    expect(res).toEqual({ code: 0, out: "dco: 2 commits, each signed off by its author\n", err: "" });
  });

  test("no sign-off: exit 1, one line with the commit's 12-character id, then the fix", async () => {
    const r = repo();
    const sha = commit(r.dir, "Add a");
    const res = await check(r);
    expect(res.code).toBe(1);
    const lines = res.out.trim().split("\n");
    expect(lines[0]).toBe(`${sha.slice(0, 12)}: no Signed-off-by: trailer (the author is ${JANE.name} <${JANE.email}>)`);
    expect(lines[1]).toBe("dco: 1 of 1 commits are not signed off by their author.");
    expect(res.out).toContain(`git rebase --signoff ${r.base}`);
    expect(res.out).toContain("--force-with-lease");
    expect(res.out).toContain("https://developercertificate.org/");
  });

  test("a sign-off with another name, or another email, does not count; the name must be the same exactly", async () => {
    for (const other of [
      { name: JOHN.name, email: JANE.email },
      { name: JANE.name, email: JOHN.email },
      { name: JANE.name.toLowerCase(), email: JANE.email },
    ]) {
      const r = repo();
      const sha = commit(r.dir, `Add a\n\n${signoff(other)}`);
      const res = await check(r);
      expect(res.code).toBe(1);
      expect(res.out.split("\n")[0]).toBe(`${sha.slice(0, 12)}: no Signed-off-by: trailer names the author, ${JANE.name} <${JANE.email}>`);
    }
  });

  test("the email in another case counts", async () => {
    const r = repo();
    commit(r.dir, `Add a\n\n${signoff({ name: JANE.name, email: JANE.email.toUpperCase() })}`);
    expect((await check(r)).code).toBe(0);
  });

  test("a Signed-off-by: line in the middle of the body is no trailer", async () => {
    const r = repo();
    commit(r.dir, `Add a\n\n${signoff(JANE)}\n\nA paragraph after it, so the line is not in the trailers.`);
    const res = await check(r);
    expect(res.code).toBe(1);
    expect(res.out).toContain("no Signed-off-by: trailer (the author is");
  });

  test("two sign-offs, one of them the author's: it counts", async () => {
    const r = repo();
    commit(r.dir, `Add a\n\n${signoff(JOHN)}\n${signoff(JANE)}`);
    expect((await check(r)).code).toBe(0);
  });

  test("the author is read as written, not through a .mailmap in the tree", async () => {
    const r = repo();
    writeFileSync(join(r.dir, ".mailmap"), `${JOHN.name} <${JOHN.email}> ${JANE.name} <${JANE.email}>\n`);
    commit(r.dir, `Add a mailmap\n\n${signoff(JOHN)}`);
    expect((await check(r)).code).toBe(1);
  });

  test("an unsigned clean merge commit is skipped; the commits it brings are checked", async () => {
    const r = repo();
    git(r.dir, ["checkout", "-q", "-b", "side"]);
    commit(r.dir, `Side work\n\n${signoff(JANE)}`);
    git(r.dir, ["checkout", "-q", "main"]);
    commit(r.dir, `Main work\n\n${signoff(JANE)}`);
    git(r.dir, ["merge", "-q", "--no-ff", "--no-edit", "side"]);
    const res = await check(r);
    expect(res).toEqual({ code: 0, out: "dco: 2 commits, each signed off by its author; skipped: 1 clean merge commit\n", err: "" });
    git(r.dir, ["checkout", "-q", "side"]);
    commit(r.dir, "Unsigned side work");
    git(r.dir, ["checkout", "-q", "main"]);
    git(r.dir, ["merge", "-q", "--no-ff", "--no-edit", "side"]);
    expect((await check(r)).code).toBe(1);
  });

  test("a merge with changes of its own needs its author's sign-off: a hand-made merge, a conflict resolved by hand, an octopus", async () => {
    // A hand-made "merge" whose tree adds a file that neither parent has, its second parent an ancestor of the base.
    const r = repo();
    commit(r.dir, `Add a\n\n${signoff(JANE)}`);
    const base = git(r.dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(r.dir, "evil.txt"), "evil\n");
    git(r.dir, ["add", "-A"]);
    const tree = git(r.dir, ["write-tree"]);
    const made = (message: string) => git(r.dir, ["commit-tree", tree, "-p", base, "-p", `${base}~1`, "-m", message]);
    const evil = made("Merge branch 'main' into feature");
    const res = await dco(["--repo", r.dir, "--base", base, "--head", evil]);
    expect(res.code).toBe(1);
    expect(res.out.split("\n")[0]).toBe(`${evil.slice(0, 12)}: no Signed-off-by: trailer (the author is ${JANE.name} <${JANE.email}>); this merge has changes of its own`);
    expect(await dco(["--repo", r.dir, "--base", base, "--head", made(`Merge branch 'main' into feature\n\n${signoff(JANE)}`)])).toEqual({ code: 0, out: "dco: 1 commit, each signed off by its author\n", err: "" });

    // main merged into the branch, with a conflict resolved by hand and no sign-off.
    const c = repo();
    git(c.dir, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(c.dir, "README.md"), "# side\n");
    git(c.dir, ["commit", "-q", "-a", "-m", `Side\n\n${signoff(JANE)}`]);
    git(c.dir, ["checkout", "-q", "main"]);
    writeFileSync(join(c.dir, "README.md"), "# main\n");
    git(c.dir, ["commit", "-q", "-a", "-m", `Main\n\n${signoff(JANE)}`]);
    const main = git(c.dir, ["rev-parse", "HEAD"]);
    git(c.dir, ["checkout", "-q", "side"]);
    expect(Bun.spawnSync(["git", "-C", c.dir, "merge", "-q", "main"], { env: { ...ENV, GIT_AUTHOR_NAME: JANE.name, GIT_AUTHOR_EMAIL: JANE.email, GIT_COMMITTER_NAME: JANE.name, GIT_COMMITTER_EMAIL: JANE.email }, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(1);
    writeFileSync(join(c.dir, "README.md"), "# both\n");
    git(c.dir, ["commit", "-q", "-a", "--no-edit"]);
    const resolved = git(c.dir, ["rev-parse", "HEAD"]);
    const cr = await dco(["--repo", c.dir, "--base", main, "--head", resolved]);
    expect(cr.code).toBe(1);
    expect(cr.out.split("\n")[0]).toStartWith(`${resolved.slice(0, 12)}: no Signed-off-by: trailer`);

    // An octopus merge of two signed branches: more than two parents, so it is checked too.
    const o = repo();
    for (const b of ["one", "two"]) {
      git(o.dir, ["checkout", "-q", "-b", b, "main"]);
      commit(o.dir, `Work on ${b}\n\n${signoff(JANE)}`);
    }
    git(o.dir, ["checkout", "-q", "main"]);
    git(o.dir, ["merge", "-q", "--no-ff", "--no-edit", "one", "two"]);
    const octopus = await check(o);
    expect(octopus.code).toBe(1);
    expect(octopus.out).toContain("1 of 3 commits are not signed off by their author.");
  });

  test("Dependabot's own commit is skipped only in Dependabot's pull request; a maintainer's commit there needs its sign-off", async () => {
    const BOT = { name: DEPENDABOT.name, email: DEPENDABOT.email };
    const r = repo();
    commit(r.dir, `Bump the SDK\n\nSigned-off-by: ${BOT_SIGNOFF}`, BOT);
    expect((await check(r)).code).toBe(1);
    expect(await check(r, "HEAD", ["--pr-author", "someone"])).toMatchObject({ code: 1 });
    expect(await check(r, "HEAD", ["--pr-author", DEPENDABOT.login])).toEqual({ code: 0, out: "dco: no commit to check; skipped: 1 of Dependabot's own\n", err: "" });
    // Another author with the bot's name, or the bot's name with another email, is no bot.
    const s = repo();
    commit(s.dir, `Bump\n\nSigned-off-by: ${BOT_SIGNOFF}`, { name: DEPENDABOT.name, email: JOHN.email });
    expect((await check(s, "HEAD", ["--pr-author", DEPENDABOT.login])).code).toBe(1);
    // The maintainer's fix of the pins in the bot's pull request.
    const sha = commit(r.dir, "Move the SDK pins", JOHN);
    const res = await check(r, "HEAD", ["--pr-author", DEPENDABOT.login]);
    expect(res.code).toBe(1);
    expect(res.out.split("\n")[0]).toStartWith(`${sha.slice(0, 12)}: no Signed-off-by: trailer`);
    git(r.dir, ["commit", "-q", "--amend", "-m", `Move the SDK pins\n\n${signoff(JOHN)}`], JOHN);
    expect(await check(r, "HEAD", ["--pr-author", DEPENDABOT.login])).toEqual({ code: 0, out: "dco: 1 commit, each signed off by its author; skipped: 1 of Dependabot's own\n", err: "" });
  });

  test("a range with no commit passes", async () => {
    const r = repo();
    expect(await check(r)).toEqual({ code: 0, out: "dco: no commit to check\n", err: "" });
  });
});

describe("it could not run: exit 2", () => {
  test("a base or head that is not a commit of the clone, a missing option, an unknown argument, a folder that is no repository", async () => {
    const r = repo();
    const head = git(r.dir, ["rev-parse", "HEAD"]);
    const missing = "0".repeat(40);
    const gone = await dco(["--repo", r.dir, "--base", missing, "--head", head]);
    expect(gone.code).toBe(2);
    expect(gone.err).toBe(`dco: the base commit ${missing} is not in this clone (CI checks out with fetch-depth: 0)\n`);
    expect((await dco(["--repo", r.dir, "--base", "--output=x", "--head", head])).code).toBe(2);
    expect((await dco(["--repo", r.dir, "--base", r.base])).code).toBe(2);
    expect((await dco(["--repo", r.dir, "--base", r.base, "--head", head, "--sign"])).code).toBe(2);
    const plain = join(ROOT, "not-a-repo");
    mkdirSync(plain);
    expect((await dco(["--repo", plain, "--base", r.base, "--head", head])).code).toBe(2);
  });
});

describe("a sign-off's value", () => {
  test("Name <email>, trimmed; anything else is no sign-off", () => {
    expect(parseSignoff("  Jane Roe   <jane.roe@example.com>  ")).toEqual({ name: "Jane Roe", email: "jane.roe@example.com" });
    expect(parseSignoff("Jane Roe jane.roe@example.com")).toBeNull();
    expect(parseSignoff("Jane <a b@example.com>")).toBeNull();
    expect(signedBy(["Jane Roe <JANE.ROE@example.com>"], " Jane Roe ", "jane.roe@example.com")).toBe(true);
    expect(signedBy(["Jane  Roe <jane.roe@example.com>"], "Jane Roe", "jane.roe@example.com")).toBe(false);
    expect(signedBy([], "Jane Roe", "jane.roe@example.com")).toBe(false);
  });
});
