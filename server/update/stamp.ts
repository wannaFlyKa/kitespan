// The build stamp (DESIGN.md 4.10; build checklist S3): scripts/build-web.ts writes `build.json` beside the page's
// index.html with the checkout's HEAD that it built, so the server can tell "Restart to apply" (the build on disk is
// the checkout's and not the running server's) from "The update did not finish" (the checkout moved and the build did
// not). `head` is null for a build outside a git checkout.

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMIT_ID } from "./git";

export const BUILD_STAMP = "build.json";

export interface BuildStamp {
  head: string | null;
}

/** The stamp's text: one JSON object, the format's version and the commit. */
export function stampText(head: string | null): string {
  return `${JSON.stringify({ v: 1, head })}\n`;
}

/** The stamp of the build folder `dist`, or null when it has none or one that fails its check (a link included). */
export function readStamp(dist: string): BuildStamp | null {
  const file = join(dist, BUILD_STAMP);
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 4096) return null;
    const v = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; head?: unknown } | null;
    if (typeof v !== "object" || v === null || v.v !== 1) return null;
    if (v.head === null) return { head: null };
    return typeof v.head === "string" && COMMIT_ID.test(v.head) ? { head: v.head } : null;
  } catch {
    return null;
  }
}

/** S3: About's build line. `checkout` is the checkout's HEAD now, `running` the running server's from its start. */
export type BuildKind = "none" | "apply" | "unfinished";

/**
 * No line in dev mode (the page comes from web/ itself); "The update did not finish" when the build on disk is not
 * the checkout's (no stamp, or another commit); "Restart to apply" when it is the checkout's and not the running
 * server's; else none.
 */
export function buildKind(o: { dev: boolean; stamp: BuildStamp | null; checkout: string | null; running: string | null }): BuildKind {
  if (o.dev) return "none";
  if (!o.stamp || o.stamp.head !== o.checkout) return "unfinished";
  return o.stamp.head !== o.running ? "apply" : "none";
}
