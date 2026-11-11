// DESIGN-T1 2.1: the items of the row menus. toolMenu for each tool kind, and for a result the server cut (T-26);
// fileMenu inside and outside the chat's folder, and a link row's laptop items; the upload menu.
import { describe, expect, test } from "bun:test";
import { cutLine, toolMenu, type MenuTool } from "../../web/chat/items/toolMenu";
import { fileMenu, uploadMenu, type RowMenuSpec } from "../../web/ui/fileMenu";
import type { Upload } from "../../web/state/types";

const CHAT = "demoolxxxxxxxxxxxxxx";
const FOLDER = "/work/kitespan";
const at = { chatId: CHAT, folder: FOLDER, open: (rel: string) => `/c/${CHAT}/files/${rel}` };
const labels = (m: RowMenuSpec | null) => m?.groups.map((g) => g.map((i) => i.label)) ?? null;
const item = (m: RowMenuSpec | null, id: string) => m?.groups.flat().find((i) => i.id === id);
const tool = (t: Partial<MenuTool> & { name: string }): MenuTool => ({ kind: "tool", id: "toolu_01", summary: "", status: "ok", ...t });

describe("toolMenu", () => {
  test("a file tool row: the file menu, its full path first", () => {
    const m = toolMenu(tool({ name: "Edit", summary: "src/upload.ts", diff: { path: "src/upload.ts", removed: [], added: [] } }), at);
    expect(m?.kind).toBe("file");
    expect(m?.title).toBe("upload.ts");
    expect(m?.head).toBe("/work/kitespan/src/upload.ts");
    expect(labels(m)).toEqual([["Open file", "Download"], ["Attach as context"], ["Copy path", "Copy relative path"]]);
    expect(item(m, "open")?.act).toEqual({ do: "go", to: `/c/${CHAT}/files/src/upload.ts` });
    expect(item(m, "download")?.act).toEqual({ do: "save", url: `/api/chats/${CHAT}/files/src/upload.ts`, what: "file" });
    expect(item(m, "attach")?.act).toEqual({ do: "attach", chat: CHAT, rel: "src/upload.ts" });
    expect(item(m, "copy-path")?.act).toEqual({ do: "copy", text: "/work/kitespan/src/upload.ts" });
    expect(item(m, "copy-rel")?.act).toEqual({ do: "copy", text: "src/upload.ts" });
    // A tool row is no link, so it never has the laptop's link items; a read-only transcript has no draft to attach to.
    expect(labels(toolMenu(tool({ name: "Read", summary: "src/upload.ts" }), { ...at, attach: false }))).toEqual([["Open file", "Download"], ["Copy path", "Copy relative path"]]);
  });

  test("a file tool call that did not work keeps only its copy rows", () => {
    expect(labels(toolMenu(tool({ name: "Write", summary: "src/new.ts", status: "denied" }), at))).toEqual([["Copy path"]]);
    expect(labels(toolMenu(tool({ name: "Read", summary: "src/a.ts", status: "running" }), at))).toEqual([["Copy path"]]);
  });

  test("Bash: Copy command, then Copy output once there is output", () => {
    expect(labels(toolMenu(tool({ name: "Bash", summary: "bun test", input: "bun test", status: "running" }), at))).toEqual([["Copy command"]]);
    const m = toolMenu(tool({ name: "Bash", summary: "bun test", input: "bun test", output: "2 pass\n0 fail" }), at);
    expect(m).toMatchObject({ kind: "bash", title: "Bash", head: "bun test" });
    expect(labels(m)).toEqual([["Copy command", "Copy output"]]);
    expect(item(m, "copy-command")?.act).toEqual({ do: "copy", text: "bun test" });
    expect(item(m, "copy-output")?.act).toEqual({ do: "copy", text: "2 pass\n0 fail" });
    expect(m?.note).toBeUndefined();
  });

  test("a result the server cut: the first lines say so, the copy says how much, and Download output gets the whole", () => {
    const held = "x".repeat(6000);
    const m = toolMenu(tool({ name: "Bash", summary: "git log -p", input: "git log -p", output: held, cut: 7000 }), at);
    expect(m?.note).toBe("Output cut at 6,000 of 7,000 characters.");
    expect(labels(m)).toEqual([["Copy command", "Copy first 6,000 characters", "Download output"]]);
    expect(item(m, "copy-output")?.act).toEqual({ do: "copy", text: held });
    expect(item(m, "download-output")?.act).toEqual({ do: "save", url: `/api/chats/${CHAT}/tools/toolu_01/output`, what: "output" });
    expect(cutLine(6000, 48213)).toBe("Output cut at 6,000 of 48,213 characters.");
    // A cut that is not longer than what the page holds says nothing.
    expect(labels(toolMenu(tool({ name: "Grep", summary: "upload", output: "a\nb", cut: 3 }), at))).toEqual([["Copy pattern", "Copy output"]]);
  });

  test("Grep and Glob, WebFetch, WebSearch, an MCP tool", () => {
    expect(toolMenu(tool({ name: "Grep", summary: "uploadFile", output: "src/a.ts" }), at)).toMatchObject({ kind: "grep", title: "Search", head: "uploadFile" });
    expect(labels(toolMenu(tool({ name: "Glob", summary: "**/*.ts" }), at))).toEqual([["Copy pattern"]]);
    const fetch = toolMenu(tool({ name: "WebFetch", summary: "https://example.com/doc", output: "# Doc" }), at);
    expect(fetch).toMatchObject({ kind: "fetch", title: "Fetch", head: "https://example.com/doc" });
    expect(labels(fetch)).toEqual([["Open link", "Copy link", "Copy output"]]);
    expect(item(fetch, "open-link")?.act).toEqual({ do: "tab", to: "https://example.com/doc" });
    // A link that is not http(s) is never opened.
    expect(labels(toolMenu(tool({ name: "WebFetch", summary: "javascript:alert(1)" }), at))).toEqual([["Copy link"]]);
    expect(toolMenu(tool({ name: "WebSearch", summary: "bun test retries" }), at)).toMatchObject({ kind: "websearch", title: "Web search", head: "bun test retries", groups: [[{ label: "Copy query" }]] });
    const mcp = toolMenu(tool({ name: "mcp__docs__search", summary: "q", output: "found" }), at);
    expect(mcp).toMatchObject({ kind: "mcp", title: "search", head: "docs" });
    expect(labels(mcp)).toEqual([["Copy output"]]);
    expect(toolMenu(tool({ name: "mcp__docs__search", summary: "q" }), at)).toBeNull();
  });

  test("rows with nothing but their tap have no menu", () => {
    expect(toolMenu(tool({ name: "ToolSearch", summary: "select:Read", output: "Read" }), at)).toBeNull();
    expect(toolMenu(tool({ name: "AskUserQuestion", summary: "Which?" }), at)).toBeNull();
    expect(toolMenu(tool({ name: "Bash", summary: "" }), at)).toBeNull();
  });
});

