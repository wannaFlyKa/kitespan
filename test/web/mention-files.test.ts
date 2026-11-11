// A sent mention shows as the file's tile (web/chat/items/Files.tsx; DESIGN.md 9.3, D51 M1; BUILD-CHECKLIST C7, L10):
// the server adds each mention chip's reference (messageRef of `<chat folder>/<path>`) at the end of the text, after
// the uploads' references, and the message shows a tile for it above the bubble, which leaves the reference out, as an
// upload's tile does. The
// message's `user` event names the chips' paths, so exactly those are tiles, a path with white space in it too, and the
// rest of the text stays text. A message with no such list (from before v0.3, or from the terminal) is read as before:
// only the references at the end count, and such text anywhere else stays the user's own text. A tile downloads the
// file from the chat's folder (a read: the existence probe, then the download), and records nothing. The texts here
// hold bare references, the form the server sent before the quoted one for a path with white space (shared/protocol.ts
// messageRef), so they are old messages that must still read; test/web/refs.test.ts has the forms it writes now.
import { afterEach, describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageFiles, referencedUploads, splitRefs, type FolderFile } from "../../web/chat/items/Files";
import { ItemView } from "../../web/chat/items/ItemView";
import { bubbleText } from "../../web/chat/items/Text";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import type { Item, Upload } from "../../web/state/types";
import { useScriptedState } from "./fixtures";

useScriptedState();

const ROOT = "/work/kitespan";
const CHAT = "c1";
const folder = { chatId: CHAT, folder: ROOT };
const up = (id: string, path: string): Upload => ({ id, chatId: CHAT, name: path.slice(path.lastIndexOf("/") + 1), size: 48_213, type: "text/plain", path, folder: "temp", dir: path.slice(0, path.lastIndexOf("/")), at: "2026-11-01T00:00:00Z", state: "done", progress: 1 });
const file = (rel: string, root = ROOT): FolderFile => ({ id: `file ${rel}`, chatId: CHAT, rel, path: `${root}/${rel}` });
const refs = (text: string, uploads: Upload[] = []) => splitRefs(text, uploads, folder);

