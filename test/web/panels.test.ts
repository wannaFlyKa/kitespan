// The side panel, its detail views, the uploads list and the download page (DESIGN.md 6.7, 6.4, D37, D51; build
// checklist B5 and C3; MINIMALISM M17, M18, M21, M22, M27, M34). Two parts:
// - the page's download probe against the server's own existence probe (no server is started: the API's handler is
//   called, in a scratch folder): a 200 read first, the name, a folder as .tar.gz, the 5.4 line for a gone path with
//   no failed request (so no console error);
// - the panel's views drawn from the store (react-dom/server): each card from real data, shown once it holds
//   something, the problem count of Connectors, one line per file, no milestone label and no helper foot.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import { createGate } from "../../server/gate/guards";
import { createApi } from "../../server/http/api";
import { contentDisposition, type FolderLimits } from "../../server/http/files";
import { contentSecurityPolicy, safeHeaders } from "../../server/http/headers";
import { SETTINGS_DEFAULTS, type ChatLedger, type UploadRecord } from "../../server/store/types";
import type { ConnectorInfo } from "../../shared/protocol";
import { parse } from "../../web/router";
import { act, resetState, tooLargeLine } from "../../web/state/store";
import type { Chat, Project, Upload } from "../../web/state/types";
import { Cards } from "../../web/panels/cards";
import { Detail, UNKNOWN } from "../../web/panels/details";
import { FOLDER_TOO_LARGE, FILE_GONE, OUTPUT_GONE, UPLOAD_GONE, dispositionName, download, existsUrl, filesUrl, probe, uploadUrl } from "../../web/panels/download";
import { toolOutputPath } from "../../shared/protocol";
import { FileBody } from "../../web/panels/file";
import { connectorProblems, inChatFolder, outputPath } from "../../web/panels/format";
import { claudeVersion } from "../../web/panels/parts";
import { applyEvent } from "../../web/state/reduce";
import { SidePanel } from "../../web/panels/SidePanel";
import { UploadsView } from "../../web/panels/uploads";
import { scripted } from "./fixtures";

// ---------------------------------------------------------------------------------------------------------------
// The download route, as the page asks it

const PORT = 7946;
const OWN = `http://127.0.0.1:${PORT}`;
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const UPLOAD = "abcdefghijklmnop";
const PROJECT = "k3m7q2x4ab";

