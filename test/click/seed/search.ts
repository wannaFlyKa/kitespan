// The click-through seed's parts for v0.3 search (DESIGN.md 9.3; build checklist B6). Two kinds:
//
// - SEARCH_FILES: files of the example chat's folder in every scene, so the `@` picker and the search pane have rows
//   that test overflow (a 300-character path, CJK and emoji names, a name with a space). They are committed with the
//   rest, so the folder's git status does not change.
// - The gate seed: two project folders for the search scene only, each a git repository whose index holds many paths
//   (100,000 and 20,000) that all point at the empty blob, with no files on disk (`git update-index --index-info`),
//   so `git ls-files --cached` lists them in a few tens of milliseconds. It is built at test time and never committed.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

/** A path of exactly `length` characters under `head`, in folders of at most 60 characters (no segment near 255 bytes). */
function longPath(head: string, name: string, length: number): string {
  const parts = [head];
  let used = head.length + 1 + name.length;
  for (let i = 1; used + 61 <= length; i++) {
    const seg = `nested-folder-${String(i).padStart(2, "0")}-${"x".repeat(43)}`.slice(0, 60);
    parts.push(seg);
    used += seg.length + 1;
  }
  const pad = length - used - 1;
  if (pad > 0) parts.push("p".repeat(pad));
  const p = `${[...parts, name].join("/")}`;
  if (p.length !== length) throw new Error(`the long path is ${p.length} characters, not ${length}`);
  return p;
}

/** The 300-character path of the overflow checks. */
export const LONG_PATH = longPath("src/generated", "upload-retry-schedule.ts", 300);

/** Files of the example chat's folder for the search flows (relative path to contents). */
export const SEARCH_FILES: Record<string, string> = {
  [LONG_PATH]: "export const schedule = [200, 400, 800];\n",
  "notes/会議メモ 2026.md": "# 会議メモ\n\nアップロードの再試行について。\n",
  "notes/上传说明.txt": "上传失败时重试三次。\n",
  "assets/🚀 launch plan.md": "# Launch plan\n\n1. Ship the upload fix.\n",
  "assets/team-👩‍💻-notes.md": "# Team notes\n",
  "assets/Écran d'accueil.md": "# Écran d'accueil\n",
};

/** The empty blob's id (`git hash-object /dev/null`): every gate index entry points at it. */
export const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/** The two gate folders: the page path on a laptop at 100,000 rows, the server path on touch, and the page path on the phone at 20,000. */
export const GATE = {
  big: { dir: "gate-100k", rows: 100_000, name: "gate-100k", title: "Search 100,000 files" },
  phone: { dir: "gate-20k", rows: 20_000, name: "gate-20k", title: "Search 20,000 files" },
} as const;
export type GateKey = keyof typeof GATE;

const DIRS = ["src", "web", "server", "shared", "test", "lib", "docs", "scripts", "packages", "tools"];
const SUBS = ["components", "composer", "search", "upload", "store", "routes", "utils", "hooks", "styles", "api", "chat", "files"];
const WORDS = ["index", "main", "App", "config", "server", "client", "helper", "model", "view", "service", "handler", "route", "schema", "test", "mock", "fixture", "Component", "Provider", "context", "theme", "tokens", "search", "fuzzy", "match", "Upload", "Composer", "Picker", "Mention"];
const EXTS = ["ts", "tsx", "js", "json", "md", "css", "html", "txt", "yml"];

/**
 * `n` distinct paths in the shape of a monorepo's (package, folder, file), from a fixed LCG, so every run of the gate
 * types into the same corpus. The first rows are the overflow cases (the long path, CJK and emoji names).
 */
export function gatePaths(n: number): string[] {
  const out = [LONG_PATH, ...Object.keys(SEARCH_FILES).filter((p) => p !== LONG_PATH)].slice(0, n);
  let x = 0x2545f491;
  const next = (k: number) => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return (x >>> 8) % k;
  };
  for (let i = out.length; i < n; i++) {
    const pkg = `pkg${String(next(400)).padStart(3, "0")}`;
    const dir = `${DIRS[next(DIRS.length)]}/${SUBS[next(SUBS.length)]}`;
    const name = `${WORDS[next(WORDS.length)]}${WORDS[next(WORDS.length)]}${i}.${EXTS[next(EXTS.length)]}`;
    out.push(`${pkg}/${dir}/${name}`);
  }
  return out;
}

export function gitBinary(): string | null {
  return ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g)) ?? null;
}

/**
 * Make `dir` a git repository whose index holds `paths`, all at the empty blob, with no files on disk. No user or
 * system git config is read. Returns false when there is no git here.
 */
export function writeGateRepo(dir: string, paths: readonly string[], home: string): boolean {
  const git = gitBinary();
  if (!git) return false;
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const env = { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C" };
  const run = (args: string[], input?: string | Buffer) => {
    const r = spawnSync(git, ["-C", dir, "-c", "core.hooksPath=/dev/null", ...args], { env, input, stdio: ["pipe", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git ${args[0]} in the gate seed failed: ${String(r.stderr).slice(0, 200)}`);
  };
  run(["init", "-q", "-b", "main"]);
  // The blob itself, so the repository is whole; ls-files --cached never reads it.
  run(["hash-object", "-w", "--stdin"], "");
  run(["update-index", "--add", "-z", "--index-info"], Buffer.from(paths.map((p) => `100644 ${EMPTY_BLOB}\t${p}\0`).join("")));
  return true;
}
