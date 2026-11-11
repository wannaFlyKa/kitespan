// kitespan's worktree git, the review's safety cases (build checklist W1, W7, L25), on scratch repositories whose git
// config files are /dev/null: no filter driver of any config scope runs at an add, a status or a removal (the
// repository's own, its config.worktree, and the user's or the system's git-lfs, here given in git's command scope),
// no request goes to a repository's `.lfsconfig` URL and no credential helper runs; an add that its deadline ends
// leaves nothing behind; a removal gets the long deadline, and one that stops part way is never left half done;
// Archive keeps files that git ignores. A stand-in for git, a shell script that runs the real one, slows or cuts calls.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findGit } from "../../server/search/git";
import { linkedRootOf, worktreeHere } from "../../server/worktree/check";
import { readRepoConfig, WORKTREE_GIT_FLAGS, worktreeGit, type WorktreeGit } from "../../server/worktree/git";
import { WorktreeHost } from "../../server/worktree/host";
import { copyIncludes } from "../../server/worktree/include";
import { archiveRemove, makeWorktree, removeWorktree, worktreeChanges, worktreeOff } from "../../server/worktree/ops";
import { GIT_TEST_ENV, branches, commitAll, git, scratch, type Scratch } from "./worktree-repo";

const PROJECT = "k3m7q2x4ab";
const CHAT = "abcdefghijklmnopqrst";
const GIT = findGit(process.env.PATH ?? "")!;
let open: Scratch[] = [];
afterEach(() => {
  for (const s of open) s.cleanup();
  open = [];
});
const repo = () => {
  const s = scratch();
  open.push(s);
  return s;
};
const make = (s: Scratch, wg: WorktreeGit = s.wg, chatId = CHAT) => makeWorktree(wg, { root: s.repo, data: s.data, projectId: PROJECT, chatId }, () => {});
const entries = (s: Scratch) => git(s.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length ?? 0;
const runs = (marker: string) => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length : 0);

/** A filter driver `name` that writes a marker line at each run (and passes the content through). */
function markFilter(s: Scratch, name: string, marker: string, scope: string[] = []) {
  git(s.repo, "config", ...scope, `filter.${name}.smudge`, `sh -c 'echo smudge >> ${marker}; cat'`);
  git(s.repo, "config", ...scope, `filter.${name}.clean`, `sh -c 'echo clean >> ${marker}; cat'`);
}

