// The name sweep (round K1, the rename to kitespan): no file of the repository says the old name, flydeck, in its text
// or its path, outside the allow-list below. An entry is code that reads what the old name left behind, or a test of
// that code, and says why it may name the old name. An entry that allows nothing fails too, so the list cannot go stale.
//
// The files are the ones a commit takes: git ls-files, tracked, and untracked but not ignored (a new file is swept
// before its first commit). The match is case-insensitive and also takes the split forms (fly deck, fly-deck, fly_deck,
// fly.deck). A file with a NUL byte is searched as bytes and named without a line.
import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

/** The old name in any case, whole or split by one blank (a space or a tab), dot, dash or underscore. */
const OLD = /fly[\s._-]?deck/i;

interface Allowed {
  /** The path from the repository root. */
  path: string;
  /** "file": every line may name the old name. A pattern (no g or y flag): only the lines that match it may. */
  lines: "file" | RegExp;
  /** The path itself names the old name. */
  ownPath?: true;
  why: string;
}

const ALLOWED: Allowed[] = [
  {
    path: "bin/flydeck",
    lines: "file",
    ownPath: true,
    why: "the old command, for one release: it says the new name and execs bin/kitespan with every argument, so that a server of the old name restarts into the new code in the same process",
  },
  {
    path: "bin/kitespan",
    lines: /\$config_home\/flydeck\b/,
    why: "the start reads start-env from the old config folder while that folder has not moved (sh cannot import shared/legacy.ts); one release",
  },
  {
    path: "shared/legacy.ts",
    lines: "file",
    why: "every old literal in one place, for the code that reads what the old name left: the folder name, the env prefix, the header, the branch prefix, the log prefix, the stored-key prefix, the old command and the moved folder's note; the branch prefix and the data folder's name stay while old worktrees may exist, the rest one release",
  },
  {
    path: "web/index.html",
    lines: /"flydeck\."/,
    why: "the inline script moves the page's stored keys to the new prefix before the first paint, and an inline script cannot import; one release",
  },
  {
    path: "scripts/install-trial.sh",
    lines: /^\s*for p in "\$link" .*"\$data\/flydeck" "\$states\/flydeck" "\$configs\/flydeck"; do$/,
    why: "the trial refuses a home that holds the old name's data, state or config folder, which the start it makes would move (sh cannot import shared/legacy.ts); for as long as that move is there",
  },
  { path: "test/unit/rename-stub.test.ts", lines: /\bbin\/flydeck\b/, why: "the test of the old command's stub names the stub" },
  { path: "test/web/rename-keys.test.ts", lines: "file", why: "the test of the stored keys' move writes the old keys" },
  { path: "test/unit/name-sweep.test.ts", lines: "file", why: "this test: the old name, and the allow-list's own paths" },
];

/** The process environment without any GIT_* name (a GIT_DIR or GIT_INDEX_FILE would point git elsewhere). */
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  return { ...env, ...extra };
}

