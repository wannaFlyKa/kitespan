// A message's file references read back (shared/protocol.ts messageRef and refAt; web/chat/items/Files.tsx splitRefs;
// web/state/store.ts hasUnknownRef; DESIGN.md D50, D45, 9.3). Claude Code 2.1.311 attaches a bare `@<path>` only for
// a path with no white space whose last character is an ASCII letter, a digit or an underscore, `@"<path>"` for one
// with no double quote, and neither for a path that it cuts at a # (the reference probe of 2026-11-01, and its code;
// test/unit/claude-attach.test.ts), which the server then sends as text in backticks. Whatever
// the form, the reference the server writes reads back as the file's tile, and the bubble keeps only the user's words:
// no quote, backtick or @ of it is left. An old bare reference (iteration 2 sent every path so, one with white space
// too) still reads as its tile, and text that only looks like a reference stays text.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { messageRef, messageRefForms, withUploadRefs } from "../../shared/protocol";
import { referencedUploads, splitRefs } from "../../web/chat/items/Files";
import { bubbleText } from "../../web/chat/items/Text";
import { hasUnknownRef } from "../../web/state/store";
import type { Upload } from "../../web/state/types";
import { useScriptedState } from "./fixtures";

useScriptedState();

const CHAT = "c1";
const ROOT = "/work/app";
const DIR = "/tmp/kitespan-uploads-dev/u-aaaaaa";
const up = (id: string, path: string): Upload => ({ id, chatId: CHAT, name: path.slice(path.lastIndexOf("/") + 1), size: 9, type: "text/plain", path, folder: "temp", dir: path.slice(0, path.lastIndexOf("/")), at: "2026-11-01T00:00:00Z", state: "done", progress: 1 });

/** What a message shows: its tiles (an upload's id, or a folder file's path) and its bubble's text. */
function shown(text: string, uploads: Upload[] = [], mentions?: string[], root = ROOT) {
  const parts = splitRefs(text, uploads, { chatId: CHAT, folder: root }, mentions);
  return { tiles: referencedUploads(parts).map((f) => ("rel" in f ? f.rel : f.id)), bubble: bubbleText(parts) };
}

const NAMES: [string, string][] = [
  ["plain", "plan.md"],
  ["a space", "plan with space.md"],
  ["an apostrophe and a space", "it's here.md"],
  ["a double quote and no space", 'say"hi.md'],
  ["a double quote and a space", 'say "hi" now.md'],
  // A bare reference loses its last characters when they are not ASCII letters, digits or underscores.
  ["a last parenthesis", "file_(1)"],
  ["a last tilde", "notes.md~"],
  ["a last non-ASCII letter", "café"],
  ["a double quote at the end", 'say"hi"'],
  // Claude Code cuts a path with one # part at its #; one with two is kept whole.
  ["one #", "C#notes.md"],
  ["a # and a space", "issue #42.md"],
  ["two # parts", "a#b#c.md"],
];

