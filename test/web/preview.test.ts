// A picture's preview (web/ui/preview.tsx): which files get one (PNG, JPEG, GIF and WebP under the size cap; never an
// SVG or a text file), where its bytes come from (this page's own file, else the download route after its existence
// probe), the blob URL's life (made once the box is near the viewport, revoked when the box unmounts or the bytes do
// not draw), and the tiles and chips themselves, mounted by React's own client renderer over a stand-in document in a
// process of its own (preview-probe.tsx): the thumbnail and its reserved box, the fallback to today's tile, the
// viewer's open and close with the focus back on the thumbnail, and Download.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProbeResult } from "../../web/panels/download";
import type { Upload } from "../../web/state/types";
import { PREVIEW_MAX_BYTES, PreviewLoad, previewType, previewTypeOfName, readPreview, uploadPreview, type PreviewEnv, type PreviewShot, type PreviewSource } from "../../web/ui/preview";

const ROOT = join(import.meta.dir, "..", "..");
const up = (over: Partial<Upload> = {}): Upload => ({ id: "u1", chatId: "c1", name: "shot.png", size: 48_213, type: "image/png", path: "/tmp/kitespan-uploads-dev/u-aaaaaa/shot.png", folder: "temp", dir: "/tmp/kitespan-uploads-dev/u-aaaaaa", at: "2026-10-30T00:00:00Z", state: "done", progress: 1, ...over });

describe("which files get a preview", () => {
  test("the four image types that draw, and no other: not an SVG, not a text file", () => {
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp"]) expect(previewType(t)).toBe(t);
    expect(previewType("IMAGE/PNG")).toBe("image/png");
    for (const t of ["image/svg+xml", "text/plain", "image/avif", "image/bmp", "image/heic", "application/octet-stream", "image/", ""]) expect([t, previewType(t)]).toEqual([t, null]);
  });

  test("a file of the chat's folder goes by its name's ending", () => {
    expect(["a.png", "b.JPG", "c.jpeg", "d.gif", "docs/e.webp"].map(previewTypeOfName)).toEqual(["image/png", "image/jpeg", "image/jpeg", "image/gif", "image/webp"]);
    expect(["logo.svg", "notes.txt", "png", "shot.png.bak", "x.avif", ""].map(previewTypeOfName)).toEqual([null, null, null, null, null, null]);
  });

  test("an upload: its route once it is done, and none over the cap, failed, on its way from another page, or with no chat", () => {
    expect(uploadPreview(up())).toEqual({ url: "/api/chats/c1/uploads/u1/file", what: "upload", type: "image/png" });
    expect(PREVIEW_MAX_BYTES).toBe(10_000_000);
    expect(uploadPreview(up({ size: PREVIEW_MAX_BYTES }))).not.toBeNull();
    expect(uploadPreview(up({ size: PREVIEW_MAX_BYTES + 1 }))).toBeNull();
    expect(uploadPreview(up({ state: "failed" }))).toBeNull();
    expect(uploadPreview(up({ state: "uploading" }))).toBeNull();
    expect(uploadPreview(up({ chatId: "" }))).toBeNull();
    expect(uploadPreview(up({ type: "image/svg+xml", name: "logo.svg" }))).toBeNull();
    expect(uploadPreview(up({ type: "text/plain", name: "notes.txt" }))).toBeNull();
  });
});

/** The page's parts that a load uses, as stand-ins that record what was asked, made and revoked. */
function fakeEnv(opts: { probe?: ProbeResult; status?: number; throws?: boolean } = {}) {
  const asked: string[] = [];
  const made: Blob[] = [];
  const revoked: string[] = [];
  const env: PreviewEnv = {
    probe: async (url, what) => {
      asked.push(`probe ${what} ${url}`);
      return opts.probe ?? { ok: true, probe: { kind: "file", name: "shot.png", size: 4, entries: null } };
    },
    fetch: async (url) => {
      asked.push(`GET ${url}`);
      if (opts.throws) throw new TypeError("Failed to fetch");
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: opts.status ?? 200, headers: { "content-type": "application/octet-stream" } });
    },
    make: (blob) => `blob:test/${made.push(blob)}`,
    revoke: (url) => void revoked.push(url),
  };
  return { env, asked, made, revoked };
}
const ROUTE: PreviewSource = { url: "/api/chats/c1/uploads/u1/file", what: "upload", type: "image/png" };

