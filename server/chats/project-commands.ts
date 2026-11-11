// The project's last command list (D59, owner row 75): the new-chat form's `/` menu before a chat exists. The server
// keeps, with each project (projects.json, store/commands.ts), the newest `commands` that any of its chats reported
// (the registry), and answers GET /api/projects/:project/commands from it. When none is known, or the kept one is over
// 24 h old, one short read goes through the agent seam (AgentDriver.readCommands: an idle Claude Code process for the
// project's folder that answers the list and ends, 20 s at most), in the background: the route answers at once with
// what it has, and the page asks once more about 3 s later when it got none. One read at a time per project; never a
// chat, never counted against the cap of live chats, never a model turn. A read that failed is not tried again for a
// minute. A log line names the route and the error code, never the folder. Only the page's own read starts one (it
// carries the sender header, `x-kitespan: 1`, which a page on another site cannot send): a cross-site image or prefetch
// that knows a project id gets the kept list and starts no Claude Code process (W19d).

import type { CommandInfo } from "../../shared/protocol";
import type { Logger } from "../log";
import { projectCommandsForSave, sameCommands } from "../store/commands";
import type { ProjectCommandsRecord, ProjectRecord, Store } from "../store/types";

export const PROJECT_COMMANDS = {
  /** A kept list older than this is read again in the background; it answers meanwhile. */
  staleMs: 24 * 60 * 60_000,
  /** The same list again is written only when the kept one is older than this (its time stays near the truth). */
  refreshMs: 60 * 60_000,
  /** After a read that failed, the next one waits this long. */
  retryMs: 60_000,
} as const;

/** The route's pattern, for its log lines. */
export const COMMANDS_ROUTE = "/api/projects/:project/commands";

/**
 * The record to keep after a project's list `list` came at `now`, or null when the kept one stands (the same list,
 * kept under an hour ago). `carryMarks`: a short read sees no `system/init`, so it does not know which commands are
 * terminal-only (D47); the names the kept list marked keep their mark.
 */
export function keptCommandsAfter(prev: ProjectCommandsRecord | null | undefined, list: readonly CommandInfo[], now: Date, opts: { carryMarks?: boolean } = {}): ProjectCommandsRecord | null {
  const marked = new Set(opts.carryMarks && prev ? prev.list.filter((c) => c.terminalOnly).map((c) => c.name) : []);
  const rows = marked.size ? list.map((c) => (marked.has(c.name) && !c.terminalOnly ? { ...c, terminalOnly: true } : c)) : list;
  const next = projectCommandsForSave(rows, now.toISOString());
  if (prev && sameCommands(prev.list, next.list) && now.getTime() - Date.parse(prev.at) < PROJECT_COMMANDS.refreshMs) return null;
  return next;
}

/**
 * Keep `list` with project `id`: the project as the store has it now, with the new list; nothing when the project is
 * gone or the kept list stands. Every other field of the project is written as it is now.
 */
export async function keepProjectCommands(
  store: Pick<Store, "listProjects" | "putProject">,
  id: string,
  list: readonly CommandInfo[],
  now: Date,
  opts: { carryMarks?: boolean } = {},
): Promise<boolean> {
  const project = (await store.listProjects()).find((p) => p.id === id);
  if (!project) return false;
  const next = keptCommandsAfter(project.commands, list, now, opts);
  if (!next) return false;
  await store.putProject({ ...project, commands: next });
  return true;
}

/** GET /api/projects/:project/commands (server/http/api-types.ts ProjectCommandsReply). */
export interface ProjectCommandsAnswer {
  commands: CommandInfo[];
  /** When the list was read; null, with an empty list, while none is known (the first read runs, or failed). */
  at: string | null;
}

export interface ProjectCommandsDeps {
  store: Pick<Store, "listProjects" | "putProject">;
  /** The seam's short read (AgentDriver.readCommands); null: the agent has none, and none is ever read. */
  read: ((cwd: string) => Promise<CommandInfo[]>) | null;
  /** Whether a short read may start now (none while the restart drains or the server closes); absent: always. */
  may?: () => boolean;
  now?: () => Date;
  log?: Pick<Logger, "log"> | null;
}

/** The route's side: the answer from the kept list, and the short read when it is needed. */
export class ProjectCommands {
  private readonly running = new Map<string, Promise<void>>();
  private readonly failedAt = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly deps: ProjectCommandsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * The project's kept list; a short read starts in the background when none is known or it is stale, and only when
   * `mayRead` (the page's own read, which carries the sender header).
   */
  answer(project: ProjectRecord, mayRead = true): ProjectCommandsAnswer {
    const kept = project.commands;
    const now = this.now().getTime();
    if (mayRead && (!kept || now - Date.parse(kept.at) > PROJECT_COMMANDS.staleMs)) this.start(project, now);
    return kept ? { commands: kept.list, at: kept.at } : { commands: [], at: null };
  }

  private start(project: ProjectRecord, now: number): void {
    const read = this.deps.read;
    if (!read || this.deps.may?.() === false || this.running.has(project.id)) return;
    const failed = this.failedAt.get(project.id);
    if (failed !== undefined && now - failed < PROJECT_COMMANDS.retryMs) return;
    const run = (async () => {
      let list: CommandInfo[];
      try {
        list = await read(project.cwd);
      } catch (e) {
        this.failedAt.set(project.id, this.now().getTime());
        const code = (e as { code?: unknown } | null)?.code;
        this.logLine(code === "no_claude" ? "spawn_failed" : "sdk_error");
        return;
      }
      this.failedAt.delete(project.id);
      try {
        await keepProjectCommands(this.deps.store, project.id, list, this.now(), { carryMarks: true });
      } catch {
        this.logLine("store_write");
      }
    })();
    this.running.set(project.id, run);
    void run.finally(() => this.running.delete(project.id));
  }

  private logLine(err: "spawn_failed" | "sdk_error" | "store_write"): void {
    try {
      this.deps.log?.log("error", { route: COMMANDS_ROUTE, err });
    } catch {
      // the log never stops a read
    }
  }
}