function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "core.fsmonitor=false", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${r.stderr.toString().trim().split("\n")[0] ?? `exit ${r.exitCode}`}`);
  return r.stdout.toString();
}

/**
 * A file's lines (a symbolic link: its target), or its bytes when it holds a NUL byte; "none" for a submodule's
 * folder; null when it is gone (tracked, but deleted in the work tree: the next commit drops it).
 */
function contentOf(full: string): { lines: string[] } | { bytes: string } | "none" | null {
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return { lines: [readlinkSync(full)] };
  if (!st.isFile()) return "none";
  const buf = readFileSync(full);
  return buf.includes(0) ? { bytes: buf.toString("latin1") } : { lines: buf.toString("utf8").split("\n") };
}

function excerpt(line: string): string {
  const flat = line.replace(/\s+/g, " ").trim();
  const at = flat.search(OLD);
  const from = Math.max(0, at - 50);
  const to = Math.min(flat.length, at + 60);
  return `${from > 0 ? "..." : ""}${flat.slice(from, to)}${to < flat.length ? "..." : ""}`;
}

interface Sweep {
  /** Each hit outside the allow-list: `path (its path)`, `path:line: excerpt` or `path (a binary file)`. */
  refused: string[];
  /** Each allow-list entry, or part of one, that allowed nothing. */
  stale: string[];
}

function sweep(root: string, allowed: Allowed[], env: Record<string, string>): Sweep {
  const files = [...new Set(git(root, env, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean))].sort();
  const entries = new Map(allowed.map((a) => [a.path, a]));
  const usedPath = new Set<Allowed>();
  const usedLines = new Set<Allowed>();
  const refused: string[] = [];
  for (const path of files) {
    const content = contentOf(join(root, path));
    if (!content) continue;
    const entry = entries.get(path);
    if (OLD.test(path)) {
      if (entry?.ownPath) usedPath.add(entry);
      else refused.push(`${path} (its path)`);
    }
    if (content === "none") continue;
    if ("bytes" in content) {
      if (!OLD.test(content.bytes)) continue;
      if (entry?.lines === "file") usedLines.add(entry);
      else refused.push(`${path} (a binary file)`);
      continue;
    }
    content.lines.forEach((line, i) => {
      if (!OLD.test(line)) return;
      if (entry && (entry.lines === "file" || entry.lines.test(line))) usedLines.add(entry);
      else refused.push(`${path}:${i + 1}: ${excerpt(line)}`);
    });
  }
  const stale: string[] = [];
  for (const a of allowed) {
    if (!usedLines.has(a)) stale.push(`${a.path}: allows ${a.lines === "file" ? "the whole file" : `the lines that match ${a.lines}`}, but no such line there names the old name`);
    if (a.ownPath && !usedPath.has(a)) stale.push(`${a.path}: allows its path, but that path is not in the repository or does not name the old name`);
  }
  return { refused, stale };
}

describe("the allow-list", () => {
  test("each entry names one path, says why, and its line pattern keeps no state between lines", () => {
    expect(new Set(ALLOWED.map((a) => a.path)).size).toBe(ALLOWED.length);
    for (const a of ALLOWED) {
      expect(a.why.length).toBeGreaterThan(10);
      if (a.lines !== "file") expect(a.lines.flags).not.toMatch(/[gy]/);
    }
  });
});

describe("the sweep finds the old name", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("in a line, a path, a split form and a binary file, tracked or not; never in an ignored or a deleted file; and it names a stale entry", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-sweep-")));
    dirs.push(dir);
    const env = gitEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
    git(dir, env, "init", "-q");
    const put = (path: string, text: string | Uint8Array) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    put(".gitignore", "ignored/\n");
    put("tracked.ts", "const a = 1;\n// see FlyDeck here\n");
    put("clean.ts", "export const NAME = 'kitespan';\n");
    put("flydeck-gone.ts", "flydeck\n");
    put("docs/fly-deck.md", "# notes\nthe fly deck words\n");
    put("ignored/old.ts", "flydeck\n");
    put("icon.bin", new Uint8Array([0, 1, 2, ...new TextEncoder().encode("FLYDECK"), 0]));
    put("old.ts", "const OLD = 'flydeck';\n");
    put("page.html", '<script>var from = "flydeck.";</script>\n<title>flydeck</title>\n');
    put("quiet.ts", "nothing old here\n");
    git(dir, env, "add", "tracked.ts", "clean.ts", "flydeck-gone.ts", "old.ts");
    unlinkSync(join(dir, "flydeck-gone.ts"));

    const allowed: Allowed[] = [
      { path: "old.ts", lines: "file", why: "a whole-file entry that is used" },
      { path: "page.html", lines: /"flydeck\."/, why: "a line entry that allows one line of two" },
      { path: "quiet.ts", lines: "file", why: "an entry whose file has no old name" },
      { path: "missing.ts", lines: "file", why: "an entry whose file is not there" },
      { path: "clean.ts", lines: "file", ownPath: true, why: "a path entry whose path has no old name" },
    ];
    const { refused, stale } = sweep(dir, allowed, env);
    expect(refused).toEqual([
      "docs/fly-deck.md (its path)",
      "docs/fly-deck.md:2: the fly deck words",
      "icon.bin (a binary file)",
      "page.html:2: <title>flydeck</title>",
      "tracked.ts:2: // see FlyDeck here",
    ]);
    expect(stale).toEqual([
      "quiet.ts: allows the whole file, but no such line there names the old name",
      "missing.ts: allows the whole file, but no such line there names the old name",
      "clean.ts: allows the whole file, but no such line there names the old name",
      "clean.ts: allows its path, but that path is not in the repository or does not name the old name",
    ]);
  });
});

describe("the repository", () => {
  let result: Sweep | undefined;
  const swept = () => (result ??= sweep(ROOT, ALLOWED, gitEnv()));

  test("no file says the old name outside the allow-list", () => {
    expect(swept().refused).toEqual([]);
  });

  test("every allow-list entry still allows something", () => {
    expect(swept().stale).toEqual([]);
  });
});