describe("reading the picture", () => {
  test("the route: the existence probe, then the bytes, as a blob of the upload's own image type", async () => {
    const page = fakeEnv();
    const blob = await readPreview(ROUTE, page.env);
    expect(page.asked).toEqual(["probe upload /api/chats/c1/uploads/u1/file", "GET /api/chats/c1/uploads/u1/file"]);
    expect([blob?.type, blob?.size]).toEqual(["image/png", 4]);
  });

  test("a file that is gone, a folder and a file over the cap are not read at all", async () => {
    const probes: ProbeResult[] = [
      { ok: false, status: 404, line: "That upload is gone." },
      { ok: true, probe: { kind: "folder", name: "x.tar.gz", size: 4, entries: 1 } },
      { ok: true, probe: { kind: "file", name: "huge.png", size: PREVIEW_MAX_BYTES + 1, entries: null } },
    ];
    for (const probe of probes) {
      const page = fakeEnv({ probe });
      expect(await readPreview(ROUTE, page.env)).toBeNull();
      expect(page.asked).toEqual(["probe upload /api/chats/c1/uploads/u1/file"]);
    }
  });

  test("a read that is refused or does not reach the server gives no picture", async () => {
    expect(await readPreview(ROUTE, fakeEnv({ status: 404 }).env)).toBeNull();
    expect(await readPreview(ROUTE, fakeEnv({ throws: true }).env)).toBeNull();
  });

  test("this page's own file: no request, and the blob has the upload's type; a file over the cap gives none", async () => {
    const page = fakeEnv();
    const blob = await readPreview({ file: new Blob([new Uint8Array(6)]), type: "image/jpeg" }, page.env);
    expect(page.asked).toEqual([]);
    expect([blob?.type, blob?.size]).toEqual(["image/jpeg", 6]);
    expect(await readPreview({ file: new Blob([new Uint8Array(PREVIEW_MAX_BYTES + 1)]), type: "image/png" }, page.env)).toBeNull();
  });
});

describe("one box's load", () => {
  test("near the viewport it reads once and shows the URL; the unmount revokes it", async () => {
    const page = fakeEnv();
    const shown: PreviewShot[] = [];
    const load = new PreviewLoad(ROUTE, (s) => shown.push(s), page.env);
    expect(page.asked).toEqual([]);
    await Promise.all([load.near(), load.near()]);
    await load.near();
    expect(page.asked.length).toBe(2);
    expect(shown).toEqual([{ url: "blob:test/1", failed: false }]);
    expect(page.revoked).toEqual([]);
    load.end();
    expect(page.revoked).toEqual(["blob:test/1"]);
    load.end();
    expect(page.revoked).toEqual(["blob:test/1"]);
  });

  test("a failed load shows the fallback and makes no URL", async () => {
    const page = fakeEnv({ probe: { ok: false, status: 404, line: "That upload is gone." } });
    const shown: PreviewShot[] = [];
    const load = new PreviewLoad(ROUTE, (s) => shown.push(s), page.env);
    await load.near();
    expect(shown).toEqual([{ url: null, failed: true }]);
    expect(page.made).toEqual([]);
  });

  test("bytes that do not draw: the URL is revoked and the fallback shows", async () => {
    const page = fakeEnv();
    const shown: PreviewShot[] = [];
    const load = new PreviewLoad(ROUTE, (s) => shown.push(s), page.env);
    await load.near();
    load.fail();
    expect(shown).toEqual([{ url: "blob:test/1", failed: false }, { url: null, failed: true }]);
    expect(page.revoked).toEqual(["blob:test/1"]);
  });

  test("a read that ends after the unmount makes no URL and shows nothing", async () => {
    const page = fakeEnv();
    const shown: PreviewShot[] = [];
    const load = new PreviewLoad(ROUTE, (s) => shown.push(s), page.env);
    const reading = load.near();
    load.end();
    await reading;
    expect([shown, page.made, page.revoked]).toEqual([[], [], []]);
  });
});

