// U1 (DESIGN-U1 3 and 9): git's two outputs that the changes code reads, parsed with no git: the summary's raw and
// numstat records (with -z) and one file's unified diff (hunks, both line numbers, a rename's header, "No newline at
// end of file", a binary file, the line and character caps), and an ls-tree size.
import { describe, expect, test } from "bun:test";
import { lsTreeSize, parsePatch, parseRawNumstat } from "../../server/changes/patch";

const Z = "\0";
const ID0 = "0".repeat(40);
const A = "de980441c3ab03a8c07dda1ad27b8a11f39deb1e";
const B = "a7bc997ebe8cf84988b83d2e83f1d193124fe593";
const C = "eaf36c1daccfdf325514461cd1a2ffbc139b5464";

describe("the summary's records (diff-tree -r -M -z --raw --numstat)", () => {
  // As git 2.50 prints them: every raw record, then every numstat record.
  const out = [
    `:000000 100644 ${ID0} ${C} A`, "bin.dat",
    `:100644 100644 ${A} ${A} R100`, "old.txt", "new.txt",
    `:100644 000000 ${B} ${ID0} D`, "sub/s.txt",
    `:100644 100755 ${A} ${B} M`, "x.txt",
    `:100644 100644 ${A} ${A} M`, "mode-only.sh",
    "-\t-\tbin.dat",
    "0\t0\t", "old.txt", "new.txt",
    "0\t1\tsub/s.txt",
    "2\t1\tx.txt",
    "0\t0\tmode-only.sh",
    "",
  ].join(Z);
  test("each record with its status, paths, modes, ids and counts; a binary file has none", () => {
    const r = parseRawNumstat(out);
    expect(r.map((x) => [x.status, x.path, x.from ?? null, x.added, x.removed])).toEqual([
      ["A", "bin.dat", null, null, null],
      ["R", "new.txt", "old.txt", 0, 0],
      ["D", "sub/s.txt", null, 0, 1],
      ["M", "x.txt", null, 2, 1],
      ["M", "mode-only.sh", null, 0, 0],
    ]);
    expect(r[3]!.oldMode).toBe("100644");
    expect(r[3]!.newMode).toBe("100755");
    expect(r[4]!.oldId).toBe(r[4]!.newId);
  });
  test("a path with a tab, a newline or a leading colon is read as it is (-z)", () => {
    const odd = [`:000000 100644 ${ID0} ${C} A`, "a\tb", `:000000 100644 ${ID0} ${C} A`, ":colon\nline", "3\t0\ta\tb", "1\t0\t:colon\nline", ""].join(Z);
    expect(parseRawNumstat(odd).map((x) => [x.path, x.added])).toEqual([
      ["a\tb", 3],
      [":colon\nline", 1],
    ]);
  });
  test("an empty output, and a cut one, read as what is there", () => {
    expect(parseRawNumstat("")).toEqual([]);
    expect(parseRawNumstat(`:000000 100644 ${ID0} ${C} A`)).toEqual([]);
    expect(parseRawNumstat([`:000000 100644 ${ID0} ${C} A`, "a.txt", ""].join(Z))[0]!.added).toBeNull();
  });
});

const CAPS = { maxLines: 3000, lineChars: 2000 };