const dir = mkdtempSync(join(tmpdir(), "kitespan-panels-"));
const folder = join(dir, "project");
const outside = join(dir, "outside");
const uploadDir = join(dir, "u-abc123");
mkdirSync(join(folder, "src", "deep"), { recursive: true });
mkdirSync(outside);
mkdirSync(uploadDir, { mode: 0o700 });
writeFileSync(join(folder, "src", "a.txt"), "alpha\n");
writeFileSync(join(folder, "src", "deep", "b.txt"), "bravo!\n");
writeFileSync(join(folder, "src", "résumé final.md"), "# CV\n");
writeFileSync(join(outside, "secret.txt"), "SECRET\n");
symlinkSync(join(outside, "secret.txt"), join(folder, "src", "leak.txt"));
writeFileSync(join(uploadDir, "my notes file.txt"), "The secret word is LANTERN.", { mode: 0o600 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The server's API handler (the real routes) as a fetch for the page's helpers, plus every request it got. */
function serverFetch(limits?: FolderLimits): { fetcher: typeof fetch; seen: Request[] } {
  const at = "2026-10-31T08:00:00.000Z";
  const chat: ChatLedger = { v: 1, id: CHAT, project: PROJECT, cwd: folder, agent: "claude-code", sessionId: null, title: null, picks: { model: null, effort: null, permissionMode: null }, createdAt: at, seenAt: at, lastActivityAt: at, lastSeq: 0, state: "sleeping", lastExit: null, archivedAt: null };
  const upload: UploadRecord = { v: 1, id: UPLOAD, chat: CHAT, project: PROJECT, name: "my notes file.txt", size: 27, type: "text/plain", path: join(uploadDir, "my notes file.txt"), folder: "temp", dir: uploadDir, at };
  const gate = createGate(PORT);
  const api = createApi({
    gate,
    safe: safeHeaders(contentSecurityPolicy([], gate.origins)),
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
    folderLimits: limits,
  });
  const seen: Request[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("host", `127.0.0.1:${PORT}`);
    const req = new Request(`${OWN}${String(input)}`, { ...init, headers });
    seen.push(req);
    return api.handle(req, new URL(req.url));
  }) as typeof fetch;
  return { fetcher, seen };
}

describe("the download probe (the existence probe first) on the server's own routes", () => {
  test("a file: its kind, its size and the server's name", async () => {
    const { fetcher } = serverFetch();
    const r = await probe(filesUrl(CHAT, "src/a.txt"), "file", fetcher);
    expect(r).toEqual({ ok: true, probe: { kind: "file", name: "a.txt", size: 6, entries: null } });
  });

  test("a name with spaces and non-ASCII letters keeps its exact form (RFC 6266 filename*)", async () => {
    const { fetcher } = serverFetch();
    const r = await probe(filesUrl(CHAT, "src/résumé final.md"), "file", fetcher);
    expect(r.ok && r.probe.name).toBe("résumé final.md");
  });

  test("a folder comes as .tar.gz, with its entries and the size of its files", async () => {
    const { fetcher } = serverFetch();
    const r = await probe(filesUrl(CHAT, "src/deep"), "file", fetcher);
    expect(r).toEqual({ ok: true, probe: { kind: "folder", name: "deep.tar.gz", size: 7, entries: 2 } });
  });

  test("a path that is not there, or a link that leads outside the folder, gives the 5.4 line", async () => {
    const { fetcher } = serverFetch();
    expect(await probe(filesUrl(CHAT, "src/nope.ts"), "file", fetcher)).toEqual({ ok: false, status: 404, line: FILE_GONE });
    expect(await probe(filesUrl(CHAT, "src/leak.txt"), "file", fetcher)).toEqual({ ok: false, status: 404, line: FILE_GONE });
    expect(await probe(filesUrl("zzzzzzzzzzzzzzzzzzzz", "src/a.txt"), "file", fetcher)).toEqual({ ok: false, status: 404, line: FILE_GONE });
    expect(FILE_GONE).toBe("That file is not in this chat's folder.");
  });

  test("a gone path is a normal 200 read on the wire: no failed request, so the page logs no console error", async () => {
    const { fetcher, seen } = serverFetch();
    await probe(filesUrl(CHAT, "src/nope.ts"), "file", fetcher);
    await probe(filesUrl(CHAT, "src/leak.txt"), "file", fetcher);
    await probe(uploadUrl(CHAT, "zzzzzzzzzzzzzzzz"), "upload", fetcher);
    const paths = seen.map((r) => new URL(r.url).pathname);
    expect(paths).toEqual([existsUrl(filesUrl(CHAT, "src/nope.ts")), existsUrl(filesUrl(CHAT, "src/leak.txt")), existsUrl(uploadUrl(CHAT, "zzzzzzzzzzzzzzzz"))]);
    const answers = await Promise.all(paths.map((p) => fetcher(p, { method: "GET" })));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
  });

  test("a folder over the caps is refused with its line", async () => {
    const { fetcher } = serverFetch({ entries: 1, bytes: 1024 });
    expect(await probe(filesUrl(CHAT, "src"), "file", fetcher)).toEqual({ ok: false, status: 413, line: FOLDER_TOO_LARGE });
  });

  test("an upload by its id, under its saved name; a gone upload has its own line", async () => {
    const { fetcher } = serverFetch();
    const r = await probe(uploadUrl(CHAT, UPLOAD), "upload", fetcher);
    expect(r).toEqual({ ok: true, probe: { kind: "file", name: "my notes file.txt", size: 27, entries: null } });
    expect(await probe(uploadUrl(CHAT, "zzzzzzzzzzzzzzzz"), "upload", fetcher)).toEqual({ ok: false, status: 404, line: UPLOAD_GONE });
  });

  test("the probe is a plain read: a GET of the existence route, no body and no sender header", async () => {
    const { fetcher, seen } = serverFetch();
    await probe(filesUrl(CHAT, "src/a.txt"), "file", fetcher);
    expect(seen.map((r) => [r.method, new URL(r.url).pathname, r.headers.get("x-kitespan"), r.body])).toEqual([["GET", `/api/chats/${CHAT}/exists/src/a.txt`, null, null]]);
  });

  test("Download saves only after the probe passed, and then the GET has the file's bytes", async () => {
    const { fetcher, seen } = serverFetch();
    const saved: string[] = [];
    expect((await download(filesUrl(CHAT, "src/nope.ts"), "file", fetcher, (u) => saved.push(u))).ok).toBe(false);
    expect(saved).toEqual([]);
    const ok = await download(filesUrl(CHAT, "src/a.txt"), "file", fetcher, (u) => saved.push(u));
    expect(ok.ok).toBe(true);
    expect(saved).toEqual([filesUrl(CHAT, "src/a.txt")]);
    expect(seen.map((r) => r.method)).toEqual(["GET", "GET"]);
    expect(await (await fetcher(saved[0]!, { method: "GET" })).text()).toBe("alpha\n");
  });

  test("T-26: a tool's whole output is probed first too; one the chat does not hold says its 5.4 line and saves nothing", async () => {
    const url = toolOutputPath(CHAT, "toolu_02Sub");
    expect(existsUrl(url)).toBe(`/api/chats/${CHAT}/tools/toolu_02Sub/output/exists`);
    const asked: string[] = [];
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const gone = (async (u: string) => (asked.push(u), reply({ exists: false, reason: "missing" }))) as unknown as typeof fetch;
    const saved: string[] = [];
    expect(await download(url, "output", gone, (u) => saved.push(u))).toEqual({ ok: false, status: 404, line: OUTPUT_GONE });
    expect(OUTPUT_GONE).toBe("That message is not in this chat.");
    expect(saved).toEqual([]);
    expect(asked).toEqual([existsUrl(url)]);
    const there = (async () => reply({ exists: true, kind: "file", name: "toolu_02Sub-output.txt", size: 7000 })) as unknown as typeof fetch;
    expect((await download(url, "output", there, (u) => saved.push(u))).ok).toBe(true);
    expect(saved).toEqual([url]);
  });

  test("a network failure says kitespan could not be reached", async () => {
    const r = await probe("/api/chats/x/files/a", "file", (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, status: 0, line: "kitespan could not be reached." });
  });
});

describe("download URLs and names", () => {
  test("each path segment is encoded on its own; the slashes stay", () => {
    expect(filesUrl(CHAT, "src/a b/#x?.ts")).toBe(`/api/chats/${CHAT}/files/src/a%20b/%23x%3F.ts`);
    expect(uploadUrl(CHAT, UPLOAD)).toBe(`/api/chats/${CHAT}/uploads/${UPLOAD}/file`);
  });

  test("each download route has its existence probe beside it", () => {
    expect(existsUrl(filesUrl(CHAT, "src/a b/#x?.ts"))).toBe(`/api/chats/${CHAT}/exists/src/a%20b/%23x%3F.ts`);
    expect(existsUrl(uploadUrl(CHAT, UPLOAD))).toBe(`/api/chats/${CHAT}/uploads/${UPLOAD}/exists`);
  });

  test("the name the server sends is the name the page reads, for any name", () => {
    for (const name of ["report.txt", "Résumé (final).pdf", 'a"b\\c%41.txt', "it's.tar.gz", "日本語.md"]) expect(dispositionName(contentDisposition(name))).toBe(name);
    expect(dispositionName('attachment; filename="plain.txt"')).toBe("plain.txt");
    expect(dispositionName(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The panel's views, from the store

const P: Project = { id: "kitespanxx", name: "kitespan", folder: "/work/kitespan", branch: "", picks: {} };

function chatWith(p: Partial<Chat> = {}): Chat {
  return {
    ...scripted({
      id: "demoolxxxxxxxxxxxxxx",
      projectId: P.id,
      title: "Fix the flaky upload test",
      titleSource: "first-prompt",
      state: "idle",
      updatedAt: "2026-10-31T08:00:00.000Z",
      sessionId: "",
      model: "default",
      effort: "default",
      mode: "default",
      items: [],
      pending: [],
      context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] },
      connectors: [],
      outputs: [],
    }),
    ...p,
  };
}

const conn = (name: string, status: ConnectorInfo["status"], error: string | null = null): ConnectorInfo => ({ name, status, error, tools: status === "connected" ? 3 : 0, scope: "user", hasView: false });
const upload = (id: string, name: string, size: number): Upload => ({ id, chatId: "demoolxxxxxxxxxxxxxx", name, size, type: "text/plain", path: `/tmp/kitespan-uploads-dev/u-${id}/${name}`, folder: "temp", dir: `/tmp/kitespan-uploads-dev/u-${id}`, at: "", state: "done", progress: 1 });
const url = (path: string) => parse(new URL(path, "http://127.0.0.1"));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);

function cards(chat: Chat, uploads: Upload[] = []): string {
  resetState({ projects: [P], chats: [chat], uploads: uploads.length ? { [chat.id]: uploads } : {}, ready: true });
  return renderToStaticMarkup(createElement(Cards, { chat, route: url(`/c/${chat.id}/details`) }));
}

beforeEach(() => resetState());

describe("the cards (6.7): each from real data, each shown once it holds something (M17)", () => {
  test("a fresh, sleeping or archived chat: Environment only; no Context row with a lasting ..., and no empty group", () => {
    for (const p of [{}, { serverState: "sleeping" as const }, { archived: true }]) {
      const html = cards(chatWith(p));
      expect(ids(html)).toEqual(["side-environment"]);
      expect(text(html)).not.toContain("Context");
      expect(text(html)).not.toContain(UNKNOWN);
      expect(html).not.toContain("side-links");
    }
    const html = cards(chatWith());
    expect(text(html)).not.toContain("Files Claude edits appear here");
    expect(text(html)).not.toContain("None");
  });

  test("the context read draws the row: the percent and the meter", () => {
    const html = cards(chatWith({ context: { usedPct: 57, usedTokens: 114_000, windowTokens: 200_000, parts: [{ label: "Messages", tokens: 68_500 }] } }));
    expect(ids(html)).toEqual(["side-environment", "side-context"]);
    expect(text(html)).toContain("Context 57%");
    expect(html).toContain('class="side-meter"');
  });

  test("Connectors: a problem count only, nothing while every server is connected (M18)", () => {
    expect(text(cards(chatWith({ connectorInfo: [conn("github", "connected"), conn("docs", "connected")] })))).not.toMatch(/connected|failed|sign-in/);
    const mixed = cards(chatWith({ connectorInfo: [conn("github", "connected"), conn("docs-search", "failed"), conn("tickets", "needs-auth")] }));
    expect(ids(mixed)).toContain("side-connectors");
    expect(text(mixed)).toMatch(/Connectors 1 failed\s*,\s*1 needs sign-in/);
    expect(mixed).toContain('class="side-bad"');
    expect(mixed).toContain('class="side-warn"');
    expect(ids(cards(chatWith({ connectorInfo: [] })))).not.toContain("side-connectors");
    expect(connectorProblems([conn("a", "failed"), conn("b", "failed"), conn("c", "disabled"), conn("d", "pending")])).toEqual({ failed: 2, signIn: 0 });
  });

  test("Uploads shows its count once the chat has one", () => {
    expect(text(cards(chatWith(), [upload("aaaaaaaaaaaaaaaa", "run.log", 48_213), upload("bbbbbbbbbbbbbbbb", "pasted.png", 312_480)]))).toContain("Uploads 2 files");
  });

  test("FIX-Q1: Uploads counts only the uploads the server holds; a refused or failed one keeps its own line in the list", () => {
    const chat = chatWith();
    const held = upload("aaaaaaaaaaaaaaaa", "run.log", 48_213);
    const refused: Upload = { ...upload("up-pending-1", "huge.zip", 900_000_000), path: "", dir: "", state: "failed", progress: 0, error: tooLargeLine(25) };
    const failed: Upload = { ...upload("up-pending-2", "notes.txt", 120), path: "", dir: "", state: "failed", progress: 0, error: "The upload folder is not writable." };
    const sending: Upload = { ...upload("up-pending-3", "big.log", 4_000_000), path: "", dir: "", state: "uploading", progress: 0.4 };
    // A refused file alone (the demo's, or one over the limit): no Uploads row, since the server holds nothing.
    expect(ids(cards(chat, [refused]))).not.toContain("side-uploads");
    expect(text(cards(chat, [held, refused, failed, sending]))).toContain("Uploads 1 file");
    expect(text(cards(chat, [held, refused, failed, sending]))).not.toContain("Uploads 4 files");
    // The list still shows the refused and the failed one, each with its line.
    const list = text(renderToStaticMarkup(createElement(UploadsView, { chat, route: url(`/c/${chat.id}/uploads`), place: "column" })));
    expect(list).toContain(tooLargeLine(25));
    expect(list).toContain("The upload folder is not writable.");
    // A removed one leaves the count.
    resetState({ projects: [P], chats: [chat], uploads: { [chat.id]: [held, upload("bbbbbbbbbbbbbbbb", "pasted.png", 312_480), failed] }, ready: true });
    act.removeUpload(chat.id, "bbbbbbbbbbbbbbbb");
    expect(text(renderToStaticMarkup(createElement(Cards, { chat, route: url(`/c/${chat.id}/details`) })))).toContain("Uploads 1 file");
  });

  test("Outputs: drawn once Claude edited a file, newest first, one line per file with the folder part before the name (M22)", () => {
    const html = cards(chatWith({ outputs: [{ path: "src/upload.ts", kind: "file" }, { path: "NOTES.md", kind: "doc" }] }));
    expect(ids(html)).toContain("side-outputs");
    const rows = [...html.matchAll(/<span class="side-pl[^"]*" title="([^"]+)">(.*?)<\/span><\/a>/g)].map((m) => [m[1], text(m[2]!.replace(/<wbr\/>/g, "")).trim()]);
    expect(rows).toEqual([
      ["NOTES.md", "NOTES.md"],
      ["src/upload.ts", "src/ upload.ts"],
    ]);
    expect(html).toContain('<span class="side-pl-dir"><bdi>src/</bdi></span><span class="side-pl-name">upload<wbr/>.ts</span>');
    expect(html).toContain(`href="/c/demoolxxxxxxxxxxxxxx/files/src/upload.ts"`);
  });

  test("Outputs: a file outside the chat's folder (Plan mode's plan file) is plain text with Copy path, never a files link or a Download (5.1 rule 2)", () => {
    // The reducer keeps a path outside the chat's folder absolute: Plan mode writes its plan under the user's Claude Code folder.
    const plan = "/srv/elsewhere/.claude/plans/quiet-river.md";
    const ctx = { seq: 1, replay: false, cwd: P.folder, now: 0 };
    let chat = chatWith();
    chat = applyEvent(chat, { k: "tool_call", id: "toolu_01Edit", name: "Edit", input: { file_path: `${P.folder}/src/upload.ts`, old_string: "a", new_string: "b" }, parent: null }, ctx);
    chat = applyEvent(chat, { k: "tool_call", id: "toolu_01Plan", name: "Write", input: { file_path: plan, content: "# Plan" }, parent: null }, { ...ctx, seq: 2 });
    expect(chat.outputs.map((o) => o.path)).toEqual(["src/upload.ts", plan]);
    for (const html of [cards(chat), detail("outputs", chat)]) {
      expect(html).not.toMatch(/\/files\/\/|\/files\/srv\//);
      expect(html).not.toContain("/api/");
      expect(html).not.toContain('aria-label="Download quiet-river.md"');
      expect(html).toContain('aria-label="Copy path of quiet-river.md"');
      expect(html).toContain(`title="${plan}"`);
      // A file in the folder keeps its link and its Download.
      expect(html).toContain(`href="/c/${chat.id}/files/src/upload.ts"`);
      expect(html).toContain('aria-label="Download upload.ts"');
    }
    // Copy path gives the file's own full path, never the folder joined to it.
    expect(outputPath(P.folder, plan)).toBe(plan);
    expect(outputPath(P.folder, "src/upload.ts")).toBe("/work/kitespan/src/upload.ts");
    expect(inChatFolder(plan)).toBe(false);
    expect(inChatFolder("~/notes/plan.md")).toBe(false);
    expect(inChatFolder("../other/plan.md")).toBe(false);
    expect(inChatFolder("src/upload.ts")).toBe(true);
  });

  test("a narrow row keeps the folder part readable: cut at its start (the slash before the name stays), or hidden whole", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "panels.css"), "utf8");
    const rule = (sel: string) => new RegExp(`\\n${sel.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    // The line wraps: a folder part with too little room goes whole to a second line, which shows (G-26), and a name
    // wider than the row wraps at its own punctuation first, never cut (T-31).
    expect(rule(".side-pl")).toMatch(/flex-wrap: wrap/);
    expect(rule(".side-pl")).not.toMatch(/height: 1lh/);
    expect(rule(".side-pl-name")).toMatch(/overflow-wrap: anywhere/);
    expect(rule(".side-pl-name")).not.toMatch(/text-overflow: ellipsis/);
    // The name comes first on the line; the DOM order (folder, then name) stays for reading and copying.
    expect(rule(".side-pl-name")).toMatch(/order: -1/);
    // A folder part that is cut loses its start, so "src/http/" shows as "...http/", never as "s...".
    expect(rule(".side-pl-dir")).toMatch(/direction: rtl/);
    expect(rule(".side-pl-dir")).toMatch(/text-overflow: ellipsis/);
  });

  test("the Environment card: the host and the folder as <folder> and its parent", () => {
    const html = cards(chatWith());
    expect(text(html)).toContain("kitespan /work");
  });
});

function detail(name: "environment" | "context" | "connectors" | "outputs", chat: Chat, query = ""): string {
  resetState({ projects: [P], chats: [chat], ready: true });
  return renderToStaticMarkup(createElement(Detail, { name, chat, route: url(`/c/${chat.id}/${name}${query}`) }));
}

describe("the detail views: real values or ..., and no explaining foot (M21) or milestone label (M16)", () => {
  test("Environment: the folder, the Claude Code path and version from /api/settings, the session with Copy; no empty Branch", () => {
    const bare = text(detail("environment", chatWith()));
    expect(bare).not.toContain("Branch");
    expect(bare).not.toContain("Session");
    expect(bare).toContain("Claude Code ...");
    resetState({ projects: [P], host: { claude: { ok: true, path: "/usr/local/bin/claude", realpath: "/opt/claude/2.1.400/claude", version: "2.1.400", drift: null } } as never });
    const chat = chatWith({ sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", version: "2.1.401" });
    const html = renderToStaticMarkup(createElement(Detail, { name: "environment", chat, route: url(`/c/${chat.id}/environment`) }));
    expect(text(html)).toContain("Folder / work/ kitespan");
    expect(text(html)).toContain("Version 2.1.401");
    expect(text(html)).toContain("/ opt/ claude/ 2.1.400/ claude");
    expect(ids(html)).toContain("copy-session-id");
  });

  test("the version without the CLI's own name after it: claude --version prints 2.1.312 (Claude Code)", () => {
    expect(claudeVersion("2.1.312 (Claude Code)")).toBe("2.1.312");
    expect(claudeVersion("2.1.312")).toBe("2.1.312");
    expect(claudeVersion(null)).toBeNull();
    // A company's own build (row 119) keeps its extra numbers and its own name.
    expect(claudeVersion("2.1.317.1 (Claude Code)")).toBe("2.1.317.1");
    expect(claudeVersion("2.1.317-acme.2 (Acme Claude Code)")).toBe("2.1.317-acme.2 (Acme Claude Code)");
    resetState({ projects: [P], host: { claude: { ok: true, path: "/usr/local/bin/claude", realpath: null, version: "2.1.312 (Claude Code)", drift: null } } as never });
    const chat = chatWith({ version: null });
    const t = text(renderToStaticMarkup(createElement(Detail, { name: "environment", chat, route: url(`/c/${chat.id}/environment`) })));
    expect(t).toContain("Version 2.1.312");
    expect(t).not.toContain("(Claude Code)");
  });

  test("Context: ... while a read can come; a sleeping or archived chat keeps only Compact (no lasting ...)", () => {
    const live = text(detail("context", chatWith({ serverState: "idle" })));
    expect(live).toContain(UNKNOWN);
    expect(live).not.toContain("tokens");
    for (const p of [{ serverState: "sleeping" as const }, { serverState: "idle" as const, archived: true }]) {
      const t = text(detail("context", chatWith(p)));
      expect(t).not.toContain(UNKNOWN);
      expect(t.trim()).toBe("Compact");
    }
  });

  test("Context: once read, the parts, the free space and the model's window", () => {
    expect(text(detail("context", chatWith()))).not.toContain("tokens");
    const chat = chatWith({ liveModel: "claude-opus-5-5", models: [{ value: "claude-opus-5-5", displayName: "Opus 5.5", description: "", efforts: [], supportsAutoMode: true }], context: { usedPct: 57, usedTokens: 114_000, windowTokens: 200_000, parts: [{ label: "System prompt", tokens: 6_400 }, { label: "Messages", tokens: 68_500 }] } });
    const t = text(detail("context", chat));
    expect(t).toContain("57% 114k of 200k tokens");
    expect(t).toContain("Free space 86k");
    expect(t).toContain("Opus 5.5, 200k window");
    expect(t).toContain("Compact");
    expect(t).not.toContain("for you to send");
  });

  test("Connectors: one row per server with Reconnect; a failed one says why; no foot", () => {
    const html = detail("connectors", chatWith({ connectorInfo: [conn("github", "connected"), conn("docs-search", "failed", "The server closed the connection."), conn("tickets", "needs-auth")] }));
    expect(ids(html)).toEqual(["side-connectors", "confirm-reconnect-github", "confirm-reconnect-docs-search", "confirm-reconnect-tickets"]);
    expect(text(html)).toContain("Connected, 3 tools");
    expect(text(html)).toContain("Failed The server closed the connection.");
    expect(text(html)).toContain("Needs sign-in");
    expect(text(html)).not.toContain("From your own Claude Code settings");
  });

  test("Connectors with a server value: that row is marked; before the first read no row and no 5.4 line", () => {
    const marked = detail("connectors", chatWith({ connectorInfo: [conn("docs-search", "failed")] }), "?server=docs-search");
    expect(marked).toContain('data-marked="true"');
    const unread = detail("connectors", chatWith(), "?server=docs-search");
    expect(text(unread)).toContain("...");
    expect(unread).not.toContain("link-notice");
  });

  test("Outputs: every file on one line with Copy path and Download, and no foot", () => {
    const t = text(detail("outputs", chatWith({ outputs: [{ path: "src/upload.ts", kind: "file" }] })).replace(/<wbr\/>/g, ""));
    expect(t).toContain("src/ upload.ts");
    expect(t).not.toMatch(/v0\.8|file viewer|Every file Claude edited/);
    const html = detail("outputs", chatWith({ outputs: [{ path: "src/upload.ts", kind: "file" }] }));
    expect(html).toContain('aria-label="Download upload.ts"');
    expect(html).toContain('aria-label="Copy path of upload.ts"');
  });
});

describe("one header row per view (D51, M27, M34)", () => {
  const chat = chatWith({ connectorInfo: [conn("github", "connected")] });
  const panel = (path: string, mode: "column" | "pane") => {
    resetState({ projects: [P], chats: [chat], ready: true });
    return renderToStaticMarkup(createElement(SidePanel, { chat, route: url(path), mode }));
  };

  test("the column: the cards with no head; a detail view starts with '< Connectors'", () => {
    expect(panel(`/c/${chat.id}`, "column")).not.toContain("side-back");
    const html = panel(`/c/${chat.id}/connectors`, "column");
    expect(html).toMatch(/^<div class="side-panel side-mode-column"[^>]*><a href="\/c\/demoolxxxxxxxxxxxxxx\/details" class="side-back"/);
    expect(text(html).trim().startsWith("Connectors")).toBe(true);
  });

  test("the pane: no title beside the lit pane bar button, the close button kept, the Back row in the head", () => {
    const cardsPane = panel(`/c/${chat.id}/details`, "pane");
    expect(cardsPane).not.toContain("side-pane-title");
    expect(cardsPane).toContain('aria-label="Close Details"');
    const detailPane = panel(`/c/${chat.id}/context`, "pane");
    expect(detailPane).toMatch(/<div class="side-pane-head"><a href="\/c\/demoolxxxxxxxxxxxxxx\/details" class="side-back"/);
  });
});

describe("the download page (/c/<chat>/files/<path>)", () => {
  const chat = chatWith();
  const body = (state: Parameters<typeof FileBody>[0]["state"], path = "src/upload.ts") => {
    resetState({ projects: [P], chats: [chat], ready: true });
    return renderToStaticMarkup(createElement(FileBody, { chat, path, place: "pane", state }));
  };

  test("while the probe runs: the name and ..., no Download yet and no 5.4 line", () => {
    const html = body({ phase: "probing" });
    expect(text(html)).toContain("upload.ts Size ...");
    expect(html).not.toContain("file-download-button");
    expect(html).not.toContain("link-notice");
  });

  test("a file: its size and Download; Copy path keeps the full path, with no folder line (M22) and no milestone line", () => {
    const html = body({ phase: "done", ok: true, probe: { kind: "file", name: "upload.ts", size: 4_200, entries: null } });
    expect(ids(html)).toContain("file-download-button");
    expect(text(html)).toContain("Size 4 KB");
    expect(text(html)).toContain("Copy path");
    expect(text(html)).not.toMatch(/In the folder|v0\.8|file viewer/);
  });

  test("a folder downloads as .tar.gz", () => {
    const html = body({ phase: "done", ok: true, probe: { kind: "folder", name: "src.tar.gz", size: 31_000, entries: 4 } }, "src");
    expect(text(html)).toContain("src/");
    expect(text(html)).toContain("Download as .tar.gz");
  });

  test("a gone path: the 5.4 line and no Download", () => {
    const html = body({ phase: "done", ok: false, status: 404, line: FILE_GONE });
    expect(text(html)).toContain(FILE_GONE);
    expect(html).not.toContain("file-download-button");
  });
});

describe("the uploads list (/c/<chat>/uploads, M21, M22)", () => {
  test("one line per upload with its folder part before its name, its size, Download, Copy path and Remove; the foot is Change the folder", () => {
    const chat = chatWith();
    resetState({ projects: [P], chats: [chat], uploads: { [chat.id]: [upload("aaaaaaaaaaaaaaaa", "run.log", 48_213)] }, ready: true });
    const html = renderToStaticMarkup(createElement(UploadsView, { chat, route: url(`/c/${chat.id}/uploads`), place: "column" }));
    expect(html).toContain('<span class="side-pl-dir"><bdi>/tmp/kitespan-uploads-dev/u-aaaaaaaaaaaaaaaa/</bdi></span><span class="side-pl-name">run<wbr/>.log</span>');
    expect(text(html)).toContain("48 KB");
    expect(html).toContain('aria-label="Download run.log"');
    expect(html).toContain('aria-label="Copy path of run.log"');
    expect(ids(html)).toContain("confirm-remove-upload");
    expect(text(html)).toContain("Change the folder");
    expect(text(html)).not.toMatch(/Add files|Or drop them|New uploads go to|each in its own new folder/);
    expect(text(html.replace(/<wbr\/>/g, "")).match(/run\.log/g)?.length).toBe(1); // the name shows once
  });

  test("an empty list says so in one line", () => {
    const chat = chatWith();
    resetState({ projects: [P], chats: [chat], ready: true });
    expect(text(renderToStaticMarkup(createElement(UploadsView, { chat, route: url(`/c/${chat.id}/uploads`), place: "page" })))).toContain("No uploads in this chat.");
  });
});