describe("the tiles and the chips, mounted (preview-probe.tsx)", () => {
  let r: Record<string, any>;
  beforeAll(async () => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "preview-probe.tsx")], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? "/", TMPDIR: process.env.TMPDIR ?? "/tmp" } });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`the probe failed (exit ${code}): ${err.slice(-2000)}`);
    r = JSON.parse(out.trim().split("\n").at(-1)!);
  }, 60_000);

  const IMAGES = ["upng", "ujpeg", "ugif", "uwebp"];

  test("before a tile is near the viewport its box stands, and nothing is read", () => {
    // The file that is gone has its box too: the page learns that it is gone only when it reads it.
    expect(r.boxes).toEqual([...IMAGES.map((id) => [id, true]), ["usvg", false], ["utext", false], ["ubig", false], ["ugone", true], ["file docs/map.png", true], ["file docs/plan.md", false]]);
    expect(r.tiles).toEqual(Array(10).fill(true));
    expect(r.askedBeforeNear).toEqual([]);
    expect(r.imagesBeforeNear).toBe(0);
    expect(r.watched).toBe(6);
    expect(r.margins).toEqual({ rootMargin: "300px", scrollMargin: "300px" });
  });

  test("near the viewport: a thumbnail for each image type, with the file's name as its alt text, and none for an SVG, a text file or a file over the cap", () => {
    const thumb = (id: string, name: string, n: number) => [id, { tag: "button", id: `preview-${id}`, label: `View ${name}`, src: `blob:test/${n}`, alt: name, width: "160", height: "120" }];
    expect(r.thumbs).toEqual([
      thumb("upng", "shot.png", 1),
      thumb("ujpeg", "photo.jpg", 2),
      thumb("ugif", "loop.gif", 3),
      thumb("uwebp", "page.webp", 4),
      ["usvg", null],
      ["utext", null],
      ["ubig", null],
      ["ugone", null],
      ["file docs/map.png", { tag: "button", id: "preview-mention", label: "View map.png", src: "blob:test/5", alt: "map.png", width: "160", height: "120" }],
      ["file docs/plan.md", null],
    ]);
    // Each blob has the file's own image type, not the route's application/octet-stream.
    expect(r.made.map((m: { type: string }) => m.type)).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp", "image/png"]);
    // Only this origin's own routes, each after its probe; nothing for the SVG, the text file or the large file.
    expect(r.asked).toEqual([
      ...[...IMAGES, "ugone"].map((id) => `GET /api/chats/c1/uploads/${id}/exists`),
      "GET /api/chats/c1/exists/docs/map.png",
      ...IMAGES.map((id) => `GET /api/chats/c1/uploads/${id}/file`),
      "GET /api/chats/c1/files/docs/map.png",
    ]);
    expect(r.watchedAfter).toBe(0);
  });

  test("a file that is gone falls back to today's tile: no thumbnail, no box", () => {
    expect(r.gone).toEqual({ box: false, tile: true, label: "Download old.png, 48 KB" });
  });

  test("a press on the thumbnail opens the viewer with the name and Download; Esc and Close close it, and the focus is the thumbnail's again", () => {
    expect(r.opened).toEqual({ role: "dialog", modal: "true", name: "shot.png", src: "blob:test/1", alt: "shot.png", download: true, focus: "picture-close" });
    expect(r.afterEsc).toEqual({ viewer: null, focus: "preview-upng" });
    expect(r.openedAgain).toBe(true);
    expect(r.afterClose).toEqual({ viewer: null, focus: "preview-upng" });
  });

  test("Download still downloads: the viewer's, and the tile's own press under its test id", () => {
    const press = { asked: ["GET /api/chats/c1/uploads/upng/exists"], saved: ["/api/chats/c1/uploads/upng/file"] };
    expect(r.viewerDownload).toEqual(press);
    expect(r.tileDownload).toEqual(press);
  });

  test("bytes that do not draw: the thumbnail and its box go, its URL is revoked, and the tile stays", () => {
    expect(r.bad).toEqual({ thumb: false, box: false, tile: true, revoked: true });
  });

  test("the tiles unmount: every blob URL is revoked", () => {
    expect(r.unmounted.left).toBe(0);
    expect(r.unmounted.made.length).toBe(5);
    expect(r.unmounted.revoked).toEqual(r.unmounted.made);
  });

  test("the composer's chip: this page's own file draws with no request, while it uploads and once it is done; another page's upload reads its route; an SVG keeps its icon", () => {
    expect(r.chipsUploading.mine).toEqual({ state: "uploading", icon: false, img: { src: "blob:test/1", alt: "paste.png", in: "attach-icon" } });
    expect(r.chipsUploading.other).toEqual({ state: "done", icon: false, img: { src: "blob:test/2", alt: "theirs.webp", in: "attach-icon" } });
    expect(r.chipsUploading.svg).toEqual({ state: "done", icon: true, img: null });
    expect(r.chipsUploading.asked).toEqual(["GET /api/chats/c1/uploads/uother/exists", "GET /api/chats/c1/uploads/uother/file"]);
    expect(r.chipsUploading.made).toEqual(["image/png", "image/webp"]);
    // The done upload has the server's id: the file is held under it, and its new chip asks for nothing.
    expect(r.chipsDone).toEqual({ id: "umine", mine: { state: "done", icon: false, img: { src: "blob:test/3", alt: "paste.png", in: "attach-icon" } }, asked: [], held: [false, true] });
    expect(r.heldAfterRemove).toBe(false);
    expect(r.chipsUnmounted.revoked).toEqual(r.chipsUnmounted.made);
    expect(r.chipsUnmounted.made.length).toBe(4);
  });

  test("the new-chat form's chip draws this page's own file too, with no request", () => {
    expect(r.formChip).toEqual({ mine: { state: "done", icon: false, img: { src: "blob:test/4", alt: "paste.png", in: "attach-icon" } }, asked: [] });
  });

  test("an upload that fails: the page holds its file no more", () => {
    expect(r.failed).toEqual({ state: "failed", held: [true, false] });
  });

  test("the page holds its newest 20 image files, and no file of another kind", () => {
    // 21 pictures, then a text file: the oldest picture and the text file are not held.
    expect(r.heldOfMany).toEqual([false, ...Array(20).fill(true), false]);
  });
});

