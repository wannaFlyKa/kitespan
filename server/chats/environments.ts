// Row 99: an environment's (a project's) Rename, Move and Remove, behind POST /api/projects/:project/rename, /move and
// /remove. Each is one request; the API runs them one at a time with its other project table changes. Every page hears
// of each change (`notify`, the socket's `projects` frame) and reads the list again.
//
// Rename changes the name only (1 to 80 characters after trimming), never the folder. Move puts the project just before
// another one (or at the end) in the sidebar's order (store/order.ts). Remove is refused while a chat of the project
// works or needs input, another app or the finishing hold holds one, or a worktree is in the making there (the
// registry's projectBusy); else no chat starts there from then on, every page is told (so its pages of the project
// and of its chats go to / with no line), then each chat leaves kitespan with its Claude Code transcript kept, its own
// worktree by Archive's rule (the registry's leaveProject), then the environment's variables file (D60), then the
// project and its new-chat form's uploads go (their folders too: no message ever named them). The folder is never
// touched, and no transcript under Claude Code's projects folder is ever deleted. Before any chat goes, the chats'
// sessions are released for the folder (store/released.ts), each with the folder that holds its transcript: adding
// the same folder later makes a new project, whose list From the terminal then shows those conversations again
// (folderSessions), and no other session of the SDK's own.

import { CONTROL_CHARS } from "../../shared/protocol";
import type { AgentDriver, SessionInfo } from "../agents/types";
import type { ChatRegistry } from "./registry";
import type { ReleasedSession, ReleasedSessions } from "../store/released";
import { movedOrder, projectOrder } from "../store/order";
import { STORE_LIMITS, type ProjectRecord, type Store } from "../store/types";
import { removeUploadDir } from "../store/uploads";
import type { EnvStore } from "../env/store";

/** Remove's refusal while a chat of the environment works or needs input (the page shows the same line). */
export const REMOVE_BUSY = "A chat here is working or needs input. Remove this environment when it is done.";

/** A name as typed: trimmed, 1 to 80 characters with no control character; else null. */
export function cleanProjectName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= STORE_LIMITS.projectName && !CONTROL_CHARS.test(name) ? name : null;
}

/**
 * From the terminal's sessions of a folder: the ones the terminal's /resume shows, and the ones a removed environment
 * released there (`released`, read with the SDK's own included and kept to exactly those ids, each under the folder
 * that holds its transcript: a worktree chat's is its worktree's, which may be gone).
 */
export async function folderSessions(driver: Pick<AgentDriver, "listSessions"> & Partial<Pick<AgentDriver, "listReleased">>, cwd: string, released: readonly ReleasedSession[]): Promise<SessionInfo[]> {
  const byDir = new Map<string, string[]>();
  for (const s of released) byDir.set(s.dir, [...(byDir.get(s.dir) ?? []), s.id]);
  const list = driver.listReleased;
  const [own, ...again] = await Promise.all([driver.listSessions(cwd), ...(list ? [...byDir].map(([dir, ids]) => list.call(driver, dir, ids)) : [])]);
  const listed = new Set(own.map((s) => s.sessionId));
  return [...own, ...again.flat().filter((s) => !listed.has(s.sessionId) && (listed.add(s.sessionId), true))];
}

export type EditResult<T> = { ok: true; value: T } | { ok: false; code: "not_found" | "bad_request" | "busy" | "failed" };

export interface EnvironmentDeps {
  store: Pick<Store, "listProjects" | "putProject" | "putProjects" | "removeProject" | "listUploads">;
  chats: Pick<ChatRegistry, "beginLeave" | "cancelLeave" | "leaveProject" | "sessionsIn">;
  /** D60: the environments' variables (server/env/store.ts), whose file Remove takes out; absent: none has any. */
  env?: Pick<EnvStore, "remove">;
  /** The sessions that Remove releases, by folder (store/released.ts). */
  released: Pick<ReleasedSessions, "release">;
  /** Every page reads the project list again; `removed`: that project is being removed (the socket's `projects`). */
  notify(removed?: string): void;
  /** The server's own uid, whose upload folders may be removed (ownUid()). */
  uid: number;
}

export class Environments {
  constructor(private readonly deps: EnvironmentDeps) {}

  private async find(id: string): Promise<ProjectRecord | null> {
    return (await this.deps.store.listProjects()).find((p) => p.id === id) ?? null;
  }

  /** A project was added: every page reads the list again. */
  changed(): void {
    this.deps.notify();
  }

  async rename(id: string, raw: unknown): Promise<EditResult<ProjectRecord>> {
    const name = cleanProjectName(raw);
    if (name === null) return { ok: false, code: "bad_request" };
    const project = await this.find(id);
    if (!project) return { ok: false, code: "not_found" };
    const next = { ...project, name };
    if (name !== project.name) {
      await this.deps.store.putProject(next);
      this.deps.notify();
    }
    return { ok: true, value: next };
  }

  /** `before`: the project that this one goes just before; null: to the end. Answers the whole list in its order. */
  async move(id: string, before: unknown): Promise<EditResult<ProjectRecord[]>> {
    if (before !== null && typeof before !== "string") return { ok: false, code: "bad_request" };
    const list = await this.deps.store.listProjects();
    if (!list.some((p) => p.id === id)) return { ok: false, code: "not_found" };
    if (before === id) return { ok: true, value: projectOrder(list) };
    const moved = movedOrder(list, id, before);
    if (!moved) return { ok: false, code: "bad_request" };
    await this.deps.store.putProjects(moved);
    this.deps.notify();
    return { ok: true, value: projectOrder(await this.deps.store.listProjects()) };
  }

  async remove(id: string): Promise<EditResult<null>> {
    const project = await this.find(id);
    if (!project) return { ok: false, code: "not_found" };
    if (!this.deps.chats.beginLeave(id)) return { ok: false, code: "busy" };
    // Their conversations stay in Claude Code, and the folder added again lists them: released before any chat goes.
    try {
      await this.deps.released.release(project.cwd, this.deps.chats.sessionsIn(id));
    } catch {
      this.deps.chats.cancelLeave(id);
      return { ok: false, code: "failed" };
    }
    this.deps.notify(id);
    try {
      if (!(await this.deps.chats.leaveProject(id))) return { ok: false, code: "failed" };
      // The variables go before the project, so a file that could not go stays with an environment that works and can
      // be removed again, never with none.
      let form;
      try {
        if (this.deps.env) await this.deps.env.remove(id);
        form = (await this.deps.store.listUploads(null)).filter((u) => u.project === id);
        await this.deps.store.removeProject(id);
      } catch {
        this.deps.chats.cancelLeave(id);
        return { ok: false, code: "failed" };
      }
      for (const u of form) await removeUploadDir(u.dir, this.deps.uid).catch(() => false);
      return { ok: true, value: null };
    } finally {
      this.deps.notify();
    }
  }
}
