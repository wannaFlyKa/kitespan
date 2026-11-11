// R130: the service worker's build (web/sw.ts, DESIGN-R130 4.5): one classic script, minified, with only shared/
// code inlined, which the page's build writes as sw.js in the build folder (scripts/build-web.ts) and which dev mode
// makes in memory at start (server/main.ts). The server serves it at /sw.js (static.ts).

import { join } from "node:path";

/** The service worker's source, under the repository root. */
export const WORKER_ENTRY = join("web", "sw.ts");

export async function buildWorker(root: string): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [join(root, WORKER_ENTRY)],
    format: "iife",
    target: "browser",
    minify: true,
    sourcemap: "none",
  });
  if (!result.success || result.outputs.length !== 1) throw new Error("the service worker did not build");
  return new Uint8Array(await result.outputs[0]!.arrayBuffer());
}
