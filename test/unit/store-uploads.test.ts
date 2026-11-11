// Uploads (D37, D42, DESIGN.md 4.4 "The upload folders", 8.1 Uploads): saved names, the folder rule as a pure function
// and on disk for the four choices, a new u-XXXXXX folder per upload, 0700 and 0600, the measured byte cap, the
// rename to the saved name, Remove and the sweep, and the upload records.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ownUid } from "../../server/store/files";
import { createStore } from "../../server/store/store";
import type { UploadRecord } from "../../server/store/types";
import {
  MB,
  UPLOAD_FOLDER_LINES,
  UploadError,
  folderProblem,
  prepareUploadFolder,
  removeUploadDir,
  sweepUploadDirs,
  tooLargeLine,
  uploadCapBytes,
  uploadName,
  userTag,
  writeUpload,
  type FolderFacts,
  type UploadPlaces,
} from "../../server/store/uploads";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-store-uploads-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const mode = (p: string) => lstatSync(p).mode & 0o777;
const UID = ownUid();
const SESSION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const bytes = (n: number) => new Uint8Array(n).fill(97);

function places(): UploadPlaces & { root: string } {
  const root = fresh();
  for (const d of ["tmp", "home", "state-uploads"]) mkdirSync(join(root, d), { mode: 0o700 });
  return { root, stateUploads: join(root, "state-uploads"), tmpRoot: join(root, "tmp"), home: join(root, "home"), user: "tester", uid: UID };
}

describe("saved names", () => {
  test("a name keeps itself; a slash, a backslash or a control character becomes an underscore", () => {
    expect(uploadName("notes.txt", "text/plain")).toBe("notes.txt");
    expect(uploadName("my notes file.txt", "")).toBe("my notes file.txt");
    expect(uploadName("a/b\\c.txt", "")).toBe("a_b_c.txt");
    expect(uploadName("a\u0000b\u001fc\u007fd\u0085e", "")).toBe("a_b_c_d_e");
    expect(uploadName("line\u2028break", "")).toBe("line_break");
  });

  test("a bidirectional override cannot make a name read as another type", () => {
    expect(uploadName("invoice\u202efdp.exe", "")).toBe("invoice_fdp.exe");
    expect(uploadName("a\u2066b\u200fc", "")).toBe("a_b_c");
  });

  test("a nameless pasted file is pasted.<subtype>", () => {
    expect(uploadName("", "image/png")).toBe("pasted.png");
    expect(uploadName("", "image/svg+xml")).toBe("pasted.svg");
    expect(uploadName("", "text/plain")).toBe("pasted.txt");
    expect(uploadName("", "")).toBe("pasted");
    expect(uploadName("  ", "image/jpeg")).toBe("pasted.jpeg");
  });

  test("a name of dots only becomes an underscore", () => {
    expect(uploadName(".", "")).toBe("_");
    expect(uploadName("..", "")).toBe("_");
    expect(uploadName(".env", "")).toBe(".env");
  });

  test("a long name is held to 255 bytes of UTF-8 and keeps its extension, never cut inside a character", () => {
    const long = uploadName(`${"a".repeat(300)}.txt`, "");
    expect(new TextEncoder().encode(long).byteLength).toBe(255);
    expect(long.endsWith(".txt")).toBe(true);
    const wide = uploadName(`${"\u{1F600}".repeat(100)}.png`, "");
    expect(new TextEncoder().encode(wide).byteLength).toBeLessThanOrEqual(255);
    expect(wide.endsWith(".png")).toBe(true);
    expect(wide.slice(0, -4)).toBe("\u{1F600}".repeat(62));
  });

  test("the cap and its line; the user tag", () => {
    expect(uploadCapBytes(100)).toBe(100 * MB);
    expect(tooLargeLine(100)).toBe("That file is larger than the 100 MB limit.");
    expect(userTag("dev-1", 1000)).toBe("dev-1");
    expect(userTag("../x", 1000)).toBe("uid1000");
    expect(userTag("..", 1000)).toBe("uid1000");
    expect(userTag(undefined, 1000)).toBe("uid1000");
  });
});

