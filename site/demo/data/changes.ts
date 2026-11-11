// The example chat's first turn's changes (U1): its summary and each file's diff, as the real server reads them from
// the click-through seed's two git marks (test/click/seed/changes.ts). Paths are relative to the chat's folder. The
// test's upload URL is a plain path here: the demo holds no URL of another site. Pure data.

import type { ChangesSummary, FileDiff } from "../../../shared/changes";

export const CHANGES_SUMMARY: ChangesSummary = {
  id: "m7q2x4abk3",
  at: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
  how: "git",
  total: 3,
  added: 18,
  removed: 4,
  files: [
    { path: "docs/UPLOAD-RETRIES.md", status: "A", added: 4, removed: 0 },
    { path: "src/upload.ts", status: "M", added: 13, removed: 4 },
    { path: "test/upload.test.ts", status: "M", added: 1, removed: 0 },
  ],
  others: 0,
};

export const CHANGES_DIFFS: Record<string, FileDiff> = {
  "src/upload.ts": {
    path: "src/upload.ts",
    status: "M",
    added: 13,
    removed: 4,
    hunks: [
      {
        oldStart: 1,
        oldLines: 7,
        newStart: 1,
        newLines: 16,
        context: "",
        lines: [
          "-export async function uploadFile(url: string, body: ReadableStream) {",
          "+// Upload one file with up to three tries. The body is read once into memory, so every try sends the same bytes.",
          "+export async function uploadFile(url: string, body: ReadableStream<Uint8Array>): Promise<Response> {",
          "+  const bytes = await new Response(body).arrayBuffer();",
          "+  let last: unknown = null;",
          "   for (let attempt = 0; attempt < 3; attempt++) {",
          "-    const res = await fetch(url, { method: \"PUT\", body });",
          "-    if (res.ok) return res;",
          "+    try {",
          "+      const res = await fetch(url, { method: \"PUT\", body: bytes.slice(0) });",
          "+      if (res.ok) return res;",
          "+      last = new Error(`upload failed with HTTP ${res.status}`);",
          "+    } catch (e) {",
          "+      last = e;",
          "+    }",
          "+    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));",
          "   }",
          "-  throw new Error(\"upload failed\");",
          "+  throw last instanceof Error ? last : new Error(\"upload failed\");",
          " }",
        ],
      },
    ],
  },
  "docs/UPLOAD-RETRIES.md": {
    path: "docs/UPLOAD-RETRIES.md",
    status: "A",
    added: 4,
    removed: 0,
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 4,
        context: "",
        lines: [
          "+# Upload retries",
          "+",
          "+`uploadFile` reads the body once and sends a fresh copy on each of its three tries, 200 ms, 400 ms and 800 ms apart.",
          "+A stream can be read only once, so the old loop sent an empty body on the second try.",
        ],
      },
    ],
  },
  "test/upload.test.ts": {
    path: "test/upload.test.ts",
    status: "M",
    added: 1,
    removed: 0,
    hunks: [
      {
        oldStart: 7,
        oldLines: 4,
        newStart: 7,
        newLines: 5,
        context: "test(\"upload > sends the file\", async () => {",
        lines: [
          "   const body = new Blob([\"hello\"]).stream();",
          "   const res = await uploadFile(\"/upload/file\", body);",
          "   expect(res.ok).toBe(true);",
          "+  expect(fetch.bodies).toEqual([\"hello\", \"hello\", \"hello\"]);",
          " });",
        ],
      },
    ],
  },
};
