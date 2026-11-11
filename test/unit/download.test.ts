// Downloads (DESIGN.md 6.4, 5.4, D37; build checklist C3): RFC 6266 names, a HEAD probe first, a file inside the
// chat's folder only (a link that leads outside reads nothing), a folder as one .tar.gz that the system tar unpacks
// (long and non-ASCII names, links kept as links, modes), the folder caps, and an upload's own file. No server is
// started: the handler is called, in a scratch folder.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import { createGate } from "../../server/gate/guards";
import { createApi } from "../../server/http/api";
import { createApp } from "../../server/http/app";
import { contentDisposition, probeTarget, walkFolder, type FolderLimits } from "../../server/http/files";
import { loadSite } from "../../server/http/static";
import { SETTINGS_DEFAULTS, type ChatLedger, type UploadRecord } from "../../server/store/types";

const PORT = 7943;
const OWN = `http://127.0.0.1:${PORT}`;
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const UPLOAD = "abcdefghijklmnop";
const LONG = `${"deep-folder-name-".repeat(5)}/${"a-very-long-file-name-".repeat(5)}.txt`;

const dir = mkdtempSync(join(tmpdir(), "kitespan-download-"));
const project = join(dir, "project");
const outside = join(dir, "outside");
const uploadDir = join(dir, "u-abc123");