describe("the folder rule as a pure function of an lstat result", () => {
  const dir = (m: number, over: Partial<FolderFacts> = {}): FolderFacts => ({ isDirectory: true, isSymbolicLink: false, uid: 1000, mode: 0o40000 | m, ...over });

  test("a symbolic link, another owner and a missing folder are refused for every choice", () => {
    for (const choice of ["temp", "state", "claude", "custom"] as const) {
      expect(folderProblem(choice, dir(0o700, { isSymbolicLink: true, isDirectory: false }), 1000)).toBe("symlink");
      expect(folderProblem(choice, dir(0o700, { uid: 1001 }), 1000)).toBe("owner");
      expect(folderProblem(choice, null, 1000)).toBe("missing");
      expect(folderProblem(choice, dir(0o600, { isDirectory: false }), 1000)).toBe("missing");
    }
  });

  test("the Temporary folder and kitespan's own: any group or other bit is refused; 0700 passes (D42)", () => {
    for (const choice of ["temp", "state"] as const) {
      expect(folderProblem(choice, dir(0o700), 1000)).toBeNull();
      for (const m of [0o755, 0o750, 0o710, 0o701, 0o704, 0o1777]) expect(folderProblem(choice, dir(m), 1000)).toBe("mode");
    }
  });

  test("Claude Code's folder and a custom folder: a group or other write bit is refused; 0755 passes", () => {
    for (const choice of ["claude", "custom"] as const) {
      expect(folderProblem(choice, dir(0o700), 1000)).toBeNull();
      expect(folderProblem(choice, dir(0o755), 1000)).toBeNull();
      for (const m of [0o775, 0o757, 0o722, 0o777]) expect(folderProblem(choice, dir(m), 1000)).toBe("mode");
    }
  });

  test("each refusal has its line of 4.4", () => {
    expect(UPLOAD_FOLDER_LINES.symlink).toBe("The upload folder is a symbolic link, so kitespan does not use it. Pick another folder in Settings > Chats > Uploads.");
    expect(UPLOAD_FOLDER_LINES.owner).toBe("The upload folder belongs to another user, so kitespan does not use it. Pick another folder in Settings > Chats > Uploads.");
    expect(UPLOAD_FOLDER_LINES.mode).toBe("Other users can open or change the upload folder, so kitespan does not use it. Run chmod 700 on it, or pick another folder in Settings > Chats > Uploads.");
    expect(UPLOAD_FOLDER_LINES.missing).toBe("The upload folder does not exist. Make it, or pick another folder in Settings > Chats > Uploads.");
  });
});