/** A stand-in for git: `body` runs first in sh with the arguments, then the real git does (unless body exits). */
function standIn(s: Scratch, body: string): string {
  const p = join(s.root, "git-stand-in");
  writeFileSync(p, `#!/bin/sh\n${body}\nexec '${GIT}' "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("no filter driver of any config scope runs (W1)", () => {
  test("a removal right after the add runs no clean filter of the repository's config (Archive, a discard)", async () => {
    const s = repo();
    const marker = join(s.root, "marker");
    writeFileSync(join(s.repo, ".gitattributes"), "*.txt filter=mark\n");
    writeFileSync(join(s.repo, "a.txt"), "plain\n");
    commitAll(s.repo, "with a filter");
    markFilter(s, "mark", marker);
    for (const chatId of ["aaaaaaaabbbbbbbbcccc", "ddddddddeeeeeeeeffff"]) {
      const r = await make(s, s.wg, chatId);
      if (!r.ok) throw new Error("no worktree");
      // Edited and put back (a newer time): the status inside `worktree remove` hashes the file again.
      const p = join(r.worktree.path, "a.txt");
      writeFileSync(p, "plain\n");
      const later = new Date(Date.now() + 5_000);
      utimesSync(p, later, later);
      expect(await worktreeChanges(s.wg, r.worktree)).toBe(0);
      expect(await removeWorktree(s.wg, r.worktree, false)).toBe(true);
      expect(existsSync(r.worktree.path)).toBe(false);
    }
    expect(runs(marker)).toBe(0);
  });

  test("a git-lfs filter of the user's or the system's config runs neither: no request to .lfsconfig's URL, no credential helper", async () => {
    const s = repo();
    const hits: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        hits.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response("no", { status: 401, headers: { "www-authenticate": 'Basic realm="x"' } });
      },
    });
    try {
      const helper = join(s.root, "helper-marker");
      const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12\n`;
      writeFileSync(join(s.repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
      writeFileSync(join(s.repo, ".lfsconfig"), `[lfs]\n\turl = http://127.0.0.1:${server.port}/repo.git/info/lfs\n`);
      writeFileSync(join(s.repo, "big.bin"), pointer);
      commitAll(s.repo, "an lfs pointer");
      git(s.repo, "config", "credential.helper", `!sh -c 'echo ran >> ${helper}; exit 1'`);
      // The lfs filter as `git lfs install` writes it to ~/.gitconfig, or /etc/gitconfig has it: here in git's command
      // scope, which no repository writes.
      const lfs = [
        ["filter.lfs.process", "git-lfs filter-process"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.required", "true"],
      ];
      const scope: Record<string, string> = { GIT_CONFIG_COUNT: String(lfs.length) };
      lfs.forEach(([k, v], i) => Object.assign(scope, { [`GIT_CONFIG_KEY_${i}`]: k, [`GIT_CONFIG_VALUE_${i}`]: v }));
      const wg = worktreeGit(process.env, { ...GIT_TEST_ENV, ...scope });
      expect(await readRepoConfig(wg, s.repo)).toEqual({ refused: false, filters: ["lfs"] });
      const r = await make(s, wg);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(readFileSync(join(r.worktree.path, "big.bin"), "utf8")).toBe(pointer);
      writeFileSync(join(r.worktree.path, "big.bin"), "changed\n");
      expect(await worktreeChanges(wg, r.worktree)).toBe(1);
      expect(await removeWorktree(wg, r.worktree, true)).toBe(true);
      expect(hits).toEqual([]);
      expect(runs(helper)).toBe(0);
      // Every call: no credential helper, and git-lfs would skip its smudge.
      expect(WORKTREE_GIT_FLAGS.join(" ")).toContain("-c credential.helper=");
      expect(wg.env.GIT_LFS_SKIP_SMUDGE).toBe("1");
    } finally {
      server.stop(true);
    }
  });

  test("a filter in the main checkout's config.worktree runs neither at the add nor at a status or removal", async () => {
    const s = repo();
    const marker = join(s.root, "marker");
    writeFileSync(join(s.repo, ".gitattributes"), "*.txt filter=wmark\n*.md filter=own\n");
    writeFileSync(join(s.repo, "a.txt"), "plain\n");
    commitAll(s.repo, "with a filter");
    git(s.repo, "config", "extensions.worktreeConfig", "true");
    markFilter(s, "wmark", marker, ["--worktree"]);
    expect((await readRepoConfig(s.wg, s.repo))?.filters).toEqual(["wmark"]);
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    expect(readFileSync(join(r.worktree.path, "a.txt"), "utf8")).toBe("plain\n");
    // The new worktree's own config.worktree names one more, which only git in that worktree reads.
    markFilter({ ...s, repo: r.worktree.path }, "own", marker, ["--worktree"]);
    writeFileSync(join(r.worktree.path, "a.txt"), "changed\n");
    writeFileSync(join(r.worktree.path, "README.md"), "changed\n");
    expect(await worktreeChanges(s.wg, r.worktree)).toBe(2);
    expect(runs(marker)).toBe(0);
    // The test's own git puts both back (and runs both filters); a newer time makes the removal's status hash them.
    git(r.worktree.path, "checkout", "--", "a.txt", "README.md");
    const later = new Date(Date.now() + 5_000);
    for (const f of ["a.txt", "README.md"]) utimesSync(join(r.worktree.path, f), later, later);
    writeFileSync(marker, "");
    expect(await removeWorktree(s.wg, r.worktree, false)).toBe(true);
    expect(runs(marker)).toBe(0);
  });

  test("an includeIf in config.worktree is refused; one in the user's own config is not the repository's", async () => {
    const s = repo();
    git(s.repo, "config", "extensions.worktreeConfig", "true");
    git(s.repo, "config", "--worktree", "includeIf.gitdir:/nowhere/.path", "/nowhere/config");
    expect((await readRepoConfig(s.wg, s.repo))?.refused).toBe(true);
    expect(await worktreeOff(s.wg, s.repo)).toBe("config");
    const u = repo();
    const user = { ...GIT_TEST_ENV, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "includeIf.gitdir:/nowhere/.path", GIT_CONFIG_VALUE_0: "/nowhere/config" };
    expect(await worktreeOff(worktreeGit(process.env, user), u.repo)).toBeNull();
  });
});

describe("an add that fails leaves nothing behind (W3)", () => {
  test("the deadline in the middle of the checkout: no folder, no branch, no worktree entry, no record", async () => {
    const s = repo();
    writeFileSync(join(s.repo, ".gitattributes"), "*.txt filter=slow\n");
    for (let i = 0; i < 5; i++) writeFileSync(join(s.repo, `f${i}.txt`), `${i}\n`);
    commitAll(s.repo, "files");
    // Only the add gets a smudge filter that sleeps (no config of the repository names it, so kitespan does not turn it
    // off), so the add's deadline ends git in the middle of its checkout, as in a large repository.
    const slow = standIn(s, `case " $* " in *" worktree add "*) export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=filter.slow.smudge GIT_CONFIG_VALUE_0='sleep 20; cat' GIT_CONFIG_KEY_1=filter.slow.required GIT_CONFIG_VALUE_1=true;; esac`);
    const r = await make(s, { ...s.wg, git: slow, addMs: 1_500 });
    expect(r).toEqual({ ok: false, why: "failed" });
    expect(readdirSync(join(s.data, "kitespan", "worktrees", PROJECT))).toEqual([]);
    const dir = join(s.repo, ".claude", "worktrees");
    expect(readdirSync(dir)).toEqual([]);
    expect(branches(s.repo)).toEqual(["main"]);
    expect(entries(s)).toBe(1);
    // The next Start of the same chat gets the first name again.
    const again = await make(s);
    expect(again.ok && again.worktree.path).toBe(join(dir, "abcdefgh"));
  });
});

