// The package and the install tree (DESIGN.md 4.5, 4.7, 4.10; BUILD-CHECKLIST A1; DESIGN-I1 1.1 and 7): the version, the
// SDK pinned exactly, no SDK platform package installed anywhere, the scripts, what a package of it would hold (bin and
// files, checked with `bun pm pack --dry-run`; nothing is published), the start and update scripts, the two type-check
// configs.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RELEASE_VERSION } from "../../shared/release";

const ROOT = resolve(import.meta.dir, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version?: string;
  private?: boolean;
  license?: string;
  repository?: unknown;
  bin?: unknown;
  files?: string[];
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const SDK = "@anthropic-ai/claude-agent-sdk";
const EXACT = /^\d+\.\d+\.\d+$/;

/** JSON with // comments (a tsconfig), read without a JSON5 dependency. */
const readJsonc = (p: string) => JSON.parse(readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, ""));

/** What a package of kitespan holds: the code that runs, the page's source and its build, the lockfile, the installer and the public files. */
const FILES = ["bin/", "server/", "shared/", "web/", "scripts/build-web.ts", "dist/web/", "bunfig.toml", "bun.lock", "install.sh", "LICENSE", "NOTICE", "README.md", "README.zh-CN.md"];

describe("package.json", () => {
  test("it is private", () => {
    expect(pkg.private).toBe(true);
  });
  test("its licence is Apache-2.0 (L2), and it names no repository yet", () => {
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.repository).toBeUndefined();
  });
  test("its version, right after its name, is a release version: three numbers, nothing after them (DESIGN-I1 1.1)", () => {
    expect(Object.keys(pkg).slice(0, 2)).toEqual(["name", "version"]);
    expect(pkg.name).toBe("kitespan");
    expect(pkg.version).toMatch(RELEASE_VERSION);
  });
  test("bin names the start script, and files lists what a package would hold (DESIGN-I1 7; nothing is published)", () => {
    expect(pkg.bin).toEqual({ kitespan: "bin/kitespan" });
    expect(pkg.files).toEqual(FILES);
  });
  test("the SDK is pinned exactly to 0.3.312, and every dependency has an exact version", () => {
    expect(pkg.dependencies[SDK]).toBe("0.3.312");
    expect(pkg.devDependencies["@types/bun"]).toBe("1.3.14");
    for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) expect(`${name}@${v}`).toMatch(new RegExp(`@${EXACT.source.slice(1)}`));
  });
  test("the scripts of 4.5 exist (the prototype's went with prototype/)", () => {
    for (const s of ["start", "dev", "build", "test", "typecheck", "gate", "test:click", "test:live", "ui-check", "audit", "ci", "dco"]) expect(pkg.scripts[s]).toBeDefined();
    for (const s of ["proto:build", "proto:serve"]) expect(pkg.scripts[s]).toBeUndefined();
    expect(pkg.scripts.start).toBe("bin/kitespan");
    expect(pkg.scripts.dev).toBe("bin/kitespan dev");
    expect(pkg.scripts.build).toBe("bun scripts/build-web.ts");
    expect(pkg.scripts.typecheck).toContain("-p tsconfig.json");
    expect(pkg.scripts.typecheck).toContain("-p tsconfig.web.json");
    expect(pkg.scripts["test:live"]).toStartWith("KITESPAN_LIVE=1 ");
    // What CI runs, on this machine (P1 DESIGN 4.3), and the sign-off check (4.6).
    expect(pkg.scripts.ci).toBe("bun scripts/ci.ts");
    expect(pkg.scripts.dco).toBe("bun scripts/dco.ts");
  });
});

describe("the lockfile and the install tree", () => {
  test("bun.lock holds the pinned SDK", () => {
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
    expect(lock).toContain(`"${SDK}": "0.3.312"`);
    expect(lock).toContain(`"${SDK}": ["${SDK}@0.3.312"`);
  });
  test("the installed SDK is 0.3.312", () => {
    const installed = JSON.parse(readFileSync(join(ROOT, "node_modules", SDK, "package.json"), "utf8")) as { version: string };
    expect(installed.version).toBe("0.3.312");
  });
  test("no SDK platform package is installed: not in node_modules/@anthropic-ai, node_modules/.bun or a parent's node_modules (4.7 case 10)", () => {
    const found: string[] = [];
    const scope = (dir: string) => {
      const d = join(dir, "@anthropic-ai");
      if (existsSync(d)) for (const n of readdirSync(d)) if (n.startsWith("claude-agent-sdk-")) found.push(join(d, n));
    };
    scope(join(ROOT, "node_modules"));
    const isolated = join(ROOT, "node_modules", ".bun");
    if (existsSync(isolated)) for (const n of readdirSync(isolated)) if (n.startsWith("@anthropic-ai+claude-agent-sdk-")) found.push(join(isolated, n));
    for (let dir = dirname(ROOT); dir !== dirname(dir); dir = dirname(dir)) scope(join(dir, "node_modules"));
    expect(found).toEqual([]);
  });
});