describe("the four folders on disk", () => {
  test("the Temporary folder is made 0700 with the user's name, and passes", async () => {
    const p = places();
    const r = await prepareUploadFolder("temp", p, { customFolder: null, sessionId: null });
    expect(r).toEqual({ ok: true, choice: "temp", path: join(p.tmpRoot, "kitespan-uploads-tester") });
    expect(mode(join(p.tmpRoot, "kitespan-uploads-tester"))).toBe(0o700);
    expect(await prepareUploadFolder("temp", p, { customFolder: null, sessionId: null })).toMatchObject({ ok: true });
  });

  test("a Temporary folder made first at 0755 is refused and nothing is written into it", async () => {
    const p = places();
    const planted = join(p.tmpRoot, "kitespan-uploads-tester");
    mkdirSync(planted, { mode: 0o755 });
    chmodSync(planted, 0o755);
    const r = await prepareUploadFolder("temp", p, { customFolder: null, sessionId: null });
    expect(r).toMatchObject({ ok: false, problem: "mode", line: UPLOAD_FOLDER_LINES.mode });
    expect(mode(planted)).toBe(0o755);
    expect(readdirSync(planted)).toEqual([]);
  });

  test("a symbolic link planted as the Temporary folder is refused and its target stays untouched", async () => {
    const p = places();
    const target = join(p.root, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(p.tmpRoot, "kitespan-uploads-tester"));
    const r = await prepareUploadFolder("temp", p, { customFolder: null, sessionId: null });
    expect(r).toMatchObject({ ok: false, problem: "symlink" });
    expect(readdirSync(target)).toEqual([]);
  });

  test("a dangling symbolic link planted as the Temporary folder is refused and its target is not made", async () => {
    const p = places();
    const target = join(p.root, "never-made");
    symlinkSync(target, join(p.tmpRoot, "kitespan-uploads-tester"));
    expect(await prepareUploadFolder("temp", p, { customFolder: null, sessionId: null })).toMatchObject({ ok: false, problem: "symlink" });
    expect(existsSync(target)).toBe(false);
  });

  test("kitespan's own folder is the state folder's uploads/", async () => {
    const p = places();
    expect(await prepareUploadFolder("state", p, { customFolder: null, sessionId: null })).toEqual({ ok: true, choice: "state", path: p.stateUploads });
    chmodSync(p.stateUploads, 0o750);
    expect(await prepareUploadFolder("state", p, { customFolder: null, sessionId: null })).toMatchObject({ ok: false, problem: "mode" });
  });

  test("Claude Code's folder: ~/.claude/uploads/<session>/ is made 0700 for the chat's session (D41)", async () => {
    const p = places();
    mkdirSync(join(p.home, ".claude"), { mode: 0o755 });
    const r = await prepareUploadFolder("claude", p, { customFolder: null, sessionId: SESSION });
    const path = join(p.home, ".claude", "uploads", SESSION);
    expect(r).toEqual({ ok: true, choice: "claude", path });
    expect(mode(path)).toBe(0o700);
    chmodSync(path, 0o775);
    expect(await prepareUploadFolder("claude", p, { customFolder: null, sessionId: SESSION })).toMatchObject({ ok: false, problem: "mode" });
    await expect(prepareUploadFolder("claude", p, { customFolder: null, sessionId: "../x" })).rejects.toThrow(TypeError);
  });

  test("Claude Code's folder without ~/.claude is missing; nothing is made", async () => {
    const p = places();
    expect(await prepareUploadFolder("claude", p, { customFolder: null, sessionId: SESSION })).toMatchObject({ ok: false, problem: "missing" });
    expect(readdirSync(p.home)).toEqual([]);
  });

  test("a custom folder must exist and is never made; 0755 passes; a link is refused", async () => {
    const p = places();
    expect(await prepareUploadFolder("custom", p, { customFolder: null, sessionId: null })).toMatchObject({ ok: false, problem: "missing", path: null });
    const missing = join(p.root, "not-there");
    expect(await prepareUploadFolder("custom", p, { customFolder: missing, sessionId: null })).toMatchObject({ ok: false, problem: "missing" });
    expect(existsSync(missing)).toBe(false);
    const open = join(p.root, "shared");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(await prepareUploadFolder("custom", p, { customFolder: open, sessionId: null })).toEqual({ ok: true, choice: "custom", path: open });
    symlinkSync(open, join(p.root, "link"));
    expect(await prepareUploadFolder("custom", p, { customFolder: join(p.root, "link"), sessionId: null })).toMatchObject({ ok: false, problem: "symlink" });
  });

  test("the store's upload folder follows the settings (Temporary by default, under the test root)", async () => {
    const root = fresh();
    const store = createStore({ root, user: "tester" });
    await store.open();
    mkdirSync(join(root, "tmp"), { mode: 0o700 });
    expect(await store.uploadFolder(null)).toEqual({ ok: true, choice: "temp", path: join(root, "tmp", "kitespan-uploads-tester") });
    await store.writeSettings({ "uploads.folder": "state" });
    expect(await store.uploadFolder(null)).toEqual({ ok: true, choice: "state", path: store.dirs.uploads });
    await store.writeSettings({ "uploads.folder": "custom" });
    expect(await store.uploadFolder(null)).toMatchObject({ ok: false, problem: "missing" });
  });
});

