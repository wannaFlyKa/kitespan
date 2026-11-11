// Row 99: an environment's Rename and Remove, each opened by its own path (/p/<project>/rename and /p/<project>/remove),
// so the environment menu, a link, a reload, Back and Forward all open the same state, and only the named button acts.
// Rename puts a field in place of the project page's title, as a chat's title bar does (RenameForm): the name only, at
// most 80 characters, never blank after trimming; Enter or Save saves, Esc or Cancel keeps the old name; a ?name= value
// is shown and saved only by Save; Save closes on the server's ok only, a refusal keeps the field with its line. Remove
// is a confirm as a chat's Delete is (a dialog; on the phone a sheet with Cancel at the top right): one line says what
// leaves kitespan and what stays, then Cancel and Remove. In iteration 4's part 2 a line says that the environment's
// variables go (never a value), and one line names each worktree of kitespan's own that stays on disk, read as Delete's
// confirm reads it (Remove waits for the read; L25, L27); from row 100 a clean one inside the project's folder gets
// Delete's line too, and the first line then does not say that the folder is not changed. While a chat of the
// environment works or needs input, or
// another app holds one, it says so instead, with no Remove (the server refuses it then too, and while a worktree is
// in the making there). After Remove the page goes to / (no line), as after Delete. Both close back to the page that
// opened them (envParent).
import { useEffect, useMemo, useRef, useState } from "react";
import { closeTo, navigate, parse, type EntryState, type Route } from "../router";
import { act, useStore } from "../state/store";
import type { Chat, Project } from "../state/types";
import { useAckClose } from "./ackClose";
import { Modal, useModalSheet } from "./Modal";
import { isBusy } from "../screens/common";
import { inFolder, ownWorktree, removeTreeLine, sharedWorktree, type WorktreeStatus } from "../worktree/worktree";
import { readWorktreeStatus } from "../worktree/api";
import { WithPath } from "../worktree/PathText";

/** At most this many characters (the server's STORE_LIMITS.projectName). */
export const NAME_MAX = 80;

/** Remove's refusal while a chat of the environment works or needs input: the server's own line (environments.ts). */
export const REMOVE_BUSY_LINE = "A chat here is working or needs input. Remove this environment when it is done.";

export const removeTitle = (name: string) => `Remove ${name}?`;

/**
 * The confirm's one line: what leaves kitespan (every chat of it, archived ones too) and what stays. `folderChanges`
 * (row 100): a worktree of kitespan's own inside the folder may go, so the line does not say that the folder is not
 * changed (that worktree's own line says it).
 */
export function removeLine(chats: number, folderChanges = false): string {
  if (chats === 0) return "The folder is not changed.";
  const folder = folderChanges ? "." : ", and the folder is not changed.";
  if (chats === 1) return `Its chat leaves kitespan. The conversation stays in Claude Code${folder}`;
  return `Its ${chats} chats leave kitespan. Their conversations stay in Claude Code${folder}`;
}

/** D60: Remove's line when the environment has variables, or a file of them that cannot be read. */
export const REMOVE_VARS_LINE = "Its environment variables are removed.";

/** A chat of the environment works or needs input now (the chat list's own rule, isBusy), or another app holds it. */
export function envBusy(chats: readonly Chat[], projectId: string): boolean {
  return chats.some((c) => c.projectId === projectId && !c.archived && (isBusy(c) || !!c.held));
}

/**
 * One worktree of kitespan's own in the environment, once per path, with the chat whose read names it (L27: shared).
 */
export interface RemoveTree {
  chat: string;
  path: string;
  shared: boolean;
}

/** The environment's worktrees of kitespan's own (archived chats' too), each path once; never a linked one (W12). */
export function removeTrees(chats: readonly Chat[], projectId: string): RemoveTree[] {
  const out: RemoveTree[] = [];
  for (const c of chats) {
    if (c.projectId !== projectId || !ownWorktree(c.worktree) || out.some((t) => t.path === c.worktree!.path)) continue;
    out.push({ chat: c.id, path: c.worktree.path, shared: sharedWorktree(chats, c) });
  }
  return out;
}

/** Each worktree's changes, read once as the confirm opens (Delete's GET); a missing one is still being read. */
function useTreeStatuses(trees: readonly RemoveTree[]): ReadonlyMap<string, WorktreeStatus | null> {
  const [got, setGot] = useState<ReadonlyMap<string, WorktreeStatus | null>>(() => new Map());
  const key = trees.map((t) => t.chat).join(" ");
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(" ") : []) {
      void readWorktreeStatus(id).then((r) => {
        if (live) setGot((m) => new Map(m).set(id, r));
      });
    }
    return () => {
      live = false;
    };
  }, [key]);
  return got;
}

/**
 * Where Rename and Remove close to (5.1 rule 4): the page that opened them (the entry's `from`: a chat, the list, the
 * project page), else the project page; never this environment's own Rename or Remove.
 */