describe("splitRefs: a mention's reference at the end of the text (L10)", () => {
  test("one reference after the text, one alone, several in chip order", () => {
    expect(refs(`Read this @${ROOT}/web/composer/Composer.tsx`)).toEqual(["Read this ", { ref: `@${ROOT}/web/composer/Composer.tsx`, file: file("web/composer/Composer.tsx") }]);
    expect(refs(`@${ROOT}/a.ts`)).toEqual([{ ref: `@${ROOT}/a.ts`, file: file("a.ts") }]);
    const parts = refs(`two @${ROOT}/x/one.md @${ROOT}/two.ts`);
    expect(referencedUploads(parts)).toEqual([file("x/one.md"), file("two.ts")]);
    expect(bubbleText(parts)).toBe("two");
  });

  test("a reference ends at white space: the user's words after a path never become part of a tile", () => {
    // A message the user wrote (or one from the terminal, with a dropped file's path): the words stay in the bubble.
    expect(refs(`@${ROOT}/src/a.ts fix the bug in it`)).toEqual([`@${ROOT}/src/a.ts fix the bug in it`]);
    expect(refs(`look at @${ROOT}/a.ts then stop`)).toEqual([`look at @${ROOT}/a.ts then stop`]);
    // The user's own reference before more words is text; the chip's reference that the server added is the tile.
    const parts = refs(`compare @${ROOT}/a.md with b @${ROOT}/src/upload.ts`);
    expect(parts).toEqual([`compare @${ROOT}/a.md with b `, { ref: `@${ROOT}/src/upload.ts`, file: file("src/upload.ts") }]);
    expect(bubbleText(parts)).toBe(`compare @${ROOT}/a.md with b`);
  });

  test("a path with white space in it reads as text: the text holds no mark where such a path ends", () => {
    // Nothing tells the path "notes/a b.md" from the path "notes/a" and the word "b.md": no tile names a file that may
    // not exist, and the text stays whole.
    expect(refs(`see @${ROOT}/notes/a b.md`)).toEqual([`see @${ROOT}/notes/a b.md`]);
    const parts = refs(`two @${ROOT}/x y/one.md @${ROOT}/two.ts`);
    expect(parts).toEqual([`two @${ROOT}/x y/one.md `, { ref: `@${ROOT}/two.ts`, file: file("two.ts") }]);
    // An upload's path is known, so its reference may hold spaces (as before).
    const log = up("u1", "/tmp/kitespan-uploads-dev/u-aaaaaa/server log.txt");
    expect(referencedUploads(refs(`@${log.path}`, [log]))).toEqual([log]);
  });

  test("after the uploads' references, as the server adds them; an upload's own path wins where both could match", () => {
    const log = up("u1", "/tmp/kitespan-uploads-dev/u-aaaaaa/server log.txt");
    const parts = refs(`Look @${log.path} @${ROOT}/src/a.ts`, [log]);
    expect(parts).toEqual(["Look ", { ref: `@${log.path}`, upload: log }, " ", { ref: `@${ROOT}/src/a.ts`, file: file("src/a.ts") }]);
    expect(referencedUploads(parts).map((f) => f.id)).toEqual(["u1", "file src/a.ts"]);
    // An upload folder inside the chat's folder: the upload's reference is the upload's.
    const inside = up("u2", `${ROOT}/uploads/u-bbbbbb/pic.png`);
    expect(referencedUploads(refs(`@${inside.path}`, [inside]))).toEqual([inside]);
  });

  test("text the user wrote stays text: a path before a line of more text, inside a word, outside the folder, or unsafe", () => {
    // A path before more of the user's text on another line is not among the references at the end.
    expect(refs(`@${ROOT}/a.ts\nand more @${ROOT}/b.ts`)).toEqual([`@${ROOT}/a.ts\nand more `, { ref: `@${ROOT}/b.ts`, file: file("b.ts") }]);
    expect(referencedUploads(refs(`mail@${ROOT}/a.ts`))).toEqual([]);
    expect(referencedUploads(refs("@/work/kitespan-old/a.ts"))).toEqual([]);
    expect(referencedUploads(refs(`@${ROOT}/../etc/passwd`))).toEqual([]);
    expect(referencedUploads(refs(`@${ROOT}/a//b.ts`))).toEqual([]);
    expect(referencedUploads(refs(`@${ROOT}/`))).toEqual([]);
    expect(refs("no references here")).toEqual(["no references here"]);
    expect(refs("")).toEqual([]);
  });

  test("no folder known (another chat, the read-only preview): only the uploads", () => {
    expect(splitRefs(`Read @${ROOT}/a.ts`, [])).toEqual([`Read @${ROOT}/a.ts`]);
    expect(splitRefs(`Read @${ROOT}/a.ts`, [], { chatId: CHAT, folder: "" })).toEqual([`Read @${ROOT}/a.ts`]);
  });

  test("a folder written with a slash at its end, or under ~, as the project names it", () => {
    expect(referencedUploads(splitRefs(`@${ROOT}/a.ts`, [], { chatId: CHAT, folder: `${ROOT}/` }))).toEqual([file("a.ts")]);
    expect(referencedUploads(splitRefs("x @~/src/kitespan/a.ts", [], { chatId: CHAT, folder: "~/src/kitespan" }))).toEqual([file("a.ts", "~/src/kitespan")]);
  });
});

