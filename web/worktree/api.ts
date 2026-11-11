// Row 73's reads on the page (GETs only: they change nothing on the host). The shapes are the WT lane's server routes;
// a server without one answers 404, which reads as "not known" here.

import { ApiError, apiGet } from "../net/api";
import { isWorktreeOff, type WorktreeCan, type WorktreeStatus } from "./worktree";

/**
 * New environment's read for the folder that Use this folder would take (a GET: it changes nothing): whether a
 * worktree can be made there. Null when the server did not say (no answer, or a server without the read): the
 * option then shows, and the project's own record says after the add.
 */
export async function readWorktreeCan(folder: string, fetcher?: typeof fetch): Promise<WorktreeCan | null> {
  try {
    const r = await apiGet<{ ok?: unknown; why?: unknown }>(`/api/folders/worktree?path=${encodeURIComponent(folder)}`, fetcher);
    if (r.ok === true) return { ok: true };
    return isWorktreeOff(r.why) ? { ok: false, why: r.why } : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/chats/:chat/worktree: a read of the worktree's changes, whether it holds files that git ignores (true only
 * when the server says so), and the server's `removes` when it sends one. A 404 is the route's answer for a chat with
 * no worktree of its own (a terminal session's linked worktree, W12): Delete removes none. Null when it could not be
 * read.
 */
export async function readWorktreeStatus(chatId: string, fetcher?: typeof fetch): Promise<WorktreeStatus | null> {
  try {
    const r = await apiGet<{ changes?: unknown; ignored?: unknown; branchStays?: unknown; removes?: unknown }>(`/api/chats/${encodeURIComponent(chatId)}/worktree`, fetcher);
    const changes = typeof r.changes === "number" && Number.isInteger(r.changes) && r.changes >= 0 ? r.changes : null;
    return { changes, ignored: r.ignored === true, branchStays: r.branchStays === true, ...(typeof r.removes === "boolean" ? { removes: r.removes } : {}) };
  } catch (e) {
    return e instanceof ApiError && e.status === 404 ? { changes: null, branchStays: false, removes: false } : null;
  }
}

