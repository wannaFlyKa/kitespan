// The mention chips at send (DESIGN.md 9.3; owner row 54; build checklist C1, server side): each chip names a path
// relative to the chat's folder, and the registry adds its reference in messageRef's form (in a `!` command, the
// single-quoted path) as it does for an upload. The path is checked again at send with the download route's rules: it
// must be a regular file inside the folder, reached without leaving it (a `..` or a link that leads outside is refused,
// whatever is outside), so a chip that went stale or a crafted frame never names a file outside the folder.

import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isSafeRelativePath } from "../../shared/protocol";
import { resolveInside } from "../http/files";

/** The absolute path of each mention, in order, under the chat's folder `cwd`; null when one is not a file there. */
export async function mentionPaths(cwd: string, rels: readonly string[]): Promise<string[] | null> {
  const out: string[] = [];
  for (const rel of rels) {
    if (!isSafeRelativePath(rel)) return null;
    const at = await resolveInside(cwd, rel);
    if (!at) return null;
    try {
      if (!(await lstat(at.real)).isFile()) return null;
    } catch {
      return null;
    }
    // The folder as the chat names it, plus the path as the chip shows it: what the page's tile matches (L10).
    out.push(join(cwd, rel));
  }
  return out;
}
