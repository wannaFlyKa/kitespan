// Claude Code's model list for every picker (row 81, FIX-W19f): a sleeping or held chat's `get models`, the new-chat
// form and the project page (GET /api/projects/:project/models). The server keeps the last list on disk, with the
// project whose chat or read gave it (projects.json, store/models.ts); the newest list kept with any project is the
// host's list, since Claude Code lists the same models in every folder. Every live chat's `get models` keeps its
// answer (written when it differs from the newest kept list, or that one is over an hour old). When none is kept, or
// the newest is over 24 h old, one short read goes through the agent seam (AgentDriver.readModels: the idle Claude
// Code of D59's command read, which it shares when the project needs both; no model turn; not a chat; 20 s at most),
// one at a time. With none kept, an ask waits for that read; with an old one, the old list answers and the read
// replaces it in the background. A read that failed, or answered no rows, is not tried again for a minute; an empty
// answer is never kept. A log line holds the error code only, never the folder.
// Row 94: the same read gives every model row's context window (AgentDriver.readWindows, from the one idle process),
// kept with the project (projects.json contextWindows, chats/context.ts); a chat whose model's window no project keeps
// asks for the read (refreshWindows), which runs then unless one ran in this server's last day.
//
// D60 (L37): an environment's variables can change the list (ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK), so a
// project with variables keeps a list of its own: its own record answers for it alone, its own short read gets its
// variables, and the host's list is the newest one kept with a project that has none. A project whose variables cannot
// be read starts no read and gets only its own record. Its windows come from its own read too (its variables can change
// the provider), and its chats take no window that another list's read gave (ChatContexts' `own`, the same rule). A
// change of its variables (the env route) drops what the project kept and calls forget(): the day of its own windows'
// read and the minute after a failed one go, and a read of its folder still in flight keeps nothing.

import type { ModelInfo } from "../../shared/protocol";
import type { EnvVar } from "../agents/types";
import { projectModelsForSave, sameModels } from "../store/models";
import { keepWindows } from "./context";
import type { ProjectModelsRecord, ProjectRecord, Store } from "../store/types";

export const MODEL_LIST = {
  /** A kept list older than this is read again; it answers meanwhile. */
  staleMs: 24 * 60 * 60_000,
  /** The same list again is written only when the newest kept one is older than this (its time stays near the truth). */
  refreshMs: 60 * 60_000,
  /** After a read that failed or answered no rows, the next one waits this long. */
  retryMs: 60_000,
} as const;

/** The route's pattern (the new-chat form and the project page), for its log lines. */
export const MODELS_ROUTE = "/api/projects/:project/models";

/** The newest list kept with any project (the host's list), or null when none is kept. */
export function newestModels(projects: readonly ProjectRecord[]): ProjectModelsRecord | null {
  let best: ProjectModelsRecord | null = null;
  for (const p of projects) if (p.models && (!best || p.models.at > best.at)) best = p.models;
  return best;
}

/**
 * Keep `list`, which came at `now`, with project `id`: the project as the store has it now, every other field as it
 * is. Nothing when the list has no rows, the project is gone, or the newest kept list stands (the same list, kept under
 * an hour ago). `own` (D60): which projects keep a list of their own; such a project's list is weighed against its own
 * record only, and another's against the host's list.
 */
export async function keepModels(
  store: Pick<Store, "listProjects" | "putProject">,
  id: string,
  list: readonly ModelInfo[],
  now: Date,
  own: (project: string) => boolean = () => false,
): Promise<boolean> {
  const projects = await store.listProjects();
  const next = projectModelsForSave(list, now.toISOString());
  if (next.list.length === 0) return false;
  const newest = newestModels(own(id) ? projects.filter((p) => p.id === id) : projects.filter((p) => !own(p.id)));
  if (newest && sameModels(newest.list, next.list) && now.getTime() - Date.parse(newest.at) < MODEL_LIST.refreshMs) return false;
  const project = projects.find((p) => p.id === id);
  if (!project) return false;
  await store.putProject({ ...project, models: next });
  return true;
}

/** GET /api/projects/:project/models (server/http/api-types.ts ProjectModelsReply), and a chat's `get models` rows. */
export interface ModelListAnswer {
  models: ModelInfo[];
  /** When the list was read; null, with no rows, while none is known (the read failed, or none may start). */
  at: string | null;
}

export type ModelReadError = "spawn_failed" | "sdk_error" | "store_write";

export interface ModelListDeps {
  store: Pick<Store, "listProjects" | "putProject">;
  /**
   * The seam's short read (AgentDriver.readModels); null: the agent has none, and none is ever read. `vars`: D60, the
   * project's environment's variables, which the read's Claude Code gets (none for the host's list).
   */
  read: ((cwd: string, vars: readonly EnvVar[]) => Promise<ModelInfo[]>) | null;
  /** Row 94: the same read's context windows (AgentDriver.readWindows), with the same `vars`; absent: none are read. */
  windows?: ((cwd: string, vars: readonly EnvVar[]) => Promise<Record<string, number>>) | null;
  /** D60: a project's variables ([] none; null: they cannot be read); absent: no project has any. */
  vars?: (project: string) => readonly EnvVar[] | null;
  /** Whether a short read may start now (none while the restart drains or the server closes); absent: always. */
  may?: () => boolean;
  now?: () => Date;
  /** Runs each write of the project table (the registry's one-after-another chain); by default, at once. */
  write?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** One error line, the code only. */
  onError?: (err: ModelReadError) => void;
}

const answerOf = (kept: ProjectModelsRecord | null): ModelListAnswer => (kept ? { models: [...kept.list], at: kept.at } : { models: [], at: null });

