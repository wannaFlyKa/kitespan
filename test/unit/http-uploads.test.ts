// Uploads over the JSON API (DESIGN.md 4.4 "The upload folders", 6.4, 8.1 Uploads; build checklist C1): the byte cap
// just under, at and over Largest upload (measured, not trusted), a new 0700 `u-` folder per upload with its file at
// 0600, two files of one name in two folders, the folder check's line, which chat or form an upload belongs to, the
// sender gate's body type, and Remove. The folder check, the writer and the saved names are the store's
// (server/store/uploads.ts, with their own tests); here they run behind the route. No server is started: the handler
// is called, and the files go to a scratch folder.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { UPLOAD_ID } from "../../shared/ids";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import { createGate } from "../../server/gate/guards";
import { createApi, uploadType } from "../../server/http/api";
import { createApp } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { MB, UPLOAD_FOLDER_LINES, type UploadFolderResult } from "../../server/store/uploads";
import { SETTINGS_DEFAULTS, type ChatLedger, type ProjectRecord, type Settings, type UploadRecord } from "../../server/store/types";

const PORT = 7943;
const OWN = `http://127.0.0.1:${PORT}`;
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const ARCHIVED = "aaaaaaaaaaaaaaaaaaaa";
const PROJECT = "k3m7q2x4ab";