describe("splitRefs: the paths the message's event names (the server's list)", () => {
  const sent = (text: string, mentions: string[], uploads: Upload[] = []) => splitRefs(text, uploads, folder, mentions);
  const MEMO = "notes/会議メモ 2026.md";
  const PLAN = "assets/\u{1f680} launch plan.md";

  test("a path with white space in it is a tile, and so is the path after it on the same line", () => {
    const parts = sent(`Compare these @${ROOT}/${MEMO} @${ROOT}/${PLAN}`, [MEMO, PLAN]);
    expect(parts).toEqual(["Compare these ", { ref: `@${ROOT}/${MEMO}`, file: file(MEMO) }, " ", { ref: `@${ROOT}/${PLAN}`, file: file(PLAN) }]);
    expect(referencedUploads(parts)).toEqual([file(MEMO), file(PLAN)]);
    expect(bubbleText(parts)).toBe("Compare these");
  });

  test("the words after a path on the same line stay text: the tile is the path the list names, no more", () => {
    const parts = sent(`@${ROOT}/notes/a b.md and the words after it`, ["notes/a b.md"]);
    expect(parts).toEqual([{ ref: `@${ROOT}/notes/a b.md`, file: file("notes/a b.md") }, " and the words after it"]);
    expect(bubbleText(parts)).toBe("and the words after it");
    // The list names "notes/a": the tile is that file, and " b.md" is the user's text.
    expect(sent(`@${ROOT}/notes/a b.md`, ["notes/a"])).toEqual([{ ref: `@${ROOT}/notes/a`, file: file("notes/a") }, " b.md"]);
  });

  test("exactly those paths: one the user typed stays text, at the end too, and the server's reference is the tile", () => {
    const parts = sent(`@${ROOT}/notes/a b.md is wrong, see @${ROOT}/src/a.ts @${ROOT}/notes/a b.md`, ["notes/a b.md"]);
    expect(parts).toEqual([`@${ROOT}/notes/a b.md is wrong, see @${ROOT}/src/a.ts `, { ref: `@${ROOT}/notes/a b.md`, file: file("notes/a b.md") }]);
    expect(bubbleText(parts)).toBe(`@${ROOT}/notes/a b.md is wrong, see @${ROOT}/src/a.ts`);
    // A reference inside a word, or one that runs on into a longer path, is not the list's: that text stays as it is,
    // and the file's tile still shows (a part with no text of its own).
    expect(sent(`mail@${ROOT}/a.ts`, ["a.ts"])).toEqual([`mail@${ROOT}/a.ts`, { ref: "", file: file("a.ts") }]);
    expect(sent(`x @${ROOT}/a.ts.bak`, ["a.ts"])).toEqual([`x @${ROOT}/a.ts.bak`, { ref: "", file: file("a.ts") }]);
  });

  test("a path whose reference the text does not hold (the event's text cap cut it) still shows its tile", () => {
    const parts = sent(`${"x".repeat(20)} @${ROOT}/notes/a`, [MEMO]);
    expect(parts).toEqual([`${"x".repeat(20)} @${ROOT}/notes/a`, { ref: "", file: file(MEMO) }]);
    expect(referencedUploads(parts)).toEqual([file(MEMO)]);
    expect(bubbleText(parts)).toBe(`${"x".repeat(20)} @${ROOT}/notes/a`);
  });

  test("after the uploads' references, which keep their own rule; repeats are one tile", () => {
    const log = up("u1", "/tmp/kitespan-uploads-dev/u-aaaaaa/server log.txt");
    const parts = sent(`Look @${log.path} @${ROOT}/${MEMO}`, [MEMO], [log]);
    expect(parts).toEqual(["Look ", { ref: `@${log.path}`, upload: log }, " ", { ref: `@${ROOT}/${MEMO}`, file: file(MEMO) }]);
    expect(referencedUploads(sent(`@${ROOT}/a.ts @${ROOT}/a.ts`, ["a.ts", "a.ts"]))).toEqual([file("a.ts")]);
  });

  test("an empty list: a message sent with no chips, so a reference typed at its end is text; no folder known: the text", () => {
    expect(sent(`@${ROOT}/a.ts`, [])).toEqual([`@${ROOT}/a.ts`]);
    expect(sent(`see @${ROOT}/a.ts @${ROOT}/b.ts`, [])).toEqual([`see @${ROOT}/a.ts @${ROOT}/b.ts`]);
    // With no list at all (an old message), the guess of before stays.
    expect(splitRefs(`@${ROOT}/a.ts`, [], folder)).toEqual([{ ref: `@${ROOT}/a.ts`, file: file("a.ts") }]);
    // An upload's reference keeps its own rule: the list names the chips' files only.
    const log = up("u1", "/tmp/kitespan-uploads-dev/u-aaaaaa/server log.txt");
    expect(sent(`Look @${log.path}`, [], [log])).toEqual(["Look ", { ref: `@${log.path}`, upload: log }]);
    expect(splitRefs(`Read @${ROOT}/${MEMO}`, [], undefined, [MEMO])).toEqual([`Read @${ROOT}/${MEMO}`]);
  });
});