describe("the upload writer", () => {
  test("each upload gets a new u-XXXXXX folder at 0700 and its file at 0600, under its saved name", async () => {
    const folder = fresh();
    const w = await writeUpload(folder, "my notes file.txt", "text/plain", new TextEncoder().encode("The word is LANTERN."), 100, UID);
    expect(basename(w.dir)).toMatch(/^u-[A-Za-z0-9]{6}$/);
    expect(w.path).toBe(join(w.dir, "my notes file.txt"));
    expect(w).toMatchObject({ name: "my notes file.txt", size: 20 });
    expect(mode(w.dir)).toBe(0o700);
    expect(mode(w.path)).toBe(0o600);
    expect(readFileSync(w.path, "utf8")).toBe("The word is LANTERN.");
    expect(readdirSync(w.dir)).toEqual(["my notes file.txt"]);
  });

  test("two files with one name never collide", async () => {
    const folder = fresh();
    const a = await writeUpload(folder, "same.txt", "", new TextEncoder().encode("one"), 100, UID);
    const b = await writeUpload(folder, "same.txt", "", new TextEncoder().encode("two"), 100, UID);
    expect(a.dir).not.toBe(b.dir);
    expect(readFileSync(a.path, "utf8")).toBe("one");
    expect(readFileSync(b.path, "utf8")).toBe("two");
  });

  test("the byte cap just under, at and over the limit; over it nothing is left behind", async () => {
    const folder = fresh();
    expect((await writeUpload(folder, "a", "", bytes(9), 10, UID)).size).toBe(9);
    expect((await writeUpload(folder, "b", "", bytes(10), 10, UID)).size).toBe(10);
    const err = await writeUpload(folder, "c", "", bytes(11), 10, UID).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe("too_large");
    expect(readdirSync(folder).length).toBe(2);
  });

  test("the cap is measured on the bytes as they arrive, from a stream", async () => {
    const folder = fresh();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 50) return c.close();
        c.enqueue(bytes(4));
      },
    });
    const err = await writeUpload(folder, "big.bin", "", stream, 10, UID).catch((e) => e);
    expect((err as UploadError).code).toBe("too_large");
    expect(pulled).toBeLessThan(10);
    expect(readdirSync(folder)).toEqual([]);
    async function* parts() {
      yield bytes(3);
      yield bytes(4);
    }
    const ok = await writeUpload(folder, "ok.bin", "", parts(), 10, UID);
    expect(ok.size).toBe(7);
    expect(readFileSync(ok.path).byteLength).toBe(7);
  });

  test("a pasted image with no name is saved as pasted.png; a hostile name stays a name", async () => {
    const folder = fresh();
    expect((await writeUpload(folder, "", "image/png", bytes(1), 10, UID)).name).toBe("pasted.png");
    const w = await writeUpload(folder, "$(touch x);y.txt", "", bytes(1), 10, UID);
    expect(basename(w.path)).toBe("$(touch x);y.txt");
    expect(existsSync(join(folder, "x"))).toBe(false);
  });

  test("an empty file is an upload", async () => {
    const w = await writeUpload(fresh(), "empty.txt", "", new Uint8Array(0), 10, UID);
    expect(w.size).toBe(0);
    expect(readFileSync(w.path).byteLength).toBe(0);
  });
});

