// The store's file layer (DESIGN.md 4.4, "How every file is written"): the one atomic writer, the read checks,
// `.bad`, the stray `*.tmp` sweep, the tree check and the per-file queue, in scratch folders.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Serial, StoreError, TMP_RE, checkTree, openExclusive, ownUid, readJson, setAside, sweepTmp, tmpName, unlinkSynced, writeAtomic } from "../../server/store/files";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-store-files-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const mode = (p: string) => lstatSync(p).mode & 0o777;
const UID = ownUid();
const MiB = 1024 * 1024;

describe("the atomic writer", () => {
  test("writes the file 0600 under its name and leaves no temporary file", async () => {
    const dir = fresh();
    await writeAtomic(dir, "rec.json", '{"a":1}', 1024, UID);
    expect(readFileSync(join(dir, "rec.json"), "utf8")).toBe('{"a":1}');
    expect(mode(join(dir, "rec.json"))).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["rec.json"]);
  });

  test("replaces the old version whole", async () => {
    const dir = fresh();
    await writeAtomic(dir, "rec.json", "old", 1024, UID);
    await writeAtomic(dir, "rec.json", "new", 1024, UID);
    expect(readFileSync(join(dir, "rec.json"), "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["rec.json"]);
  });

  test("a file that was 0644 becomes 0600 again", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "rec.json"), "old", { mode: 0o644 });
    chmodSync(join(dir, "rec.json"), 0o644);
    await writeAtomic(dir, "rec.json", "new", 1024, UID);
    expect(mode(join(dir, "rec.json"))).toBe(0o600);
  });

  test("the size cap: at the cap it writes; one byte over it refuses and keeps the old version", async () => {
    const dir = fresh();
    await writeAtomic(dir, "rec.json", "x".repeat(16), 16, UID);
    expect(readFileSync(join(dir, "rec.json"), "utf8")).toBe("x".repeat(16));
    const err = await writeAtomic(dir, "rec.json", "y".repeat(17), 16, UID).catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("too_large");
    expect(readFileSync(join(dir, "rec.json"), "utf8")).toBe("x".repeat(16));
    expect(readdirSync(dir)).toEqual(["rec.json"]);
  });

  test("the cap counts UTF-8 bytes, not characters", async () => {
    const dir = fresh();
    const err = await writeAtomic(dir, "rec.json", "\u00e9".repeat(9), 16, UID).catch((e) => e);
    expect((err as StoreError).code).toBe("too_large");
  });

  test("the temporary file's name is .<name>.<16 hex>.tmp", () => {
    const n = tmpName("projects.json");
    expect(n).toMatch(/^\.projects\.json\.[0-9a-f]{16}\.tmp$/);
    expect(TMP_RE.test(n)).toBe(true);
    expect(TMP_RE.test("projects.json")).toBe(false);
    expect(TMP_RE.test(".projects.json.tmp")).toBe(false);
  });

  test("the exclusive open fails with EEXIST on a planted symbolic link and leaves its target alone", async () => {
    const dir = fresh();
    const target = join(dir, "target.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(dir, "planted"));
    const err = await openExclusive(join(dir, "planted")).catch((e) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(readFileSync(target, "utf8")).toBe("untouched");
    const dangling = join(dir, "dangling");
    symlinkSync(join(dir, "nothing-here"), dangling);
    expect(((await openExclusive(dangling).catch((e) => e)) as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(existsSync(join(dir, "nothing-here"))).toBe(false);
  });

  test("a reader process never sees a torn file while the writer replaces it 300 times", async () => {
    const dir = fresh();
    const file = join(dir, "rec.json");
    const body = (n: number) => JSON.stringify({ n, pad: String(n % 10).repeat(30_000) });
    await writeAtomic(dir, "rec.json", body(0), MiB, UID);
    const ready = join(dir, "ready");
    const stop = join(dir, "stop");
    const script = join(dir, "reader.ts");
    writeFileSync(
      script,
      [
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";`,
        `let reads = 0, torn = 0;`,
        `writeFileSync(${JSON.stringify(ready)}, "");`,
        `while (!existsSync(${JSON.stringify(stop)})) {`,
        `  try { const r = JSON.parse(readFileSync(${JSON.stringify(file)}, "utf8")); if (r.pad.length !== 30000) torn++; } catch { torn++; }`,
        `  reads++;`,
        `}`,
        `console.log(JSON.stringify({ reads, torn }));`,
      ].join("\n"),
    );
    const proc = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    for (let i = 0; i < 500 && !existsSync(ready); i++) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    for (let n = 1; n <= 300; n++) await writeAtomic(dir, "rec.json", body(n), MiB, UID);
    writeFileSync(stop, "");
    const out = JSON.parse(await new Response(proc.stdout).text()) as { reads: number; torn: number };
    await proc.exited;
    expect(out.reads).toBeGreaterThan(0);
    expect(out.torn).toBe(0);
  }, 30_000);
});

describe("the read checks", () => {
  test("absent, ok and bad", async () => {
    const dir = fresh();
    expect(await readJson(join(dir, "none.json"), 1024, UID)).toEqual({ kind: "absent" });
    writeFileSync(join(dir, "ok.json"), '{"a":1}', { mode: 0o600 });
    expect(await readJson(join(dir, "ok.json"), 1024, UID)).toEqual({ kind: "ok", value: { a: 1 } });
    writeFileSync(join(dir, "torn.json"), '{"a":', { mode: 0o600 });
    expect(await readJson(join(dir, "torn.json"), 1024, UID)).toEqual({ kind: "bad" });
  });

  test("over the cap, a wider mode, a symbolic link, a folder or bad UTF-8 is bad", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "big.json"), `"${"x".repeat(30)}"`, { mode: 0o600 });
    expect((await readJson(join(dir, "big.json"), 16, UID)).kind).toBe("bad");
    writeFileSync(join(dir, "wide.json"), "{}", { mode: 0o600 });
    chmodSync(join(dir, "wide.json"), 0o644);
    expect((await readJson(join(dir, "wide.json"), 1024, UID)).kind).toBe("bad");
    writeFileSync(join(dir, "real.json"), "{}", { mode: 0o600 });
    symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
    expect((await readJson(join(dir, "link.json"), 1024, UID)).kind).toBe("bad");
    mkdirSync(join(dir, "folder.json"), { mode: 0o700 });
    expect((await readJson(join(dir, "folder.json"), 1024, UID)).kind).toBe("bad");
    writeFileSync(join(dir, "latin1.json"), new Uint8Array([0x22, 0xe9, 0x22]), { mode: 0o600 });
    expect((await readJson(join(dir, "latin1.json"), 1024, UID)).kind).toBe("bad");
  });

  test("setAside renames the file to <name>.bad", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "x.json"), "nope", { mode: 0o600 });
    await setAside(dir, "x.json");
    expect(readdirSync(dir)).toEqual(["x.json.bad"]);
    expect(readFileSync(join(dir, "x.json.bad"), "utf8")).toBe("nope");
    await setAside(dir, "x.json");
    expect(readdirSync(dir)).toEqual(["x.json.bad"]);
  });

  test("unlinkSynced removes a file and does not mind a missing one", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "x.json"), "{}", { mode: 0o600 });
    expect(await unlinkSynced(dir, "x.json")).toBe(true);
    expect(await unlinkSynced(dir, "x.json")).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the tmp sweep", () => {
  test("removes the stray temporary files only", async () => {
    const dir = fresh();
    writeFileSync(join(dir, ".rec.json.0123456789abcdef.tmp"), "half", { mode: 0o600 });
    writeFileSync(join(dir, ".a.json.fedcba9876543210.tmp"), "half", { mode: 0o600 });
    writeFileSync(join(dir, "rec.json"), "{}", { mode: 0o600 });
    writeFileSync(join(dir, "notes.tmp"), "kept", { mode: 0o600 });
    mkdirSync(join(dir, ".d.json.0123456789abcdef.tmp"), { mode: 0o700 });
    expect(await sweepTmp(dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([".d.json.0123456789abcdef.tmp", "notes.tmp", "rec.json"]);
  });
});