describe("the tile (D51 M1)", () => {
  const g = globalThis as Record<string, unknown>;
  const noop = () => {};
  afterEach(() => {
    delete g.document;
    delete g.window;
    delete g.matchMedia;
    g.fetch = realFetch;
  });
  const realFetch = g.fetch;
  const ctx = (chatId: string): Transcript => ({ chatId, view: "verbose", readOnly: false, isOpen: () => false, toggle: () => {} });
  const inChat = (item: Item, chatId: string) => renderToStaticMarkup(createElement(TranscriptProvider, { value: ctx(chatId) }, createElement(ItemView, { item, chatId })));

  test("a message with a mention's reference shows the file's tile above the bubble, and the bubble leaves it out", () => {
    g.window = { innerWidth: 1280, innerHeight: 800, addEventListener: noop, removeEventListener: noop };
    g.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
    // demoolxxxxxxxxxxxxxx is in the scripted kitespan project, whose folder is ~/src/kitespan.
    const out = inChat({ kind: "user", id: "m1", text: "Read this @~/src/kitespan/web/composer/Composer.tsx" }, "demoolxxxxxxxxxxxxxx");
    expect(out).toContain('data-testid="download-mention"');
    expect(out).toContain('data-path="web/composer/Composer.tsx"');
    expect(out).toContain('aria-label="Download Composer.tsx, in web/composer"');
    expect(out).toContain('title="~/src/kitespan/web/composer/Composer.tsx"');
    expect(out).toContain(">Composer.tsx<");
    expect(out.indexOf("chat-files")).toBeLessThan(out.indexOf("chat-bubble"));
    expect(out).toMatch(/<div class="chat-bubble"[^>]*>Read this<\/div>/);
    // Only the tile: no bubble.
    const only = inChat({ kind: "user", id: "m2", text: "@~/src/kitespan/README.md" }, "demoolxxxxxxxxxxxxxx");
    expect(only).toContain('aria-label="Download README.md"');
    expect(only).not.toContain("chat-bubble");
    // A chat whose folder is not known shows the text as it is.
    expect(inChat({ kind: "user", id: "m3", text: "Read @~/src/kitespan/README.md" }, "nosuchxxxxxxxxxxxxxx")).toContain("Read @~/src/kitespan/README.md");
  });

  test("a message whose event names a path with a space shows its tile, and the words after it stay in the bubble", () => {
    g.window = { innerWidth: 1280, innerHeight: 800, addEventListener: noop, removeEventListener: noop };
    g.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
    const memo = "notes/会議メモ 2026.md";
    const plan = "assets/\u{1f680} launch plan.md";
    const two = inChat({ kind: "user", id: "m4", text: `Compare these @~/src/kitespan/${memo} @~/src/kitespan/${plan}`, mentions: [memo, plan] }, "demoolxxxxxxxxxxxxxx");
    expect([...two.matchAll(/data-testid="download-mention" data-path="([^"]*)"/g)].map((m) => m[1])).toEqual([memo, plan]);
    expect(two).toContain('aria-label="Download 会議メモ 2026.md, in notes"');
    expect(two).toContain(`title="~/src/kitespan/${memo}"`);
    expect(two).toMatch(/<div class="chat-bubble"[^>]*>Compare these<\/div>/);
    const after = inChat({ kind: "user", id: "m5", text: `@~/src/kitespan/${memo} is the one to read first`, mentions: [memo] }, "demoolxxxxxxxxxxxxxx");
    expect([...after.matchAll(/data-testid="download-mention" data-path="([^"]*)"/g)].map((m) => m[1])).toEqual([memo]);
    expect(after).toMatch(/<div class="chat-bubble"[^>]*>is the one to read first<\/div>/);
    // The same text with no list (a message from before v0.3): as before, the path with a space stays text.
    const old = inChat({ kind: "user", id: "m6", text: `Compare these @~/src/kitespan/${memo}` }, "demoolxxxxxxxxxxxxxx");
    expect(old).not.toContain('data-testid="download-mention"');
    expect(old).toContain(`Compare these @~/src/kitespan/${memo}`);
  });

  test("the tile downloads the file from the chat's folder: the probe, then the download; nothing is recorded", async () => {
    const saved: string[] = [];
    const asked: string[] = [];
    const anchor = { style: {}, href: "", download: "", rel: "", click() { saved.push(this.href); }, remove() {} };
    g.document = { createElement: () => anchor, body: { appendChild() {} } };
    g.window = { __kitespanFrames: [] };
    g.fetch = (async (url: string, init: RequestInit) => {
      asked.push(`${init.method} ${url}`);
      return Response.json({ exists: true, kind: "file", name: "a b.md", size: 12 });
    }) as unknown as typeof fetch;
    const tiles = MessageFiles({ uploads: [file("notes/a b.md")] }) as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    tiles.props.children[0]!.props.onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual(["GET /api/chats/c1/exists/notes/a%20b.md"]);
    expect(saved).toEqual(["/api/chats/c1/files/notes/a%20b.md"]);
    expect((g.window as { __kitespanFrames: unknown[] }).__kitespanFrames).toEqual([]);
  });
});
