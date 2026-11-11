// What Claude Code attaches from the references that the server writes (shared/protocol.ts messageRef; DESIGN.md D50).
// attachedBy is a model of how Claude Code 2.1.311 reads the @ references of a message, written from its behaviour
// (read in its code on 2026-11-02) and checked here against the reference probe of 2026-11-01, whose facts are a
// reference that counts only when the transcript has a "file" attachment and the file's text is in the request.
import { describe, expect, test } from "bun:test";
import { messageRef, withUploadRefs } from "../../shared/protocol";

/** The characters after which Claude Code also starts a reference, besides white space. */
const STARTS = "。、？！";

/**
 * The names of the files that Claude Code 2.1.311 reads for a message's text:
 * - quoted: `@"` at the start of the text or after white space or one of STARTS, then one or more characters up to
 *   the next double quote (new lines too); one that ends with " (agent)" names an agent, not a file;
 * - bare: in each run of characters that are not white space, the first `@` at the run's start or after one of
 *   STARTS, then the rest of the run less every character at its end that is not an ASCII letter, a digit or an
 *   underscore (when one or more characters are left); a rest that starts with a double quote is the quoted form's;
 * - then each name, once, is cut where Claude Code reads a line range or a heading: a name that is text with no #,
 *   then optionally `#L<n>` or `#L<n>-<m>`, then optionally # and text with no #, is the text before its first #.
 */
function attachedBy(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(new RegExp(`(?:^|[\\s${STARTS}])@"([^"]+)"`, "g"))) if (!m[1]!.endsWith(" (agent)")) names.push(m[1]!);
  for (const [run] of text.matchAll(/\S+/g)) {
    let at = run.indexOf("@");
    while (at > 0 && !STARTS.includes(run[at - 1]!)) at = run.indexOf("@", at + 1);
    if (at < 0) continue;
    let end = run.length;
    while (end > at + 1 && !/[A-Za-z0-9_]/.test(run[end - 1]!)) end--;
    if (end > at + 1 && run[at + 1] !== '"') names.push(run.slice(at + 1, end));
  }
  return [...new Set(names)].map((n) => /^([^#]+)(?:#L\d+(?:-\d+)?)?(?:#[^#]*)?$/.exec(n)?.[1] ?? n);
}

const N = "/r/notes/";
const ASK = " What is the secret word in that file?";

test("the model gives the probe's results: which of its references attached the file", () => {
  const cases: [string, string, boolean][] = [
    [`@${N}plan with space.md`, `${N}plan with space.md`, false],
    [`@"${N}plan with space.md"`, `${N}plan with space.md`, true],
    [`@${N}say"hi.md`, `${N}say"hi.md`, true],
    [`@"${N}say \\"hi\\" now.md"`, `${N}say "hi" now.md`, false],
    [`@"${N}it's here.md"`, `${N}it's here.md`, true],
    [`@"${N}say"hi.md"`, `${N}say"hi.md`, false],
  ];
  for (const [ref, file, attached] of cases) expect([ref, attachedBy(ref + ASK).includes(file)]).toEqual([ref, attached]);
  // The bare one with a space: Claude Code reads the path only up to the space.
  expect(attachedBy(`@${N}plan with space.md${ASK}`)).toEqual([`${N}plan`]);
});

// Each with what it tests: white space, a double quote, a last character that a bare reference loses, a # part.
const PATHS = [
  "/tmp/u-a/plan.md",
  "/tmp/u-a/a b.md",
  "/tmp/u-a/a\tb.md",
  "/tmp/u-a/a\nb.md",
  "/tmp/u-a/it's here.md",
  "/tmp/u-a/it's",
  '/tmp/u-a/say"hi.md',
  '/tmp/u-a/say "hi" now.md',
  '/tmp/u-a/say"hi"',
  "/tmp/u-a/notes@2",
  "/tmp/u-a/file_(1)",
  "/tmp/u-a/notes.md~",
  "/tmp/u-a/LICENSE-",
  "/tmp/u-a/report.",
  "/tmp/u-a/a.c++",
  "/tmp/u-a/café",
  "/tmp/u-a/笔记",
  "/tmp/u-a/\u{1F642}",
  "/tmp/u-a/it's'",
  "/work/app/notes/v1.0)",
  "/work/app/src/[id].tsx",
  "/tmp/u-a/C#notes.md",
  "/tmp/u-a/issue #42.md",
  "/tmp/u-a/x#L5.md",
  "/tmp/u-a/x#L5-9",
  "/tmp/u-a/a#",
  "/tmp/u-a/a#b#c.md",
  "/src/C#-tools/a.ts",
  "/src/C#-tools/a#b.md",
  '/tmp/u-a/say "#1".md',
  "/tmp/u-a/notes (agent)",
  "/tmp/u-a/notes (agent).md",
  "~/up/u-a/a b.md",
];

describe("messageRef: the @ form that Claude Code attaches, and backticks only where none is", () => {
  for (const p of PATHS) {
    test(JSON.stringify(p), () => {
      const ref = messageRef(p);
      const text = withUploadRefs("Read this", [p], "message");
      if (ref.startsWith("@")) {
        // Attached as the whole path, and nothing else is read.
        expect(attachedBy(text)).toEqual([p]);
      } else {
        // The path as text: Claude Code reads no file for it, and no @ form would have attached it.
        expect(attachedBy(text)).toEqual([]);
        for (const form of [`@${p}`, `@"${p}"`]) expect(attachedBy(`Read this ${form}`)).not.toEqual([p]);
      }
    });
  }

  test("the bare form wherever it is attached, so a plain path is sent as before", () => {
    for (const p of PATHS) if (attachedBy(`Read this @${p}`).join() === p) expect(messageRef(p)).toBe(`@${p}`);
  });

  test("several references in one message: each attached, as the probe's case of one", () => {
    const paths = PATHS.filter((p) => messageRef(p).startsWith("@"));
    const out = attachedBy(withUploadRefs("Read these", paths, "message"));
    expect(out.toSorted()).toEqual(paths.toSorted());
  });
});

describe("the limits that D50 records: the user's own words can still change what Claude Code reads", () => {
  test("an @ and a double quote in the words with no closing quote: the quoted reference after them is not attached", () => {
    const text = withUploadRefs('rename @"draft to final', [`${N}a b.md`], "message");
    expect(attachedBy(text)).toEqual(["draft to final @"]);
    // So in a path that goes as text (white space and a double quote) and holds them: the next quoted one.
    expect(attachedBy(withUploadRefs("look", [`${N}a @"b.md`, `${N}c d.md`], "message"))).toEqual(["b.md` @"]);
    // A bare reference after them is attached all the same.
    expect(attachedBy(withUploadRefs('rename @"draft to final', [`${N}ab.md`], "message"))).toEqual([`${N}ab.md`]);
  });

  test("an @ after white space inside a path with white space: a second name, relative to the chat's folder", () => {
    expect(attachedBy(withUploadRefs("look", [`${N}x @y.md`], "message"))).toEqual([`${N}x @y.md`, "y.md"]);
    // In backticks too (a path with white space and a double quote): no @ form for it, and the other name all the same.
    expect(attachedBy(withUploadRefs("look", [`${N}say "hi" @y.md`], "message"))).toEqual(["y.md"]);
  });
});