describe("a removal is never left half done (W7)", () => {
  test("the removal gets the add's long deadline, not a short call's", async () => {
    const s = repo();
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    const slow = standIn(s, `case " $* " in *" worktree remove "*) sleep 0.5;; esac`);
    expect(await removeWorktree({ ...s.wg, git: slow, callMs: 100 }, r.worktree, false)).toBe(true);
    expect(existsSync(r.worktree.path)).toBe(false);
  });

  /** A removal that git began, deleted some files in, and did not end (its deadline); `then` runs there too. */
  const cut = (s: Scratch, path: string, then = "") =>
    standIn(s, `case " $* " in *" worktree remove --force "*) ;; *" worktree remove "*) rm -f '${path}/f0.txt' '${path}/f1.txt'; ${then} sleep 20;; esac`);

  test("Archive's removal cut part way is finished: the worktree goes, its branch stays", async () => {
    const s = repo();
    for (let i = 0; i < 4; i++) writeFileSync(join(s.repo, `f${i}.txt`), `${i}\n`);
    commitAll(s.repo, "files");
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    const wg = { ...s.wg, git: cut(s, r.worktree.path), addMs: 500 };
    expect(await archiveRemove(wg, r.worktree)).toBe("removed");
    expect(existsSync(r.worktree.path)).toBe(false);
    expect(branches(s.repo)).toContain(r.worktree.branch);
  });

  test("a worktree that has other changes after the cut stays, with them; a removal that never began leaves it whole", async () => {
    const s = repo();
    for (let i = 0; i < 4; i++) writeFileSync(join(s.repo, `f${i}.txt`), `${i}\n`);
    commitAll(s.repo, "files");
    const a = await make(s, s.wg, "aaaaaaaabbbbbbbbcccc");
    const b = await make(s, s.wg, "ddddddddeeeeeeeeffff");
    if (!a.ok || !b.ok) throw new Error("no worktree");
    const written = { ...s.wg, git: cut(s, a.worktree.path, `echo new > '${a.worktree.path}/new.txt';`), addMs: 500 };
    expect(await archiveRemove(written, a.worktree)).toBe("kept");
    expect(readFileSync(join(a.worktree.path, "new.txt"), "utf8")).toBe("new\n");
    const stuck = { ...s.wg, git: standIn(s, `case " $* " in *" worktree remove "*) sleep 20;; esac`), addMs: 500 };
    expect(await archiveRemove(stuck, b.worktree)).toBeNull();
    expect(worktreeHere(b.worktree.path, s.repo)).toBe(true);
    expect(await worktreeChanges(s.wg, b.worktree)).toBe(0);
  });
});

describe("Archive keeps files that git ignores (L25)", () => {
  async function project() {
    const s = repo();
    writeFileSync(join(s.repo, ".gitignore"), ".env\nnode_modules/\nlocal/\n");
    writeFileSync(join(s.repo, ".worktreeinclude"), ".env\nlocal/\n");
    commitAll(s.repo, "ignore rules");
    writeFileSync(join(s.repo, ".env"), "TOKEN=fixture\n");
    mkdirSync(join(s.repo, "local"));
    writeFileSync(join(s.repo, "local", "conf.json"), "{}\n");
    return s;
  }
  const host = (s: Scratch) => new WorktreeHost({ worktreeGit: s.wg, worktreeData: s.data });

  test("unchanged copies of .worktreeinclude go with a clean worktree", async () => {
    const s = await project();
    const r = await make(s);
    if (!r.ok) throw new Error("no worktree");
    expect(await copyIncludes(s.wg, r.worktree)).toBe(2);
    const h = host(s);
    expect(await h.facts(r.worktree)).toMatchObject({ changes: 0, ignored: false });
    expect(await h.archive(r.worktree)).toBe("removed");
    expect(existsSync(r.worktree.path)).toBe(false);
  });

  for (const [what, put] of [
    ["an edited copy of .env", (p: string) => writeFileSync(join(p, ".env"), "TOKEN=edited\n")],
    ["a new file in a copied ignored folder", (p: string) => writeFileSync(join(p, "local", "notes.md"), "mine\n")],
    ["an ignored folder of its own", (p: string) => (mkdirSync(join(p, "node_modules")), writeFileSync(join(p, "node_modules", "x.js"), "1\n"))],
  ] as const)
    test(`${what} keeps the worktree, as a change does`, async () => {
      const s = await project();
      const r = await make(s);
      if (!r.ok) throw new Error("no worktree");
      await copyIncludes(s.wg, r.worktree);
      put(r.worktree.path);
      const h = host(s);
      expect(await h.facts(r.worktree)).toMatchObject({ changes: 0, ignored: true });
      expect(await h.archive(r.worktree)).toBe("kept");
      expect(linkedRootOf(r.worktree.path)).toBe(s.repo);
    });
});