/** The key of the host's list among the reads (a project id has no `:`). */
const HOST = "host:";

export class ModelList {
  /** The read in flight and the last failure, per list: the host's (HOST), or a project's own (its id, D60). */
  private readonly running = new Map<string, Promise<void>>();
  private readonly failedAt = new Map<string, number>();
  /** Row 94: when this server's last read of each list (keyed as `running`) gave the windows; none while none did. */
  private readonly windowsAt = new Map<string, number>();
  /** D60: how often each project's variables changed (forget); a read started before a change keeps nothing. */
  private readonly changes = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly deps: ModelListDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** D60: the project keeps a list of its own (it has variables, or they cannot be read), and its own windows (row 94). */
  readonly own = (project: string): boolean => {
    const vars = this.deps.vars ? this.deps.vars(project) : [];
    return vars === null || vars.length > 0;
  };

  /** The list that answers for `from`: its own record (D60), else the newest one kept with a project that has none. */
  private kept(projects: readonly ProjectRecord[], from: Pick<ProjectRecord, "id"> | null): ProjectModelsRecord | null {
    if (from && this.own(from.id)) return projects.find((p) => p.id === from.id)?.models ?? null;
    return newestModels(projects.filter((p) => !this.own(p.id)));
  }

  /**
   * The host's list, or the project's own when its environment has variables (D60). `from`: the project whose folder a
   * short read would use, and `mayRead` whether one may start (the registry's `get`, the page's own read with the
   * sender header); then a read starts when none is kept or the newest is stale. With none kept, the answer waits for
   * a read that runs.
   */
  async answer(from: Pick<ProjectRecord, "id" | "cwd"> | null, mayRead: boolean): Promise<ModelListAnswer> {
    const kept = this.kept(await this.deps.store.listProjects(), from);
    const now = this.now().getTime();
    if (kept && now - Date.parse(kept.at) <= MODEL_LIST.staleMs) return answerOf(kept);
    const key = from && this.own(from.id) ? from.id : HOST;
    const run = mayRead && from ? this.start(from, key, now) : (this.running.get(key) ?? null);
    if (kept || !run) return answerOf(kept);
    await run;
    return answerOf(this.kept(await this.deps.store.listProjects(), from));
  }

  /**
   * Row 94: the short read for each model row's context window, for a chat whose model's window no project keeps, from
   * the folder of `from`: unless one gave them in this server's last day, and as `answer` starts one (one at a time,
   * none while a restart drains, none for a minute after one failed); resolves once the read that runs has ended. D60:
   * per list, as `answer`: a project with variables has its own read, with them, and its own day.
   */
  async refreshWindows(from: Pick<ProjectRecord, "id" | "cwd">, mayRead: boolean): Promise<void> {
    const now = this.now().getTime();
    const key = this.own(from.id) ? from.id : HOST;
    const at = this.windowsAt.get(key);
    const fresh = at !== undefined && now - at <= MODEL_LIST.staleMs;
    await ((!fresh && mayRead ? this.start(from, key, now) : null) ?? this.running.get(key));
  }

  /**
   * D60: the project's variables changed (the env route dropped its kept list and windows): this server's day of its
   * own windows' read and the minute after its failed read go, and a read of its folder in flight keeps nothing.
   */
  forget(project: string): void {
    this.changes.set(project, (this.changes.get(project) ?? 0) + 1);
    this.windowsAt.delete(project);
    this.failedAt.delete(project);
  }

  /** A live chat's read: kept with the chat's project (keepModels), as its own list when its environment has variables. */
  keep(projectId: string, list: readonly ModelInfo[]): Promise<boolean> {
    const write = this.deps.write ?? ((fn) => fn());
    return write(() => keepModels(this.deps.store, projectId, list, this.now(), this.own));
  }

  private start(from: Pick<ProjectRecord, "id" | "cwd">, key: string, now: number): Promise<void> | null {
    const was = this.running.get(key);
    if (was) return was;
    const read = this.deps.read;
    const failed = this.failedAt.get(key);
    if (!read || this.deps.may?.() === false || (failed !== undefined && now - failed < MODEL_LIST.retryMs)) return null;
    // D60 (L39): an environment whose variables cannot be read starts no Claude Code.
    const vars = this.deps.vars ? this.deps.vars(from.id) : [];
    if (vars === null) return null;
    const change = this.changes.get(from.id);
    const changed = () => this.changes.get(from.id) !== change;
    const run = (async () => {
      // Asked in the same turn as the list, with the same variables, so the driver answers both from one idle process.
      const windows = this.deps.windows?.(from.cwd, vars).catch(() => null) ?? null;
      let list: ModelInfo[];
      try {
        list = await read(from.cwd, vars);
      } catch (e) {
        if (changed()) return;
        this.failedAt.set(key, this.now().getTime());
        this.error((e as { code?: unknown } | null)?.code === "no_claude" ? "spawn_failed" : "sdk_error");
        return;
      }
      if (changed()) return;
      if (list.length) this.failedAt.delete(key);
      else this.failedAt.set(key, this.now().getTime());
      try {
        await this.keep(from.id, list);
      } catch {
        this.error("store_write");
      }
      const got = await windows;
      if (!got || changed()) return;
      this.windowsAt.set(key, this.now().getTime());
      const write = this.deps.write ?? ((fn) => fn());
      await write(() => keepWindows(this.deps.store, from.id, got)).catch(() => this.error("store_write"));
    })();
    this.running.set(key, run);
    void run.finally(() => {
      if (this.running.get(key) === run) this.running.delete(key);
    });
    return run;
  }

  private error(err: ModelReadError): void {
    try {
      this.deps.onError?.(err);
    } catch {
      // the log never stops a read
    }
  }
}