const dir = mkdtempSync(join(tmpdir(), "kitespan-uploads-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A reply as plain JSON; each test checks the fields it needs. */
const json = async (r: Response): Promise<any> => r.json();

function ledger(id: string, archivedAt: string | null): ChatLedger {
  const at = "2026-10-31T08:00:00.000Z";
  return { v: 1, id, project: PROJECT, cwd: dir, agent: "claude-code", sessionId: null, title: null, picks: { model: null, effort: null, permissionMode: null }, createdAt: at, seenAt: at, lastActivityAt: at, lastSeq: 0, state: "sleeping", lastExit: null, archivedAt };
}

type Body = string | Uint8Array | ReadableStream<Uint8Array>;

function setup(opts: { maxMB?: number; folder?: UploadFolderResult } = {}) {
  const folderPath = mkdtempSync(join(dir, "folder-"));
  const uploads: UploadRecord[] = [];
  const seen: { chat: string | null; project: string | null }[] = [];
  const settings: Settings = { ...SETTINGS_DEFAULTS, "uploads.maxMB": opts.maxMB ?? 1 };
  const project: ProjectRecord = { id: PROJECT, cwd: dir, name: "x", createdAt: "", lastUsedAt: "", picks: { model: null, effort: null, permissionMode: null } };
  const chats = [ledger(CHAT, null), ledger(ARCHIVED, "2026-10-31T09:00:00.000Z")];
  const store = {
    listProjects: async () => [project],
    putProject: async () => {},
    readSettings: async () => settings,
    readChat: async (id: string) => chats.find((c) => c.id === id) ?? null,
    listUploads: async (chat: string | null) => uploads.filter((u) => u.chat === chat),
    putUpload: async (rec: UploadRecord) => void uploads.push(rec),
    removeUpload: async (id: string) => {
      const i = uploads.findIndex((u) => u.id === id);
      return i >= 0 ? uploads.splice(i, 1)[0]! : null;
    },
  };
  const gate = createGate(PORT);
  const site = loadSite(join(dir, "no-build"), gate.origins);
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const api = createApi({
    gate,
    safe: site.safe,
    store,
    driver: { probe: unused, settings: unused, listSessions: async () => [], history: async () => ({ events: [], more: null }), sessionInfo: async () => null },
    uploadFolder: async ({ chat, project: p }) => {
      seen.push({ chat: chat?.id ?? null, project: p?.id ?? null });
      return opts.folder ?? { ok: true, path: folderPath, choice: "temp" };
    },
    chatForSession: () => null,
    heldSessions: () => new Set<string>(),
    info: { port: PORT, version: "0.1.0", adapters: PUBLIC_ADAPTERS },
  });
  const app = createApp({ gate, site, api, sockets: {} });
  const noServer = { upgrade: () => false };
  const upload = async (query: string, body: Body | null, headers: Record<string, string> = {}) =>
    (await app.fetch(
      new Request(`${OWN}/api/uploads?${query}`, {
        method: "POST",
        headers: { host: `127.0.0.1:${PORT}`, "x-kitespan": "1", "content-type": "application/octet-stream", origin: OWN, ...headers },
        body,
        duplex: "half",
      }),
      noServer,
    ))!;
  const del = async (id: string) =>
    (await app.fetch(
      new Request(`${OWN}/api/uploads/${id}`, { method: "DELETE", headers: { host: `127.0.0.1:${PORT}`, "x-kitespan": "1", "content-type": "application/json", origin: OWN }, body: "{}" }),
      noServer,
    ))!;
  const get = async (path: string) => (await app.fetch(new Request(`${OWN}${path}`, { headers: { host: `127.0.0.1:${PORT}` } }), noServer))!;
  return { upload, del, get, uploads, folderPath, seen, app };
}

const uFolders = (folder: string) => readdirSync(folder).filter((n) => n.startsWith("u-"));

describe("POST /api/uploads", () => {
  test("a file goes into its own new 0700 folder at 0600, and the reply has its path", async () => {
    const s = setup();
    const res = await s.upload(`chat=${CHAT}&name=${encodeURIComponent("my notes file.txt")}&type=text%2Fplain`, "The secret word is LANTERN.");
    expect(res.status).toBe(201);
    const { upload } = await json(res);
    expect(upload.id).toMatch(UPLOAD_ID);
    expect(upload).toMatchObject({ chat: CHAT, project: PROJECT, name: "my notes file.txt", size: 27, type: "text/plain" });
    expect(basename(upload.path)).toBe("my notes file.txt");
    const folder = dirname(upload.path);
    expect(dirname(folder)).toBe(s.folderPath);
    expect(basename(folder)).toMatch(/^u-[A-Za-z0-9]{6}$/);
    expect(lstatSync(folder).mode & 0o777).toBe(0o700);
    expect(lstatSync(upload.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(upload.path, "utf8")).toBe("The secret word is LANTERN.");
    expect(readdirSync(folder)).toEqual(["my notes file.txt"]);
    expect(s.uploads[0]).toMatchObject({ v: 1, id: upload.id, dir: folder, folder: "temp" });
    expect(s.seen).toEqual([{ chat: CHAT, project: PROJECT }]);
    const list = await json(await s.get(`/api/chats/${CHAT}/uploads`));
    expect(list.uploads.map((u: { id: string }) => u.id)).toEqual([upload.id]);
  });

  test("the saved name is the store's: a slash becomes an underscore, a nameless image is pasted.<type>", async () => {
    const s = setup();
    expect((await json(await s.upload(`chat=${CHAT}&name=${encodeURIComponent("a/b.txt")}`, "x"))).upload.name).toBe("a_b.txt");
    const pasted = (await json(await s.upload(`chat=${CHAT}&type=image%2Fpng`, new Uint8Array([137, 80])))).upload;
    expect(pasted).toMatchObject({ name: "pasted.png", type: "image/png" });
    expect(uploadType("IMAGE/PNG")).toBe("image/png");
    expect(uploadType("text/plain; charset=utf-8")).toBe("");
    expect(uploadType(null)).toBe("");
  });

  test("two files of one name never collide", async () => {
    const s = setup();
    const a = (await json(await s.upload(`chat=${CHAT}&name=report.txt`, "one"))).upload;
    const b = (await json(await s.upload(`chat=${CHAT}&name=report.txt`, "two"))).upload;
    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path, "utf8")).toBe("one");
    expect(readFileSync(b.path, "utf8")).toBe("two");
    expect(uFolders(s.folderPath).length).toBe(2);
  });

  test("the cap just under, at and over Largest upload; nothing stays from a refused file", async () => {
    const s = setup({ maxMB: 1 });
    expect((await s.upload(`chat=${CHAT}&name=under.bin`, new Uint8Array(MB - 1))).status).toBe(201);
    expect((await s.upload(`chat=${CHAT}&name=at.bin`, new Uint8Array(MB))).status).toBe(201);
    const over = await s.upload(`chat=${CHAT}&name=over.bin`, new Uint8Array(MB + 1));
    expect(over.status).toBe(413);
    expect((await json(over)).error).toEqual({ code: "too_large", message: "That file is larger than the 1 MB limit." });
    expect(uFolders(s.folderPath).length).toBe(2);
    expect(s.uploads.length).toBe(2);
  });

  test("the cap is measured on the bytes, not taken from a header", async () => {
    const s = setup({ maxMB: 1 });
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= MB + 64 * 1024) return c.close();
        sent += 64 * 1024;
        c.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const res = await s.upload(`chat=${CHAT}&name=streamed.bin`, stream);
    expect(res.status).toBe(413);
    expect(readdirSync(s.folderPath)).toEqual([]);
    expect(s.uploads).toEqual([]);
  });

  test("a folder that fails its check is refused with its line, and nothing is written", async () => {
    const s = setup({ folder: { ok: false, choice: "temp", path: "/tmp/x", problem: "symlink", line: UPLOAD_FOLDER_LINES.symlink } });
    const res = await s.upload(`chat=${CHAT}&name=a.txt`, "x");
    expect(res.status).toBe(409);
    expect((await json(res)).error).toEqual({ code: "upload_folder", message: UPLOAD_FOLDER_LINES.symlink });
    expect(s.uploads).toEqual([]);
  });

  test("the new-chat form uploads for its project; an archived or unknown chat cannot", async () => {
    const s = setup();
    const form = await s.upload(`project=${PROJECT}&name=a.txt`, "x");
    expect(form.status).toBe(201);
    expect((await json(form)).upload.chat).toBe(null);
    expect(s.seen.at(-1)).toEqual({ chat: null, project: PROJECT });
    const archived = await s.upload(`chat=${ARCHIVED}&name=a.txt`, "x");
    expect(archived.status).toBe(409);
    expect((await json(archived)).error.code).toBe("archived");
    expect((await s.upload(`chat=${"b".repeat(20)}&name=a.txt`, "x")).status).toBe(404);
    expect((await s.upload(`chat=${CHAT}&project=${PROJECT}&name=a.txt`, "x")).status).toBe(400);
    expect((await s.upload("name=a.txt", "x")).status).toBe(400);
    expect((await s.upload(`chat=${CHAT}&name=${"n".repeat(1025)}`, "x")).status).toBe(400);
  });

  test("iteration 7: the browser pane's chooser with no chat in reach uploads as the browser's own, with no chat or project", async () => {
    const s = setup();
    const res = await s.upload("browser=1&name=note.txt", "x");
    expect(res.status).toBe(201);
    const { upload } = await json(res);
    expect([upload.chat, upload.project, upload.name]).toEqual([null, null, "note.txt"]);
    expect(s.seen.at(-1)).toEqual({ chat: null, project: null });
    expect(s.uploads.map((u) => [u.chat, u.project])).toEqual([[null, null]]);
    // One owner only, and only browser=1.
    for (const q of [`browser=1&chat=${CHAT}`, `browser=1&project=${PROJECT}`, "browser=0", "browser=", "browser=true"]) expect((await s.upload(`${q}&name=a.txt`, "x")).status).toBe(400);
    expect(s.uploads.length).toBe(1);
  });

  test("the sender gate: JSON or a form is not an upload, and a foreign page cannot send one", async () => {
    const s = setup();
    expect((await s.upload(`chat=${CHAT}&name=a.txt`, "x", { "content-type": "application/json" })).status).toBe(403);
    expect((await s.upload(`chat=${CHAT}&name=a.txt`, "x", { "content-type": "multipart/form-data; boundary=b" })).status).toBe(403);
    expect((await s.upload(`chat=${CHAT}&name=a.txt`, "x", { origin: "https://evil.example" })).status).toBe(403);
    expect((await s.upload(`chat=${CHAT}&name=a.txt`, "x", { "x-kitespan": "0" })).status).toBe(403);
    expect(s.uploads).toEqual([]);
    expect(uFolders(s.folderPath)).toEqual([]);
  });

  test("a body that came through Bun.serve is saved, small or large (the stream is locked before the folder work)", async () => {
    const s = setup({ maxMB: 2 });
    // A Unix socket in the scratch folder: a real served request, with no TCP port.
    const sock = join(mkdtempSync(join(dir, "sock-")), "s.sock");
    const served = Bun.serve({ unix: sock, fetch: (req) => s.app.fetch(req, { upgrade: () => false }) as Promise<Response> });
    try {
      for (const body of ["The secret word is LANTERN.", "x".repeat(300_000)]) {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/uploads?chat=${CHAT}&name=served.txt`, {
          unix: sock,
          method: "POST",
          headers: { host: `127.0.0.1:${PORT}`, "x-kitespan": "1", "content-type": "application/octet-stream", origin: OWN },
          body,
        } as RequestInit);
        expect(res.status).toBe(201);
        const { upload } = await json(res);
        expect(readFileSync(upload.path, "utf8")).toBe(body);
      }
    } finally {
      served.stop(true);
    }
  });

  test("the upload folder for the page's drop line", async () => {
    const s = setup();
    expect(await json(await s.get(`/api/upload-folder?chat=${CHAT}`))).toEqual({ folder: { ok: true, path: s.folderPath } });
    expect(await json(await s.get(`/api/upload-folder?project=${PROJECT}`))).toEqual({ folder: { ok: true, path: s.folderPath } });
    expect((await s.get("/api/upload-folder")).status).toBe(400);
  });
});

describe("Remove", () => {
  test("DELETE removes the record and the upload's own folder", async () => {
    const s = setup();
    const { upload } = await json(await s.upload(`chat=${CHAT}&name=gone.txt`, "bye"));
    const res = await s.del(upload.id);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ removed: upload.id });
    expect(existsSync(dirname(upload.path))).toBe(false);
    expect(s.uploads).toEqual([]);
    expect((await s.del(upload.id)).status).toBe(404);
  });

  test("DELETE needs the sender gate", async () => {
    const s = setup();
    const { upload } = await json(await s.upload(`chat=${CHAT}&name=stay.txt`, "stay"));
    const res = await s.get(`/api/uploads/${upload.id}`);
    expect(res.status).toBe(405);
    expect(existsSync(upload.path)).toBe(true);
  });
});