export function envParent(projectId: string, from: unknown = typeof history === "undefined" ? undefined : (history.state as EntryState | null)?.from): string {
  const own = `/p/${projectId}`;
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//")) return own;
  const r = parse(new URL(from, "http://kitespan.invalid"));
  if (r.fallbackFrom) return own;
  return (r.name === "projectRename" || r.name === "projectRemove") && r.params.project === projectId ? own : from;
}

export function EnvRenameForm({ project, route }: { project: Project; route: Route }) {
  const linked = typeof route.query.name === "string" ? route.query.name : undefined;
  const [name, setName] = useState(linked ?? project.name);
  const [parent] = useState(() => envParent(project.id));
  const field = useRef<HTMLInputElement>(null);
  const clean = name.trim();
  const ack = useAckClose();
  const cancel = () => closeTo(parent);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    if (linked === undefined) el.select();
  }, []);
  // The field is a state of the page: Esc closes it even when the focus is elsewhere on it, unless a menu or a dialog is
  // open (it takes Esc first).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(".menu, .sheet, .dialog")) return;
      e.preventDefault();
      e.stopPropagation();
      closeTo(parent);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [parent]);
  return (
    <form
      className="scr-rename scr-env-rename"
      data-testid="project-rename"
      onSubmit={(e) => {
        e.preventDefault();
        if (!clean || ack.waiting) return;
        ack.press(act.renameProject(project.id, clean), () => closeTo(parent));
      }}
    >
      <label className="visually-hidden" htmlFor="scr-env-name">
        Environment name
      </label>
      <input
        id="scr-env-name"
        ref={field}
        className="field scr-rename-field scr-env-name"
        value={name}
        maxLength={NAME_MAX}
        autoComplete="off"
        enterKeyHint="done"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }}
      />
      {ack.line ? (
        <p className="notice" data-testid="dialog-notice" role="status">
          {ack.line}
        </p>
      ) : null}
      <div className="scr-rename-actions">
        <button type="button" className="btn" onClick={cancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" data-testid="confirm-save-name" disabled={!clean || ack.waiting}>
          Save
        </button>
      </div>
    </form>
  );
}

/** Remove <name>?: its lines, then Cancel and Remove (on the phone's sheet, Cancel at the top right). */
export function RemoveEnvDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  return (
    <Modal title={removeTitle(project.name)} testId="dialog-remove-project" onClose={onClose} confirm>
      <RemoveEnvBody project={project} onClose={onClose} />
    </Modal>
  );
}

/**
 * Remove's body (exported for the tests): the first line, the variables line when the environment has any, then a line
 * for each worktree that stays on disk and each clean one that goes from the project's folder; Remove waits while a
 * worktree's changes are being read.
 */
export function RemoveEnvBody({ project, onClose }: { project: Project; onClose: () => void }) {
  const sheet = useModalSheet();
  const chats = useStore((s) => s.chats);
  const count = useMemo(() => chats.filter((c) => c.projectId === project.id).length, [chats, project.id]);
  const busy = useMemo(() => envBusy(chats, project.id), [chats, project.id]);
  const trees = useMemo(() => removeTrees(chats, project.id), [chats, project.id]);
  const statuses = useTreeStatuses(trees);
  const kept = trees.map((t) => ({ path: t.path, ...removeTreeLine(t.path, statuses.get(t.chat), t.shared, inFolder(t.path, project.folder)) }));
  const reading = kept.some((k) => k.reading);
  const folderChanges = kept.some((k) => k.touchesFolder);
  const vars = (project.env ?? 0) > 0 || project.envUnreadable === true;
  const ack = useAckClose();
  const refused = ack.line !== null && !(busy && ack.line === REMOVE_BUSY_LINE) ? ack.line : null;
  return (
    <>
      {busy ? <p data-testid="remove-busy">{REMOVE_BUSY_LINE}</p> : <p>{removeLine(count, folderChanges)}</p>}
      {!busy && vars ? <p data-testid="remove-vars-line">{REMOVE_VARS_LINE}</p> : null}
      {busy
        ? null
        : kept.map((k) =>
            k.line ? (
              <p key={k.path} className="wt-path-line" data-testid="remove-worktree-line" aria-busy={k.reading || undefined}>
                <WithPath text={k.line} path={k.path} />
                {k.reading ? <span className="scr-dim"> ...</span> : null}
              </p>
            ) : null,
          )}
      {refused ? (
        <p className="notice" data-testid="dialog-notice" role="status">
          {refused}
        </p>
      ) : null}
      {sheet && busy ? null : (
        <div className="dialog-actions">
          {!sheet ? (
            <button type="button" className="btn" data-autofocus onClick={onClose}>
              {busy ? "Close" : "Cancel"}
            </button>
          ) : null}
          {!busy ? (
            <button
              type="button"
              className="btn primary danger"
              data-testid="confirm-remove"
              disabled={ack.waiting || reading}
              onClick={() => ack.press(act.removeProject(project.id), () => navigate("/", { replace: true }))}
            >
              Remove
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}