describe("the round trip: the server's reference, then the tile and the clean text", () => {
  for (const [label, name] of NAMES) {
    test(`an upload, ${label}`, () => {
      const u = up("u1", `${DIR}/${name}`);
      const text = withUploadRefs("Read this", [u.path], "message");
      expect(text).toBe(`Read this ${messageRef(u.path)}`);
      expect(shown(text, [u])).toEqual({ tiles: ["u1"], bubble: "Read this" });
      expect(shown(withUploadRefs("", [u.path], "message"), [u])).toEqual({ tiles: ["u1"], bubble: "" });
      // The page knows the upload: nothing to read. Another page's upload that this one has not read: it reads them.
      expect(hasUnknownRef(text, [u])).toBe(false);
      expect(hasUnknownRef(text, [])).toBe(true);
    });

    test(`a mention, ${label}`, () => {
      const rel = `notes/${name}`;
      const text = withUploadRefs("Compare", [`${ROOT}/${rel}`], "message");
      expect(shown(text, [], [rel])).toEqual({ tiles: [rel], bubble: "Compare" });
      // The words after it stay text, and nothing of the reference is left in the bubble.
      const after = `${messageRef(`${ROOT}/${rel}`)} and the words after it`;
      expect(shown(after, [], [rel])).toEqual({ tiles: [rel], bubble: "and the words after it" });
      expect(hasUnknownRef(text, [], messageRefForms(`${ROOT}/${rel}`))).toBe(false);
    });
  }

  test("uploads, then mentions, in chip order: every form in one message", () => {
    const uploads = NAMES.map(([, name], i) => up(`u${i}`, `${DIR}/${name}`));
    const rels = NAMES.map(([, name]) => `docs/${name}`);
    const text = withUploadRefs("All of them", [...uploads.map((u) => u.path), ...rels.map((r) => `${ROOT}/${r}`)], "message");
    const out = shown(text, uploads, rels);
    expect(out).toEqual({ tiles: [...uploads.map((u) => u.id), ...rels], bubble: "All of them" });
    expect(out.bubble).not.toMatch(/["`@]/);
  });

  test("a chat folder with a space in it: its mentions are quoted, and read back", () => {
    const root = "/work/my app";
    const text = withUploadRefs("See", [`${root}/src/a.ts`], "message");
    expect(text).toBe('See @"/work/my app/src/a.ts"');
    expect(shown(text, [], ["src/a.ts"], root)).toEqual({ tiles: ["src/a.ts"], bubble: "See" });
  });

  test("a chat folder with one # in it: its mentions are text in backticks, and read back", () => {
    const root = "/src/C#-tools";
    const text = withUploadRefs("See", [`${root}/src/a.ts`], "message");
    expect(text).toBe("See `/src/C#-tools/src/a.ts`");
    expect(shown(text, [], ["src/a.ts"], root)).toEqual({ tiles: ["src/a.ts"], bubble: "See" });
    // A message with no list (from before v0.3): the server's form only, at the end.
    expect(shown(text, [], undefined, root)).toEqual({ tiles: ["src/a.ts"], bubble: "See" });
    expect(shown("See `/src/C#-tools/src/a.ts` now", [], undefined, root)).toEqual({ tiles: [], bubble: "See `/src/C#-tools/src/a.ts` now" });
  });

  test("an upload's path that holds another's: the longer known path wins, in every form", () => {
    const a = up("a", `${DIR}/notes`);
    const ab = up("ab", `${DIR}/notes v2.txt`);
    expect(shown(withUploadRefs("x", [ab.path], "message"), [a, ab])).toEqual({ tiles: ["ab"], bubble: "x" });
    expect(shown(`x @${ab.path}`, [a, ab])).toEqual({ tiles: ["ab"], bubble: "x" });
    expect(shown(`x @${a.path}`, [a, ab])).toEqual({ tiles: ["a"], bubble: "x" });
  });
});

describe("an old message: a bare @<path> with white space, as iteration 2 sent it", () => {
  test("a known upload's path: the whole path is the tile", () => {
    const u = up("u1", `${DIR}/plan with space.md`);
    expect(shown(`Read this @${u.path}`, [u])).toEqual({ tiles: ["u1"], bubble: "Read this" });
    // A path that iteration 2 sent bare and that now goes quoted or as text.
    for (const name of ["file_(1)", "café", "C#notes.md", 'say"hi"']) {
      const old = up("u2", `${DIR}/${name}`);
      expect(shown(`Read this @${old.path}`, [old])).toEqual({ tiles: ["u2"], bubble: "Read this" });
      expect(hasUnknownRef(`Read this @${old.path}`, [old])).toBe(false);
    }
    expect(shown(`Read @${u.path} and @${u.path} then stop`, [u])).toEqual({ tiles: ["u1"], bubble: "Read and then stop" });
    expect(hasUnknownRef(`Read this @${u.path}`, [u])).toBe(false);
  });

  test("a mention the message's event names: the whole path is the tile", () => {
    const rel = "notes/plan with space.md";
    expect(shown(`Compare @${ROOT}/${rel}`, [], [rel])).toEqual({ tiles: [rel], bubble: "Compare" });
    // The newer form wins where the message holds both (the server's reference is the last one).
    expect(shown(`@${ROOT}/${rel} is old, see ${messageRef(`${ROOT}/${rel}`)}`, [], [rel])).toEqual({ tiles: [rel], bubble: `@${ROOT}/${rel} is old, see` });
  });

  test("no list (from before v0.3, or the terminal): a bare path with a space stays text, a quoted one is a tile", () => {
    expect(shown(`see @${ROOT}/notes/a b.md`)).toEqual({ tiles: [], bubble: `see @${ROOT}/notes/a b.md` });
    // The quotes mark where the path ends: Claude Code's own form for such a path.
    expect(shown(`see @"${ROOT}/notes/a b.md"`)).toEqual({ tiles: ["notes/a b.md"], bubble: "see" });
    expect(shown(`see ${messageRef(`${ROOT}/notes/say "hi" now.md`)}`)).toEqual({ tiles: ['notes/say "hi" now.md'], bubble: "see" });
    // Only at the end, as before.
    expect(shown(`@"${ROOT}/notes/a b.md" fix it`)).toEqual({ tiles: [], bubble: `@"${ROOT}/notes/a b.md" fix it` });
    expect(shown(`@"${ROOT}/../etc/a b"`)).toEqual({ tiles: [], bubble: `@"${ROOT}/../etc/a b"` });
  });
});

describe("text that only looks like a reference stays text", () => {
  const u = up("u1", `${DIR}/plan with space.md`);
  const LOOKS = [
    "@alice can you look at this",
    "write to me@example.com today",
    'he said "plan with space.md" twice',
    '@"plan with space.md" is a name, not a path',
    'a quoted phrase in code: `"a b"`',
    "run `/usr/bin/env` first",
    "`/tmp/a b.md` is code",
    `mail@${u.path}`,
    `x@"${u.path}"`,
    `@"${u.path}"x`,
    `@"${u.path}`,
    `see @${u.path}.bak`,
    `see @"${u.path}.bak"`,
  ];
  for (const text of LOOKS) {
    test(JSON.stringify(text), () => {
      expect(shown(text, [u], [])).toEqual({ tiles: [], bubble: text });
      expect(shown(text, [u])).toEqual({ tiles: [], bubble: text });
    });
  }

  test("the unknown-reference check reads only an absolute path, or one under ~, in one of the three forms", () => {
    for (const text of LOOKS.slice(0, 7)) expect(hasUnknownRef(text, [])).toBe(false);
    expect(hasUnknownRef(`mail@${u.path}`, [])).toBe(false);
    // A reference to an upload this page has not read, in each form: the page reads the uploads again.
    expect(hasUnknownRef('see @"/tmp/u-9/not here.txt"', [u])).toBe(true);
    expect(hasUnknownRef("see @/tmp/u-9/gone.txt", [u])).toBe(true);
    expect(hasUnknownRef('see `/tmp/u-9/say "hi" now.md`', [u])).toBe(true);
    expect(hasUnknownRef('see @"~/up/u-9/a b.txt"', [u])).toBe(true);
  });
});

describe("an upload that the folder move took (round K1): an earlier message names its path from before the move", () => {
  const BEFORE = "/srv/home/.local/state/before/uploads/u-bbbbbb";
  const AFTER = "/srv/home/.local/state/after/uploads/u-bbbbbb";
  for (const [label, name] of NAMES) {
    test(`an upload, ${label}`, () => {
      const u: Upload = { ...up("u1", `${AFTER}/${name}`), was: `${BEFORE}/${name}` };
      // Sent before the move: the reference holds the old path; sent after it, the new one. Both are the upload's tile.
      for (const path of [u.was!, u.path]) {
        const text = withUploadRefs("Read this", [path], "message");
        expect(shown(text, [u])).toEqual({ tiles: ["u1"], bubble: "Read this" });
        expect(hasUnknownRef(text, [u])).toBe(false);
      }
      // Another upload's old path stays unknown, so the page reads the uploads again.
      expect(hasUnknownRef(withUploadRefs("x", [`${BEFORE}/other.txt`], "message"), [u])).toBe(true);
    });
  }
});

test("the page has no copy of the rule: it imports shared/'s", () => {
  const WEB = join(import.meta.dir, "..", "..", "web");
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : []));
  for (const f of files(WEB)) expect(readFileSync(f, "utf8")).not.toMatch(/function (messageRef|messageRefForms|uploadRef|shellQuote|refAt|refsIn)\b/);
  expect(readFileSync(join(WEB, "state", "store.ts"), "utf8")).toMatch(/messageRefForms/);
  expect(readFileSync(join(WEB, "chat", "items", "Files.tsx"), "utf8")).toMatch(/messageRefForms/);
});