describe("one file's patch (diff-tree -p -U3)", () => {
  test("hunks with both starts and counts, the function line, each line with its sign first", () => {
    const text = [
      "diff --git a/src/upload.ts b/src/upload.ts",
      "index de98044..a7bc997 100644",
      "--- a/src/upload.ts",
      "+++ b/src/upload.ts",
      "@@ -18,4 +18,5 @@ describe(\"upload\", () => {",
      "   test(\"sends the file\", async () => {",
      "-    await server.start();",
      "+    // Listen first",
      "+    const done = server.wait();",
      "     await send();",
      " ",
      "@@ -40 +41 @@ function tail() {",
      "-  return 1;",
      "+  return 2;",
      "",
    ].join("\n");
    const p = parsePatch(text, CAPS);
    expect(p.binary).toBe(false);
    expect(p.cut).toBeUndefined();
    expect(p.hunks).toEqual([
      {
        oldStart: 18,
        oldLines: 4,
        newStart: 18,
        newLines: 5,
        context: 'describe("upload", () => {',
        lines: ['   test("sends the file", async () => {', "-    await server.start();", "+    // Listen first", "+    const done = server.wait();", "     await send();", " "],
      },
      { oldStart: 40, oldLines: 1, newStart: 41, newLines: 1, context: "function tail() {", lines: ["-  return 1;", "+  return 2;"] },
    ]);
  });
  test("a line of the file that looks like a header is a line (the hunk is read by its counts)", () => {
    const text = ["@@ -1,2 +1,3 @@", " a", "+@@ -9,9 +9,9 @@", "+diff --git a/x b/x", " b", ""].join("\n");
    expect(parsePatch(text, CAPS).hunks).toEqual([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, context: "", lines: [" a", "+@@ -9,9 +9,9 @@", "+diff --git a/x b/x", " b"] }]);
  });
  test("No newline at end of file stays with its hunk, as a line of its own", () => {
    const text = ["@@ -1 +1 @@", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file", ""].join("\n");
    expect(parsePatch(text, CAPS).hunks[0]!.lines).toEqual(["-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file"]);
  });
  test("a new file, a deleted file and a pure rename", () => {
    const added = ["diff --git a/n.txt b/n.txt", "new file mode 100644", "index 0000000..e69de29", "--- /dev/null", "+++ b/n.txt", "@@ -0,0 +1,2 @@", "+one", "+two", ""].join("\n");
    expect(parsePatch(added, CAPS).hunks).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, context: "", lines: ["+one", "+two"] }]);
    const gone = ["--- a/o.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-one", "-two", ""].join("\n");
    expect(parsePatch(gone, CAPS).hunks[0]!.newLines).toBe(0);
    const renamed = ["diff --git a/old.txt b/new.txt", "similarity index 100%", "rename from old.txt", "rename to new.txt", ""].join("\n");
    expect(parsePatch(renamed, CAPS)).toEqual({ binary: false, hunks: [] });
  });
  test("a binary file: git's line, no hunks", () => {
    const text = ["diff --git a/bin.dat b/bin.dat", "new file mode 100644", "index 0000000..eaf36c1", "Binary files /dev/null and b/bin.dat differ", ""].join("\n");
    expect(parsePatch(text, CAPS)).toEqual({ binary: true, hunks: [] });
  });
  test("past 3,000 lines the rest are counted; a line over 2,000 characters ends with an ellipsis", () => {
    const body = Array.from({ length: 4412 }, (_, i) => `+line ${i}`);
    const p = parsePatch(["@@ -0,0 +1,4412 @@", ...body, ""].join("\n"), CAPS);
    expect(p.hunks[0]!.lines.length).toBe(3000);
    expect(p.cut).toEqual({ shown: 3000, more: 1412 });
    const long = parsePatch(["@@ -1 +1 @@", `+${"x".repeat(5000)}`, ""].join("\n"), CAPS).hunks[0]!.lines[0]!;
    expect(long.length).toBe(2000);
    expect(long.endsWith("…")).toBe(true);
    // Never between the halves of a surrogate pair.
    const wide = parsePatch(["@@ -1 +1 @@", `+${"😀".repeat(1500)}`, ""].join("\n"), CAPS).hunks[0]!.lines[0]!;
    expect(wide.length).toBeLessThanOrEqual(2000);
    expect(/[\uD800-\uDBFF]…$/.test(wide)).toBe(false);
  });
  test("a line cut across two hunks: the second hunk's lines count as more", () => {
    const text = ["@@ -1,2 +1,2 @@", "-a", "+b", " c", "@@ -10 +10 @@", "-d", "+e", ""].join("\n");
    const p = parsePatch(text, { maxLines: 3, lineChars: 2000 });
    expect(p.hunks.map((h) => h.lines)).toEqual([["-a", "+b", " c"]]);
    expect(p.cut).toEqual({ shown: 3, more: 2 });
  });
});

describe("ls-tree -l -z", () => {
  test("a blob's size; none for a path that is not there or not a blob", () => {
    expect(lsTreeSize(`100644 blob ${A}       3\tbin.dat${Z}`)).toBe(3);
    expect(lsTreeSize(`100755 blob ${A} 1048577\tbig.bin${Z}`)).toBe(1048577);
    expect(lsTreeSize("")).toBeNull();
    expect(lsTreeSize(`160000 commit ${A}       -\tnested${Z}`)).toBeNull();
  });
});
