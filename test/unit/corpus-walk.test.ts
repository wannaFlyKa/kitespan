// The corpus outside git (DESIGN.md 9.3; build checklist B2): a bounded, breadth-first walk of a scratch tree. Dot
// entries and node_modules skipped; regular files only; a link neither followed nor listed; the root's file system
// only; the cap counted per file, also inside one folder larger than the room left; a stalled read stubbed in.

import { afterAll, describe, expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFiles, type WalkFs } from "../../server/search/walk";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-corpus-walk-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function tree(name: string, files: string[]): string {
  const dir = join(ROOT, name);
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "x\n");
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

const REAL: WalkFs = { readdir: (p) => readdir(p, { withFileTypes: true }), lstat: (p) => lstat(p) };
const walk = (root: string, more: Partial<Parameters<typeof walkFiles>[1]> = {}) => walkFiles(root, { max: 100_000, ms: 3_000, ...more });

describe("the walk", () => {
  test("files only, breadth first; dot entries, node_modules and links left out", async () => {
    const dir = tree("plain", ["a.txt", "sub/b.txt", "sub/deep/c.txt", ".hidden/x.txt", ".env", "node_modules/m/index.js", "sub/node_modules/n.js", "z.md"]);
    symlinkSync("/etc", join(dir, "link-etc"));
    symlinkSync("..", join(dir, "link-up"));
    symlinkSync("a.txt", join(dir, "link-file"));
    symlinkSync("sub", join(dir, "link-sub"));
    Bun.spawnSync(["mkfifo", join(dir, "pipe")]);
    const got = await walk(dir);
    expect(got).toEqual({ ok: true, paths: ["a.txt", "z.md", "sub/b.txt", "sub/deep/c.txt"], capped: false, timeout: false });
  });

  test("the cap is counted per file: one folder larger than the room left stops at the cap", async () => {
    const big = Array.from({ length: 50 }, (_, i) => `big/f${String(i).padStart(2, "0")}.txt`);
    const dir = tree("capped", ["top.txt", ...big, "later/x.txt"]);
    const got = await walk(dir, { max: 10 });
    expect(got.paths).toEqual(["top.txt", ...big.slice(0, 9)]);
    expect([got.capped, got.timeout, got.ok]).toEqual([true, false, true]);
    // Exactly at the cap with nothing left: not capped.
    expect((await walk(tree("exact", ["a", "b"]), { max: 2 })).capped).toBe(false);
  });

  test("the same tree gives the same list, whichever folder's read ends first", async () => {
    const dir = tree("order", ["a-slow/1.txt", "a-slow/2.txt", "b-fast/3.txt", "c.txt"]);
    const fs: WalkFs = {
      readdir: async (p) => {
        if (p === join(dir, "a-slow")) await Bun.sleep(60);
        return REAL.readdir(p);
      },
      lstat: REAL.lstat,
    };
    const want = ["c.txt", "a-slow/1.txt", "a-slow/2.txt", "b-fast/3.txt"];
    expect((await walk(dir, { fs })).paths).toEqual(want);
    expect((await walk(dir, { fs, max: 2 })).paths).toEqual(want.slice(0, 2));
  });

  test("a capped walk keeps the files nearest the root", async () => {
    const dir = tree("near", ["d1/d2/d3/deep.txt", "d1/mid.txt", "top.txt"]);
    expect((await walk(dir, { max: 2 })).paths).toEqual(["top.txt", "d1/mid.txt"]);
  });

  test("a folder on another file system is not entered", async () => {
    const dir = tree("mounts", ["a.txt", "mnt/elsewhere.txt", "same/b.txt"]);
    // A stand-in for a mount point: the folder reports another device.
    const fs: WalkFs = {
      readdir: REAL.readdir,
      lstat: async (p) => {
        const st = await lstat(p);
        return p === join(dir, "mnt") ? { dev: st.dev + 1, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } : st;
      },
    };
    expect((await walk(dir, { fs })).paths).toEqual(["a.txt", "same/b.txt"]);
  });

  test("a stalled read is waited for only its own deadline; the rest of the tree is listed", async () => {
    const dir = tree("stalled", ["a.txt", "slow/never.txt", "fast/b.txt"]);
    let asks = 0;
    const fs: WalkFs = {
      readdir: (p) => (p === join(dir, "slow") ? (asks++, new Promise<Dirent[]>(() => {})) : REAL.readdir(p)),
      lstat: REAL.lstat,
    };
    const t0 = performance.now();
    const got = await walk(dir, { fs, ms: 2_000, probeMs: 100 });
    expect(performance.now() - t0).toBeLessThan(1_500);
    expect(got).toEqual({ ok: true, paths: ["a.txt", "fast/b.txt"], capped: false, timeout: true });
    // A second walk while the first read still hangs shares it (one stalled thread, not one per walk).
    await walk(dir, { fs, ms: 2_000, probeMs: 100 });
    expect(asks).toBe(1);
  });

  test("the budget ends the walk", async () => {
    const dir = tree("budget", ["a.txt", "s1/b.txt", "s2/c.txt"]);
    const fs: WalkFs = {
      readdir: async (p) => {
        await Bun.sleep(p === dir ? 0 : 400);
        return REAL.readdir(p);
      },
      lstat: REAL.lstat,
    };
    const t0 = performance.now();
    const got = await walk(dir, { fs, ms: 150, probeMs: 1_000 });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect([got.paths, got.timeout]).toEqual([["a.txt"], true]);
  });

  test("a root that is not a folder, or not there", async () => {
    const dir = tree("file-root", ["only.txt"]);
    expect(await walk(join(dir, "only.txt"))).toEqual({ ok: false, paths: [], capped: false, timeout: false });
    expect(await walk(join(ROOT, "gone"))).toEqual({ ok: false, paths: [], capped: false, timeout: false });
  });
});