describe("the styles", () => {
  const rule = (file: string, selector: string) => {
    const css = readFileSync(join(ROOT, "web", "styles", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const m = new RegExp(`(?:^|})\\s*${selector.replace(/[.[\]]/g, "\\$&")} \\{([^}]*)\\}`).exec(css);
    if (!m) throw new Error(`no rule for ${selector} in ${file}`);
    return m[1]!;
  };

  test("the thumbnail's box has its size with or without the picture (the transcript does not move), and the picture fills it", () => {
    const box = rule("chat.css", ".chat-shot-thumb");
    expect(box).toMatch(/\bwidth: 160px;/);
    expect(box).toMatch(/\bheight: 120px;/);
    expect(box).toMatch(/\bflex: none;/);
    expect(rule("chat.css", ".chat-shot-thumb img")).toMatch(/width: 100%;\s*height: 100%;\s*object-fit: cover;/);
  });

  test("a tile beside a picture keeps its own height: the row does not stretch it", () => {
    expect(rule("chat.css", ".chat-files")).toMatch(/\balign-items: flex-end;/);
  });

  test("the chip's picture fills the icon's box, so the chip keeps its size", () => {
    expect(rule("base.css", ".attach-shot")).toMatch(/width: 100%;\s*height: 100%;/);
  });
});