beforeAll(() => {
  mkdirSync(join(project, "src", "empty"), { recursive: true });
  mkdirSync(join(project, "src", LONG.split("/")[0]!), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(project, "src", "a.txt"), "alpha\n");
  writeFileSync(join(project, "src", "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(project, "src", "run.sh"), 0o755);
  writeFileSync(join(project, "src", "été.txt"), "summer\n");
  writeFileSync(join(project, "src", LONG), "long\n");
  writeFileSync(join(outside, "secret.txt"), "SECRET-OUTSIDE\n");
  symlinkSync(join(outside, "secret.txt"), join(project, "src", "leak.txt"));
  symlinkSync("a.txt", join(project, "src", "alias.txt"));
  symlinkSync(outside, join(project, "out-dir"));
  // Links whose answer must not depend on what is outside: their targets outside are there or gone.
  mkdirSync(join(project, "links"));
  symlinkSync(join(outside, "gone.txt"), join(project, "links", "abs-gone"));
  symlinkSync("../../outside/secret.txt", join(project, "links", "rel-there"));
  symlinkSync("../../outside/gone.txt", join(project, "links", "rel-gone"));
  symlinkSync("/nonexistent-kitespan-probe", join(project, "links", "abs-root-gone"));
  symlinkSync("/etc", join(project, "links", "etc-dir"));
  // Links that stay inside: a dangling one, one by the folder's real path, one that leaves by .. and comes back.
  symlinkSync("no-such-target.txt", join(project, "links", "dangling"));
  symlinkSync(join(realpathSync(project), "src", "a.txt"), join(project, "links", "abs-inside"));
  symlinkSync(`../../${basename(project)}/src/a.txt`, join(project, "links", "back-in"));
  symlinkSync("loop-b", join(project, "links", "loop-a"));
  symlinkSync("loop-a", join(project, "links", "loop-b"));
  // Links that leave the folder and come back in by a folder outside: through one that is there and one that is gone.
  // The paths are built by hand, because join() would fold the `..` away.
  mkdirSync(join(outside, "sub"));
  const back = `${basename(project)}/src/a.txt`;
  symlinkSync(`${realpathSync(outside)}/sub/../../${back}`, join(project, "links", "detour-there"));
  symlinkSync(`${realpathSync(outside)}/nosuch/../../${back}`, join(project, "links", "detour-gone"));
  symlinkSync(`../../outside/sub/../../${back}`, join(project, "links", "rel-detour-there"));
  symlinkSync(`../../outside/nosuch/../../${back}`, join(project, "links", "rel-detour-gone"));
  Bun.spawnSync(["mkfifo", join(project, "src", "pipe")]);
  writeFileSync(join(project, "notes.md"), "# Notes\n");
  mkdirSync(uploadDir, { mode: 0o700 });
  writeFileSync(join(uploadDir, "my notes file.txt"), "The secret word is LANTERN.", { mode: 0o600 });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeApp(folderLimits?: FolderLimits) {
  const at = "2026-10-31T08:00:00.000Z";
  const chat: ChatLedger = { v: 1, id: CHAT, project: "k3m7q2x4ab", cwd: project, agent: "claude-code", sessionId: null, title: null, picks: { model: null, effort: null, permissionMode: null }, createdAt: at, seenAt: at, lastActivityAt: at, lastSeq: 0, state: "sleeping", lastExit: null, archivedAt: null };
  const upload: UploadRecord = { v: 1, id: UPLOAD, chat: CHAT, project: "k3m7q2x4ab", name: "my notes file.txt", size: 27, type: "text/plain", path: join(uploadDir, "my notes file.txt"), folder: "temp", dir: uploadDir, at };
  const gate = createGate(PORT);
  const site = loadSite(join(dir, "no-build"), gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store: {
      listProjects: async () => [],
      putProject: async () => {},
      readSettings: async () => ({ ...SETTINGS_DEFAULTS }),
      readChat: async (id) => (id === CHAT ? chat : null),
      listUploads: async (c) => (c === CHAT ? [upload] : []),
      putUpload: async () => {},
      removeUpload: async () => null,
    },
    driver: { probe: async () => { throw new Error("unused"); }, settings: async () => { throw new Error("unused"); }, listSessions: async () => [], history: async () => ({ events: [], more: null }), sessionInfo: async () => null },
    uploadFolder: async () => ({ ok: true, choice: "temp", path: dir }),
    chatForSession: () => null,
    heldSessions: () => new Set<string>(),
    info: { port: PORT, version: "0.1.0", adapters: PUBLIC_ADAPTERS },
    folderLimits,
  });
  const app = createApp({ gate, site, api, sockets: {} });
  return async (path: string, method = "GET", headers: Record<string, string> = {}) =>
    (await app.fetch(new Request(`${OWN}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }), { upgrade: () => false }))!;
}

const files = (rel: string) => `/api/chats/${CHAT}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;

describe("RFC 6266 names", () => {
  test("a plain name", () => {
    expect(contentDisposition("report.txt")).toBe(`attachment; filename="report.txt"; filename*=UTF-8''report.txt`);
  });

  test("a non-ASCII name keeps its exact form in filename* and an ASCII stand-in in filename", () => {
    const d = contentDisposition("Résumé (final).pdf");
    expect(d).toBe(`attachment; filename="R_sum_ (final).pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%28final%29.pdf`);
    expect(decodeURIComponent(d.split("''")[1]!)).toBe("Résumé (final).pdf");
  });

  test("quotes, backslashes, percent signs and control characters cannot break the header", () => {
    const d = contentDisposition('a"b\\c%41\r\nx.txt');
    expect(d.startsWith(`attachment; filename="a_b_c_41__x.txt"; filename*=UTF-8''`)).toBe(true);
    expect(d).not.toMatch(/[\r\n]/);
    expect(decodeURIComponent(d.split("''")[1]!)).toBe('a"b\\c%41\r\nx.txt');
    expect(contentDisposition("")).toBe(`attachment; filename="download"; filename*=UTF-8''`);
  });
});

describe("a file in the chat's folder", () => {
  test("HEAD first: the name, the size and the kind, no body", async () => {
    const fetch = makeApp();
    const head = await fetch(files("src/a.txt"), "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("6");
    expect(head.headers.get("x-kitespan-kind")).toBe("file");
    expect(head.headers.get("content-disposition")).toBe(contentDisposition("a.txt"));
    expect(await head.text()).toBe("");
  });

  test("GET sends the bytes as an attachment that the browser does not sniff", async () => {
    const fetch = makeApp();
    const res = await fetch(files("src/été.txt"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(contentDisposition("été.txt"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("summer\n");
    expect(await (await fetch(files(`src/${LONG}`))).text()).toBe("long\n");
  });

  test("a link inside the folder reads; a link that leads outside reads nothing", async () => {
    const fetch = makeApp();
    const alias = await fetch(files("src/alias.txt"));
    expect(await alias.text()).toBe("alpha\n");
    expect(alias.headers.get("content-disposition")).toBe(contentDisposition("alias.txt"));
    for (const rel of ["src/leak.txt", "out-dir/secret.txt", "out-dir"]) {
      const res = await fetch(files(rel));
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain("That file is not in this chat's folder.");
      expect(text).not.toContain("SECRET");
    }
  });

  test("no path leaves the folder, and a fifo is not a file", async () => {
    const fetch = makeApp();
    for (const p of [
      `/api/chats/${CHAT}/files/../outside/secret.txt`,
      `/api/chats/${CHAT}/files/src/%2E%2E/%2E%2E/outside/secret.txt`,
      `/api/chats/${CHAT}/files/src/..%2F..%2Foutside%2Fsecret.txt`,
      `/api/chats/${CHAT}/files/%2Fetc%2Fhostname`,
      `/api/chats/${CHAT}/files/`,
      files("src/pipe"),
      files("src/missing.txt"),
      `/api/chats/${"b".repeat(20)}/files/src/a.txt`,
    ]) {
      const res = await fetch(p);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("SECRET");
    }
  });

  test("a download is a read: POST and DELETE are not routes", async () => {
    const fetch = makeApp();
    expect((await fetch(files("src/a.txt"), "DELETE", { "x-kitespan": "1", "content-type": "application/json", origin: OWN })).status).toBe(405);
  });
});

describe("a folder as .tar.gz", () => {
  test("HEAD gives the count and the total size before any byte is sent", async () => {
    const fetch = makeApp();
    const walk = await walkFolder(join(project, "src"));
    const head = await fetch(files("src"), "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("x-kitespan-kind")).toBe("folder");
    expect(head.headers.get("content-type")).toBe("application/gzip");
    expect(head.headers.get("content-disposition")).toBe(contentDisposition("src.tar.gz"));
    expect(head.headers.get("x-kitespan-entries")).toBe(String(walk.entries.length));
    expect(head.headers.get("x-kitespan-bytes")).toBe(String(6 + 18 + 7 + 5));
    // The folder itself, empty/, the long name's folder, a.txt, alias.txt, été.txt, the long file, leak.txt, run.sh;
    // the fifo is left out.
    expect(walk.entries.length).toBe(9);
    expect(walk.entries.map((e) => e.rel)).not.toContain("pipe");
  });

  test("the system tar unpacks it: names, contents, modes, and links as links", async () => {
    const fetch = makeApp();
    const res = await fetch(files("src"));
    expect(res.status).toBe(200);
    const gz = new Uint8Array(await res.arrayBuffer());
    const out = mkdtempSync(join(dir, "unpack-"));
    writeFileSync(join(out, "src.tar.gz"), gz);
    const list = Bun.spawnSync(["tar", "-tzf", join(out, "src.tar.gz")], { stdout: "pipe", stderr: "pipe" });
    expect(list.exitCode).toBe(0);
    // The archive holds each name as the folder lists it (the server never changes a name's Unicode form) ...
    const listed = readdirSync(join(project, "src")).find((n) => n.normalize("NFC") === "été.txt")!;
    expect(listed).toBeDefined();
    expect(Buffer.from(Bun.gunzipSync(gz)).includes(Buffer.from(`src/${listed}`))).toBe(true);
    // ... but the system tar may print it in another form: bsdtar (libarchive) on macOS gives its names in NFD. So its
    // list is compared in one form, NFC.
    const names = list.stdout.toString().trim().split("\n").map((n) => n.normalize("NFC")).sort();
    expect(names).toContain("src/");
    expect(names).toContain("src/empty/");
    expect(names).toContain("src/été.txt");
    expect(names).toContain(`src/${LONG}`);
    const x = Bun.spawnSync(["tar", "-xzf", join(out, "src.tar.gz"), "-C", out], { stdout: "pipe", stderr: "pipe" });
    expect(x.exitCode).toBe(0);
    expect(readFileSync(join(out, "src", "a.txt"), "utf8")).toBe("alpha\n");
    expect(readFileSync(join(out, "src", "été.txt"), "utf8")).toBe("summer\n");
    expect(readFileSync(join(out, "src", LONG), "utf8")).toBe("long\n");
    expect(lstatSync(join(out, "src", "run.sh")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(out, "src", "leak.txt")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(out, "src", "leak.txt"))).toBe(join(outside, "secret.txt"));
    expect(readlinkSync(join(out, "src", "alias.txt"))).toBe("a.txt");
    expect(lstatSync(join(out, "src", "empty")).isDirectory()).toBe(true);
    expect(Bun.gunzipSync(gz).toString()).not.toContain("SECRET-OUTSIDE");
  });

  test("a folder over a cap is refused with its line, on HEAD and on GET", async () => {
    const byCount = makeApp({ entries: 3, bytes: 1024 ** 3 });
    const res = await byCount(files("src"));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("too_large");
    expect((await byCount(files("src"), "HEAD")).status).toBe(413);
    const bySize = makeApp({ entries: 1000, bytes: 10 });
    expect((await bySize(files("src"))).status).toBe(413);
    expect((await makeApp({ entries: 1000, bytes: 10 })(files("src/a.txt"))).status).toBe(200);
  });
});

describe("the existence probe (5.4): a missing or outside path is a normal 200 read", () => {
  const exists = (rel: string) => `/api/chats/${CHAT}/exists/${rel.split("/").map(encodeURIComponent).join("/")}`;
  const read = async (fetch: ReturnType<typeof makeApp>, path: string) => {
    const res = await fetch(path);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    return JSON.parse(text) as Record<string, unknown>;
  };

  test("a file and a folder: what the download would send, the folder's caps included", async () => {
    const fetch = makeApp();
    expect(await read(fetch, exists("src/a.txt"))).toEqual({ exists: true, kind: "file", name: "a.txt", size: 6 });
    expect(await read(fetch, exists("src/alias.txt"))).toEqual({ exists: true, kind: "file", name: "alias.txt", size: 6 });
    expect(await read(fetch, exists("src"))).toMatchObject({ exists: true, kind: "folder", name: "src", over: false });
    expect(await read(makeApp({ entries: 3, bytes: 1024 ** 3 }), exists("src"))).toMatchObject({ exists: true, kind: "folder", over: true });
  });

  test("gone, outside the folder, not a file, an unknown chat: each says why, and none is an error", async () => {
    const fetch = makeApp();
    expect(await read(fetch, exists("src/missing.txt"))).toEqual({ exists: false, reason: "missing" });
    expect(await read(fetch, exists("nope/deeper/x.txt"))).toEqual({ exists: false, reason: "missing" });
    for (const rel of ["src/leak.txt", "out-dir/secret.txt", "out-dir"]) expect(await read(fetch, exists(rel))).toEqual({ exists: false, reason: "outside" });
    // A `..` segment (also as %2E%2E) never arrives: the URL parser, the browser's too, folds it away first. Inside a
    // segment, with an encoded slash, it reaches the probe.
    for (const p of [
      `/api/chats/${CHAT}/exists/src/..%2F..%2Foutside%2Fsecret.txt`,
      `/api/chats/${CHAT}/exists/%2Fetc%2Fhostname`,
      `/api/chats/${CHAT}/exists/`,
    ]) {
      expect(await read(fetch, p)).toEqual({ exists: false, reason: "outside" });
    }
    expect(await read(fetch, exists("src/pipe"))).toEqual({ exists: false, reason: "not_a_file" });
    expect(await read(fetch, `/api/chats/${"b".repeat(20)}/exists/src/a.txt`)).toEqual({ exists: false, reason: "no_chat" });
  });

  test("a link that leads outside reads outside whether its target is there or not: the probe looks at nothing past the folder", async () => {
    const fetch = makeApp();
    for (const rel of [
      "out-dir/no-such.txt",
      "out-dir/deeper/no-such.txt",
      "links/abs-gone",
      "links/rel-there",
      "links/rel-gone",
      "links/abs-root-gone",
      "links/etc-dir/passwd",
      "links/etc-dir/no-such-file",
    ])
      expect([rel, await read(fetch, exists(rel))]).toEqual([rel, { exists: false, reason: "outside" }]);
    // Inside the folder: a dangling link and a loop are missing; a link by the folder's real path or one that leaves
    // by .. and comes back in reads the file.
    expect(await read(fetch, exists("links/dangling"))).toEqual({ exists: false, reason: "missing" });
    expect(await read(fetch, exists("links/loop-a"))).toEqual({ exists: false, reason: "missing" });
    expect(await read(fetch, exists("links/abs-inside"))).toEqual({ exists: true, kind: "file", name: "abs-inside", size: 6 });
    expect(await read(fetch, exists("links/back-in"))).toEqual({ exists: true, kind: "file", name: "back-in", size: 6 });
    expect(await read(fetch, exists("src/a.txt/x"))).toEqual({ exists: false, reason: "missing" });
  });

  test("a link that steps outside and comes back in by another way: the probe and the download say the same, whatever is outside", async () => {
    const fetch = makeApp();
    for (const rel of ["links/detour-there", "links/detour-gone", "links/rel-detour-there", "links/rel-detour-gone"]) {
      expect([rel, await read(fetch, exists(rel))]).toEqual([rel, { exists: false, reason: "outside" }]);
      for (const method of ["GET", "HEAD"]) {
        const res = await fetch(files(rel), method);
        expect([rel, method, res.status]).toEqual([rel, method, 404]);
        expect(await res.text()).not.toContain("alpha");
      }
    }
  });

  test("a folder that its chat names by a link: an absolute link target by that name stays inside", async () => {
    const named = join(dir, "project-by-link");
    symlinkSync(project, named);
    symlinkSync(join(named, "src", "a.txt"), join(project, "links", "by-name"));
    const r = await probeTarget(named, "links/by-name");
    expect(r.exists && r.target.kind === "file" ? r.target.size : null).toBe(6);
    expect(await probeTarget(named, "links/rel-gone")).toEqual({ exists: false, reason: "outside" });
    expect(await probeTarget(named, "../outside/secret.txt")).toEqual({ exists: false, reason: "outside" });
  });

  test("an upload's own file: there, an unknown upload, an unknown chat", async () => {
    const fetch = makeApp();
    expect(await read(fetch, `/api/chats/${CHAT}/uploads/${UPLOAD}/exists`)).toEqual({ exists: true, kind: "file", name: "my notes file.txt", size: 27 });
    expect(await read(fetch, `/api/chats/${CHAT}/uploads/${"q".repeat(16)}/exists`)).toEqual({ exists: false, reason: "missing" });
    expect(await read(fetch, `/api/chats/${"b".repeat(20)}/uploads/${UPLOAD}/exists`)).toEqual({ exists: false, reason: "no_chat" });
  });

  test("it is a read like the others: a foreign Origin is refused, and it has no POST", async () => {
    const fetch = makeApp();
    expect((await fetch(exists("src/a.txt"), "GET", { origin: "http://evil.example" })).status).toBe(403);
    expect((await fetch(exists("src/a.txt"), "POST", { "x-kitespan": "1", "content-type": "application/json", origin: OWN })).status).toBe(405);
  });
});

describe("an upload's own file", () => {
  test("HEAD and GET by the upload's id, with its saved name", async () => {
    const fetch = makeApp();
    const path = `/api/chats/${CHAT}/uploads/${UPLOAD}/file`;
    const head = await fetch(path, "HEAD");
    expect(head.headers.get("content-length")).toBe("27");
    expect(head.headers.get("content-disposition")).toBe(contentDisposition("my notes file.txt"));
    expect(await (await fetch(path)).text()).toBe("The secret word is LANTERN.");
    expect((await fetch(`/api/chats/${CHAT}/uploads/${"q".repeat(16)}/file`)).status).toBe(404);
  });
});