describe("a package of it (bun pm pack --dry-run: nothing is written or published)", () => {
  test("it holds the start script, the server, the page's source, the lockfile, install.sh and the licence, and no test, workflow, formula or node_modules", () => {
    // Offline by construction where a user namespace can be made (pack itself reads no network); the dry run writes no
    // tarball and runs no script (package.json has no pack script).
    const offline = Bun.which("unshare") !== null && Bun.spawnSync(["unshare", "-cn", "true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    const r = Bun.spawnSync([...(offline ? ["unshare", "-cn"] : []), process.execPath, "pm", "pack", "--dry-run"], {
      cwd: ROOT,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? tmpdir(), TMPDIR: tmpdir(), LANG: "C.UTF-8" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect(r.exitCode, out).toBe(0);
    const packed = [...out.matchAll(/^packed \S+ (.+)$/gm)].map((m) => m[1]!.trim());
    expect(out).toContain(`kitespan-${pkg.version}.tgz`);
    for (const f of ["package.json", "bin/kitespan", "bin/update.sh", "server/main.ts", "shared/protocol.ts", "shared/release.ts", "web/index.html", "scripts/build-web.ts", "bun.lock", "bunfig.toml", "install.sh", "LICENSE", "NOTICE", "README.md", "README.zh-CN.md"])
      expect(packed, f).toContain(f);
    // Every packed path is package.json or one of files' entries (a folder by its prefix).
    const outside = packed.filter((p) => p !== "package.json" && !FILES.some((f) => (f.endsWith("/") ? p.startsWith(f) : p === f)));
    expect(outside).toEqual([]);
    for (const p of packed) expect(p).not.toMatch(/^(test|\.github|packaging|node_modules|prototype)\/|(^|\/)node_modules\//);
  });
});

describe("the start and update scripts", () => {
  for (const f of ["bin/kitespan", "bin/update.sh"])
    test(`${f} is an executable sh script`, () => {
      const p = join(ROOT, f);
      expect(statSync(p).mode & 0o111).not.toBe(0);
      expect(readFileSync(p, "utf8")).toStartWith("#!/bin/sh\n");
    });
  test("bin/kitespan runs Bun with --no-env-file", () => {
    expect(readFileSync(join(ROOT, "bin/kitespan"), "utf8")).toContain("--no-env-file");
  });
  test("bin/update.sh runs the Update button's own steps: a fetch and a fast-forward only, the install from the lockfile without optional packages, then the build", () => {
    const text = readFileSync(join(ROOT, "bin/update.sh"), "utf8");
    expect(text).toContain("set -eu");
    // Row 108: one copy of the rules, server/update/source.ts, which server/update/cli.ts runs for the script.
    expect(text).toContain('exec "$bun_bin" "--cwd=$root" --no-env-file "$root/server/update/cli.ts" "$@"');
    const source = readFileSync(join(ROOT, "server/update/source.ts"), "utf8");
    const steps = ['"fetch", "--no-tags"', '"merge", "--ff-only"', '"install", "--frozen-lockfile", "--omit=optional"', '"run", `--cwd=${root}`, "build", "--out", next'].map((s) => source.indexOf(s));
    expect(steps.every((i) => i > 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });
});

describe("repository files", () => {
  test(".gitignore keeps every .env file out (4.5)", () => {
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n")).toContain(".env*");
  });
  test("the README makes the raw promise", () => {
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain("Raw Claude Code experience. kitespan adds no ACP layer and no prompt of its own.");
  });
  test("the server's type check has no DOM library; the page's has", () => {
    const server = readJsonc(join(ROOT, "tsconfig.json"));
    const web = readJsonc(join(ROOT, "tsconfig.web.json"));
    expect(server.compilerOptions.lib).toEqual(["ESNext"]);
    expect(server.compilerOptions.types).toEqual(["bun"]);
    expect(web.extends).toBe("./tsconfig.json");
    expect(web.compilerOptions.lib).toContain("DOM");
    expect(web.include).toContain("web/**/*");
  });
});
