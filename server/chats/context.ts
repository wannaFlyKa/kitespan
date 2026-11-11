// Row 94 (the owner: some chats show no context use until a message runs their agent): the context ring and the
// Context detail of a chat with no live Claude Code. A live chat's read answers as before, and is kept: with the chat
// (its notes, on disk) and its model's window with the chat's project (projects.json). While no Claude Code runs for
// the chat (it sleeps, it is held, the server restarted) its `get context` answers the kept read. A chat with none (an
// older chat, a session from another app) is measured from its transcript: the last reply's usage (the agent seam's
// lastUsage) against its model's window, as one used part. The windows come from live reads and from row 81's short
// read, which reads every model row's window too (models.ts); when no project keeps the model's window, the chat asks
// for that read (at most once a day per server) and waits for it. With no window known even then, null, so no ring
// shows (6.7: never a made-up value). Nothing here starts a chat's Claude Code process (4.1). A Default chat's window
// is kept under "default" (on Bedrock its model is an inference profile's ARN, which is never kept: isProviderArn).
// D60: a project with variables (they can change the provider) has its own short read, and its chats take only its own
// windows; another project's chats never take its windows.

import type { ContextInfo } from "../../shared/protocol";
import { isProviderArn, type TranscriptUsage } from "../agents/types";
import { contextNoteOf, contextWindowsFrom } from "../store/context";
import { STORE_LIMITS, type ContextNote, type ProjectRecord, type Store } from "../store/types";

/** The one part of a figure from the transcript: all that the last reply's request and output held. */
export const TRANSCRIPT_PART = "Used";

/**
 * A project's context windows with `add` (model row value or model id to tokens) kept too, each new one last; an entry
 * that cannot be kept (a provider's ARN, a long or odd id, no tokens) is left out; null when there is nothing new.
 */
export function windowsWith(windows: Readonly<Record<string, number>> | undefined, add: Readonly<Record<string, number>>): Record<string, number> | null {
  const keys = Object.keys(add).filter((k) => !isProviderArn(k) && windows?.[k] !== add[k] && contextWindowsFrom({ [k]: add[k] }));
  if (!keys.length) return null;
  const next: Record<string, number> = { ...windows };
  for (const k of keys) {
    delete next[k];
    next[k] = add[k]!;
  }
  // The oldest windows go first past the cap.
  for (const k of Object.keys(next).slice(0, Math.max(0, Object.keys(next).length - STORE_LIMITS.contextWindows))) delete next[k];
  return contextWindowsFrom(next) ?? null;
}

/** Keep `add` with project `id`, the project as the store has it now; false when nothing changed or it is gone. */
export async function keepWindows(store: Pick<Store, "listProjects" | "putProject">, id: string, add: Readonly<Record<string, number>>): Promise<boolean> {
  const project = (await store.listProjects()).find((p) => p.id === id);
  const next = project && windowsWith(project.contextWindows, add);
  if (!next) return false;
  await store.putProject({ ...project, contextWindows: next });
  return true;
}

/**
 * The window of `model`: as the chat's project keeps it, else as another project does; null when none does. `own`
 * (D60, ModelList.own): the projects whose variables can change the provider, so each one's windows answer for itself
 * alone, and another's never answer for it.
 */
export function windowOf(
  projects: readonly Pick<ProjectRecord, "id" | "contextWindows">[],
  projectId: string,
  model: string | null,
  own: (project: string) => boolean = () => false,
): number | null {
  if (!model) return null;
  const mine = projects.find((p) => p.id === projectId)?.contextWindows?.[model];
  if (mine !== undefined || own(projectId)) return mine ?? null;
  return projects.find((p) => !own(p.id) && p.contextWindows?.[model])?.contextWindows?.[model] ?? null;
}

/** The figure of a transcript's last usage against its model's window: one used part; null with either unknown. */
export function transcriptFigure(usage: TranscriptUsage | null, window: number | null): ContextInfo | null {
  if (!usage || !window) return null;
  const used = Math.min(usage.usedTokens, window);
  return { model: usage.model, usedTokens: used, maxTokens: window, percent: Math.round((used / window) * 1000) / 10, parts: [{ name: TRANSCRIPT_PART, tokens: used, kind: "used" }] };
}

export interface ChatContextsDeps {
  store: Pick<Store, "listProjects" | "putProject">;
  /** The transcript's last reply's usage (AgentDriver.lastUsage). */
  usage: (sessionId: string, cwd: string) => Promise<TranscriptUsage | null>;
  /** Row 81's short read for every model row's window, for the chat's folder (ModelList.refreshWindows). */
  refresh?: (chat: { project: string; cwd: string }) => Promise<void>;
  /** D60: the projects that keep their own windows (ModelList.own); absent: none does. */
  own?: (project: string) => boolean;
  now?: () => Date;
  /** Runs each write of the project table (the registry's one-after-another chain); by default, at once. */
  write?: <T>(fn: () => Promise<T>) => Promise<T>;
  onError?: (err: "store_write") => void;
}

export class ChatContexts {
  private readonly now: () => Date;

  constructor(private readonly deps: ChatContextsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * A live chat's read: the note the chat keeps (the caller writes it with the chat's notes), and the read's model's
   * window kept with project `projectId` (in the background); null: with none (D60: the chat runs with old values).
   */
  keep(read: ContextInfo, projectId: string | null): ContextNote | undefined {
    const write = this.deps.write ?? ((fn) => fn());
    if (read.model && projectId !== null) void write(() => keepWindows(this.deps.store, projectId, { [read.model!]: read.maxTokens })).catch(() => this.deps.onError?.("store_write"));
    return contextNoteOf(read, this.now().toISOString());
  }

  /**
   * A chat with no live read: its kept read, else its transcript's figure (after the short read for the windows when no
   * project keeps its model's), else null. `cwd`: where the transcript is filed; `readCwd`: the folder of the short read
   * (the project's, for a chat in a worktree); absent, `cwd`.
   */
  async answer(kept: ContextNote | undefined, chat: { project: string; sessionId: string | null; cwd: string; readCwd?: string }): Promise<ContextInfo | null> {
    if (kept) return kept.info;
    if (!chat.sessionId) return null;
    const usage = await this.deps.usage(chat.sessionId, chat.cwd).catch(() => null);
    if (!usage) return null;
    let window = windowOf(await this.deps.store.listProjects(), chat.project, usage.model, this.deps.own);
    if (window === null && usage.model && this.deps.refresh) {
      await this.deps.refresh({ project: chat.project, cwd: chat.readCwd ?? chat.cwd }).catch(() => {});
      window = windowOf(await this.deps.store.listProjects(), chat.project, usage.model, this.deps.own);
    }
    return transcriptFigure(usage, window);
  }
}
