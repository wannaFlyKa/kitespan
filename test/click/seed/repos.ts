// The click-through seed's git repositories for part 2 (row 73, DESIGN.md 4.4 "A worktree chat's folder"; build
// checklist W1 to W9; owner row 100), and the git reads and writes that the part 2 flows (scripts/ui-check.ts) make on
// disk. Three repositories under the home folder, so New environment finds them: `~/code/shop`, a repository with
// commits on main and no project yet (Worktree may be on there; its worktrees go in its own `.claude/worktrees`),
// `~/code/hooks`, a repository whose project settings name a WorktreeCreate hook (L29: the Worktree option is off
// there, with its line), and `~/code/linked`, whose committed `.claude` is a symbolic link (to its own `config`
// folder: row 100's link rule turns the option off there, with its line). The seed's plain folder `~/Documents` is the
// folder that is not a repository (L33).
//
// Every git here is the system git with no user or system config (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1)
// and no hooks, run in the seed's own scratch folder only. Nothing here touches a repository outside the seed.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The part 2 repositories, under the seed's home folder. */
export interface SeedRepos {
  /** `~/code/shop`: two commits on main, no project at boot. */
  shop: string;
  /** `~/code/hooks`: one commit on main, and a WorktreeCreate hook in its `.claude/settings.json`. */
  hooks: string;
  /** `~/code/linked`: one commit on main, whose `.claude` is a symbolic link to its `config` folder (row 100). */
  linked: string;
}

export function seedRepos(home: string): SeedRepos {
  return { shop: join(home, "code", "shop"), hooks: join(home, "code", "hooks"), linked: join(home, "code", "linked") };
}

/** The hook that turns the Worktree option off (L29). kitespan never runs it; neither does the fake claude. */
export const WORKTREE_HOOK = { hooks: { WorktreeCreate: [{ hooks: [{ type: "command", command: "exit 1" }] }] } } as const;

/** The shop repository's files: the first commit's, then the second's. */
const SHOP_FIRST: Record<string, string> = {
  "README.md": "# shop\n\nA small cart service.\n",
  "src/cart.ts": "export function total(items: { price: number; qty: number }[]): number {\n  return items.reduce((n, i) => n + i.price * i.qty, 0);\n}\n",
};
const SHOP_SECOND: Record<string, string> = {
  "src/tax.ts": "export const VAT = 0.2;\n\nexport function withTax(n: number): number {\n  return Math.round(n * (1 + VAT) * 100) / 100;\n}\n",
};

export function gitBinary(): string | null {
  return ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g)) ?? null;
}

/** The environment of every git here: no user or system config, the seed's home. */
export function seedGitEnv(home: string): Record<string, string> {
  return { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LANG: "C" };
}

/** One git call in `cwd`, with no hooks and the seed's identity; its exit status and output. */
export function seedGit(cwd: string, home: string, args: string[]): { ok: boolean; out: string; err: string } {
  const git = gitBinary();
  if (!git) return { ok: false, out: "", err: "no git on this host" };
  const r = spawnSync(git, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", ...args], { env: seedGitEnv(home), encoding: "utf8", timeout: 20_000 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function put(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    writeFileSync(path, body, { mode: 0o644 });
    chmodSync(path, 0o644);
  }
}

function must(r: { ok: boolean; err: string }, what: string): void {
  if (!r.ok) throw new Error(`the part 2 seed could not ${what}: ${r.err.trim().slice(0, 200)}`);
}

/** Write both repositories. False when this host has no git (the seed is then the plain one). */
export function writeSeedRepos(r: SeedRepos, home: string): boolean {
  if (!gitBinary()) return false;
  mkdirSync(r.shop, { recursive: true, mode: 0o755 });
  must(seedGit(r.shop, home, ["init", "-q", "-b", "main"]), "make the shop repository");
  put(r.shop, SHOP_FIRST);
  must(seedGit(r.shop, home, ["add", "-A", "."]), "add the shop files");
  must(seedGit(r.shop, home, ["commit", "-q", "-m", "Cart total"]), "commit the shop files");
  put(r.shop, SHOP_SECOND);
  must(seedGit(r.shop, home, ["add", "-A", "."]), "add the tax file");
  must(seedGit(r.shop, home, ["commit", "-q", "-m", "Tax"]), "commit the tax file");

  mkdirSync(r.hooks, { recursive: true, mode: 0o755 });
  must(seedGit(r.hooks, home, ["init", "-q", "-b", "main"]), "make the hooks repository");
  put(r.hooks, { "README.md": "# hooks\n\nWorktrees here come from a WorktreeCreate hook.\n", ".claude/settings.json": JSON.stringify(WORKTREE_HOOK, null, 2) + "\n" });
  must(seedGit(r.hooks, home, ["add", "-A", "."]), "add the hooks files");
  must(seedGit(r.hooks, home, ["commit", "-q", "-m", "Settings with a WorktreeCreate hook"]), "commit the hooks files");

  mkdirSync(r.linked, { recursive: true, mode: 0o755 });
  must(seedGit(r.linked, home, ["init", "-q", "-b", "main"]), "make the linked repository");
  put(r.linked, { "README.md": "# linked\n\nIts .claude is a symbolic link.\n", "config/README.md": "Shared settings.\n" });
  symlinkSync("config", join(r.linked, ".claude"));
  must(seedGit(r.linked, home, ["add", "-A", "."]), "add the linked files");
  must(seedGit(r.linked, home, ["commit", "-q", "-m", "A .claude link"]), "commit the linked files");
  return true;
}

/** One entry of `git worktree list --porcelain`: its folder and its branch (null when detached). */
export interface ListedWorktree {
  path: string;
  branch: string | null;
}

/** `git worktree list --porcelain` in a repository: the main checkout first, then each linked worktree. */
export function worktreeList(repo: string, home: string): ListedWorktree[] | null {
  const r = seedGit(repo, home, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return null;
  const out: ListedWorktree[] = [];
  for (const block of r.out.split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length) ?? null;
    out.push({ path, branch: ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref });
  }
  return out;
}

/** The repository has this branch. */
export function hasBranch(repo: string, home: string, branch: string): boolean {
  return seedGit(repo, home, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

/** The branch checked out in a worktree (null when it cannot be read). */
export function branchIn(worktree: string, home: string): string | null {
  const r = seedGit(worktree, home, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.ok ? r.out.trim() : null;
}

/** `git worktree remove` of a clean worktree, as a user does in a terminal (never --force, never a recursive delete). */
export function removeWorktree(repo: string, home: string, path: string): { ok: boolean; err: string } {
  const r = seedGit(repo, home, ["worktree", "remove", path]);
  return { ok: r.ok, err: r.err.trim() };
}

/** Changes in a worktree, as Claude would leave them: these files written (a new one is untracked). */
export function writeChanges(worktree: string, files: Record<string, string>): void {
  put(worktree, files);
}

/** A commit of the worktree's own on its branch: these files added and committed. */
export function commitIn(worktree: string, home: string, files: Record<string, string>, message: string): boolean {
  put(worktree, files);
  return seedGit(worktree, home, ["add", "-A", "."]).ok && seedGit(worktree, home, ["commit", "-q", "-m", message]).ok;
}