describe("the tree check", () => {
  test("a clean tree passes", async () => {
    const root = fresh();
    mkdirSync(join(root, "chats"), { mode: 0o700 });
    writeFileSync(join(root, "chats", "a.json"), "{}", { mode: 0o600 });
    expect(await checkTree(root, UID)).toEqual([]);
  });

  test("a wider folder, a wider file and a symbolic link are each named", async () => {
    const root = fresh();
    mkdirSync(join(root, "chats"), { mode: 0o700 });
    chmodSync(join(root, "chats"), 0o755);
    writeFileSync(join(root, "chats", "a.json"), "{}", { mode: 0o600 });
    chmodSync(join(root, "chats", "a.json"), 0o640);
    symlinkSync("/", join(root, "drafts"));
    expect(await checkTree(root, UID)).toEqual([
      { path: "chats", why: "wider-mode" },
      { path: "chats/a.json", why: "wider-mode" },
      { path: "drafts", why: "symlink" },
    ]);
  });

  test("another owner is named (checked against a different user id)", async () => {
    const root = fresh();
    expect(await checkTree(root, UID + 1)).toEqual([{ path: ".", why: "owner" }]);
  });

  test("a root that is a file is not a folder", async () => {
    const root = fresh();
    writeFileSync(join(root, "f"), "x", { mode: 0o600 });
    expect(await checkTree(join(root, "f"), UID)).toEqual([{ path: ".", why: "not-a-folder" }]);
  });
});

describe("the per-file queue", () => {
  test("jobs on one key run one after another, in order, also after a failure", async () => {
    const q = new Serial();
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) => async () => {
      log.push(`${name} start`);
      await Bun.sleep(ms);
      log.push(`${name} end`);
      if (fail) throw new Error(name);
    };
    const a = q.run("f", job("a", 20, true));
    const b = q.run("f", job("b", 1));
    const c = q.run("g", job("c", 1));
    await expect(a).rejects.toThrow("a");
    await b;
    await c;
    await q.idle();
    expect(log.indexOf("b start")).toBeGreaterThan(log.indexOf("a end"));
    expect(log.indexOf("c start")).toBeLessThan(log.indexOf("a end"));
  });
});