describe("fileMenu", () => {
  test("an Outputs file in the folder: Open, Download, Attach as context, Copy path, Copy relative path", () => {
    const m = fileMenu({ ...at, place: "outputs", path: "docs/UPLOAD-RETRIES.md" });
    expect(m.title).toBe("UPLOAD-RETRIES.md");
    expect(m.head).toBe("/work/kitespan/docs/UPLOAD-RETRIES.md");
    expect(labels(m)).toEqual([["Open", "Download"], ["Attach as context"], ["Copy path", "Copy relative path"]]);
    expect(item(m, "copy-rel")?.act).toEqual({ do: "copy", text: "docs/UPLOAD-RETRIES.md" });
  });

  test("a path outside the folder (a plan file): Copy path only, no Open, Download or Attach", () => {
    for (const path of ["/srv/elsewhere/.claude/plans/quiet-river.md", "~/notes/plan.md", "../other/plan.md"]) {
      const m = fileMenu({ ...at, place: "outputs", path, laptop: true, origin: "http://127.0.0.1:7945" });
      expect(labels(m)).toEqual([["Copy path"]]);
      expect(JSON.stringify(m)).not.toContain("/api/");
      expect(JSON.stringify(m)).not.toContain("/files/");
    }
    // An absolute path inside the folder is in it.
    expect(labels(fileMenu({ ...at, place: "outputs", path: "/work/kitespan/src/a.ts" }))?.[0]).toEqual(["Open", "Download"]);
    expect(labels(fileMenu({ ...at, place: "outputs", path: "/work/kitespan-old/a.ts" }))).toEqual([["Copy path"]]);
  });

  test("a link row on a laptop adds Open in new tab and Copy link; a tile and a tool row do not", () => {
    const origin = "http://127.0.0.1:7945";
    const m = fileMenu({ ...at, place: "outputs", path: "src/a.ts", laptop: true, origin });
    expect(labels(m)?.at(-1)).toEqual(["Open in new tab", "Copy link"]);
    expect(item(m, "tab")?.act).toEqual({ do: "tab", to: `/c/${CHAT}/files/src/a.ts` });
    expect(item(m, "copy-link")?.act).toEqual({ do: "copy", text: `${origin}/c/${CHAT}/files/src/a.ts` });
    const diff = `/c/${CHAT}/changes/t1/src/a.ts`;
    const changes = fileMenu({ ...at, place: "changes", path: "src/a.ts", laptop: true, origin, link: diff });
    expect(labels(changes)).toEqual([["Open file"], ["Attach as context"], ["Copy path"], ["Open in new tab", "Copy link"]]);
    // Open file opens the file; the link items are the row's own link, its diff.
    expect(item(changes, "open")?.act).toEqual({ do: "go", to: `/c/${CHAT}/files/src/a.ts` });
    expect(item(changes, "tab")?.act).toEqual({ do: "tab", to: diff });
    expect(item(changes, "copy-link")?.act).toEqual({ do: "copy", text: `${origin}${diff}` });
    expect(labels(fileMenu({ ...at, place: "hit", path: "src/a.ts", laptop: true, origin }))).toEqual([["Attach as context"], ["Copy path"], ["Open in new tab", "Copy link"]]);
    expect(labels(fileMenu({ ...at, place: "hit", path: "src/a.ts" }))).toEqual([["Attach as context"], ["Copy path"]]);
    expect(labels(fileMenu({ ...at, place: "tile", path: "notes/memo.md", laptop: true, origin }))).toEqual([["Download"], ["Copy path"]]);
  });
});

describe("uploadMenu", () => {
  const up: Upload = { id: "aaaaaaaaaaaaaaaa", chatId: CHAT, name: "pasted.png", size: 124, type: "image/png", state: "done", progress: 1, path: "/tmp/kitespan-uploads-dev/u-1/pasted.png" } as Upload;
  test("Download, Copy path and, in the Files list, Remove", () => {
    const m = uploadMenu(up, true);
    expect(m).toMatchObject({ kind: "upload", title: "pasted.png", head: up.path });
    expect(labels(m)).toEqual([["Download", "Copy path"], ["Remove"]]);
    expect(item(m, "remove")).toMatchObject({ act: { do: "run" }, danger: true });
    expect(item(m, "download")?.act).toEqual({ do: "save", url: `/api/chats/${CHAT}/uploads/aaaaaaaaaaaaaaaa/file`, what: "upload" });
    expect(labels(uploadMenu(up, false))).toEqual([["Download", "Copy path"]]);
    expect(labels(uploadMenu({ ...up, state: "uploading", path: "" }, true))).toEqual([["Remove"]]);
  });
});