describe("Remove and the sweep", () => {
  test("Remove deletes a real u- folder, and leaves a symbolic link with its target alone", async () => {
    const folder = fresh();
    const w = await writeUpload(folder, "a.txt", "", bytes(1), 10, UID);
    expect(await removeUploadDir(w.dir, UID)).toBe(true);
    expect(existsSync(w.dir)).toBe(false);
    const target = join(fresh(), "keep");
    mkdirSync(target);
    writeFileSync(join(target, "precious.txt"), "x");
    symlinkSync(target, join(folder, "u-LiNk01"));
    expect(await removeUploadDir(join(folder, "u-LiNk01"), UID)).toBe(false);
    expect(readFileSync(join(target, "precious.txt"), "utf8")).toBe("x");
    expect(await removeUploadDir(folder, UID)).toBe(false);
    expect(existsSync(folder)).toBe(true);
  });

  test("the sweep removes old u- folders, keeps new ones, and leaves a link, its target and other names alone", async () => {
    const folder = fresh();
    const now = Date.now();
    const old = (await writeUpload(folder, "old.txt", "", bytes(1), 10, UID)).dir;
    const fresh1 = (await writeUpload(folder, "new.txt", "", bytes(1), 10, UID)).dir;
    const target = join(fresh(), "target");
    mkdirSync(target);
    writeFileSync(join(target, "precious.txt"), "x");
    symlinkSync(target, join(folder, "u-LiNk01"));
    writeFileSync(join(old, "inner-link-target-check"), "y");
    symlinkSync(join(target, "precious.txt"), join(old, "inner-link"));
    mkdirSync(join(folder, "keep-me"));
    const eightDays = (now - 8 * 86_400_000) / 1000;
    utimesSync(old, eightDays, eightDays);
    utimesSync(join(folder, "keep-me"), eightDays, eightDays);
    // Every folder's time comes from `now`, never the file system's clock.
    const anHour = (now - 3_600_000) / 1000;
    utimesSync(fresh1, anHour, anHour);
    expect(await sweepUploadDirs(folder, 7, now, UID)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh1)).toBe(true);
    expect(lstatSync(join(folder, "u-LiNk01")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, "precious.txt"), "utf8")).toBe("x");
    expect(existsSync(join(folder, "keep-me"))).toBe(true);
  });
});

describe("the upload records", () => {
  const PROJECT = "k3m7q2x4ab";
  const CHAT = "k3m7q2x4abk3m7q2x4ab";
  const rec = (id: string, chat: string | null, over: Partial<UploadRecord> = {}): UploadRecord => ({
    v: 1,
    id,
    chat,
    project: PROJECT,
    name: "notes.txt",
    size: 20,
    type: "text/plain",
    path: "/srv/up/u-AbC123/notes.txt",
    folder: "custom",
    dir: "/srv/up/u-AbC123",
    at: "2026-10-31T12:00:00.000Z",
    ...over,
  });

  test("an upload waits under null on the new-chat form, then belongs to its chat; kept after a restart", async () => {
    const root = fresh();
    const store = createStore({ root });
    await store.open();
    await store.putUpload(rec("aaaaaaaaaaaaaaaa", null));
    await store.putUpload(rec("bbbbbbbbbbbbbbbb", CHAT));
    expect((await store.listUploads(null)).map((u) => u.id)).toEqual(["aaaaaaaaaaaaaaaa"]);
    await store.putUpload(rec("aaaaaaaaaaaaaaaa", CHAT));
    expect(await store.listUploads(null)).toEqual([]);
    expect((await store.listUploads(CHAT)).map((u) => u.id)).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    expect(mode(join(root, "state", "uploads.json"))).toBe(0o600);
    const again = createStore({ root });
    await again.open();
    expect((await again.listUploads(CHAT)).length).toBe(2);
    expect(await again.removeUpload("bbbbbbbbbbbbbbbb")).toEqual(rec("bbbbbbbbbbbbbbbb", CHAT));
    expect(await again.removeUpload("bbbbbbbbbbbbbbbb")).toBeNull();
    expect((await again.listUploads(CHAT)).map((u) => u.id)).toEqual(["aaaaaaaaaaaaaaaa"]);
  });

  test("a record whose path is not its name inside its own u- folder is refused", async () => {
    const store = createStore({ root: fresh() });
    await store.open();
    for (const over of [
      { path: "/etc/passwd" },
      { dir: "/srv/up", path: "/srv/up/notes.txt" },
      { name: "a/b", path: "/srv/up/u-AbC123/a/b" },
      { name: "..", path: "/srv/up/u-AbC123/.." },
      { id: "short" },
      { chat: "bad" },
      { folder: "desktop" as never },
      { size: -1 },
    ]) {
      expect(((await store.putUpload(rec("aaaaaaaaaaaaaaaa", CHAT, over)).catch((e) => e)) as { code: string }).code).toBe("bad_value");
    }
    expect(await store.listUploads(CHAT)).toEqual([]);
  });
});
