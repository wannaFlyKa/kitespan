// New environment (D54), Desktop's name for the dialog where a session's folder is chosen (Cmd+Option+0 opens it
// there). The new-chat form's folder picker opens it (Home's folder chip, /new, and /chats on a laptop, which shows
// Home's form). One line names the machine by the server's own name for it, never the browser's address; then the
// folder is found, not typed: Suggested (the folders of Claude Code's past sessions and the git repositories that no
// kitespan project has: the form's folder picker lists those), then Browse from the home folder (a breadcrumb back up,
// folder rows with a git mark, a tap goes in), under one filter field that narrows the rows and takes a typed /path
// or ~/path (dialogs/finder.ts). One primary button, Use this folder, adds the project for the folder (act.addFolder,
// POST /api/projects: an existing project's folder answers that project) and the form selects it; it is off while a
// filter matches no row. Nothing is sent before that click: the listings are GETs. A laptop shows a dialog with Cancel
// beside the button; a touch device (the phone, a tablet) a full-height sheet with 44 px rows and Cancel at the top
// right, as the rename sheet, which rides the on-screen keyboard (Modal.tsx). No helper line and no mark (principle
// 0): the field's placeholder says what it takes, and a line shows only when a folder cannot be read or added.
// Under the finder, Desktop's two rows (row 73, D60): the Worktree checkbox (a switch here, as every on/off setting of
// the page), off by default and off with one line where a worktree cannot be made (a read for the folder that Use this
// folder would take), and "Environment variables" with "None for this environment", whose tap opens the KEY=value
// field with each line's problem named before Use this folder, which stays off while one has a problem; the row counts
// the lines that pass, and none while a line has a problem. The values go once, after the project exists (POST
// /api/projects, then POST /api/projects/:project/env), and live in this dialog's state only, never in the new-chat
// form's draft or local storage. A save that is refused or fails keeps the field and its lines for the project the
// dialog just made: Use this folder sends that save again (not the project), and the form gets the project only once
// the save went through or the field is empty. For a folder that a project has already, both rows open that project's
// environment instead (DESIGN 6.9), and lines typed in the field keep Use this folder off, with one line that says to
// add them in its editor (a URL never carries them), so nothing typed is dropped without a word.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FoldersReply, SuggestedFolder } from "../../server/http/api-types";
import { act, useStore } from "../state/store";
import { useViewport } from "../layout/size";
import { href } from "../router";
import { Link } from "../ui/primitives";
import type { Project } from "../state/types";
import { IconBranch, IconChevron, IconFolder, IconRight } from "../ui/icons";
import { VarsField } from "../env/EnvFields";
import { refusedLines } from "../env/EnvSection";
import { ENV_WORDS, countWords, envCell, readField, saveEnv, type FieldRead } from "../env/vars";
import { WorktreeOption } from "../worktree/WorktreeOption";
import { WORKTREE_WORDS, type WorktreeCan } from "../worktree/worktree";
import { readWorktreeCan } from "../worktree/api";
import { Modal, useModalSheet } from "./Modal";
import { activeRow, askKey, crumbs, expand, finderKey, finderView, folderToRead, folderToUse, listingAsk, parentOf, readFolders, readSuggested, tilde, type FinderRow } from "./finder";

export const NEW_ENVIRONMENT = "New environment";
export const USE_FOLDER = "Use this folder";
export const FILTER_HINT = "Filter or type a path";
/** A typed path (or a filter sent with a folder's read) is read once the typing pauses this long. */
const TYPED_WAIT_MS = 120;
/** D60: lines typed for a folder that a project has already: they go in its editor, never through a URL. */
export const HAS_ENVIRONMENT = "This folder has an environment already. Add these in";

/** Use this folder's input: the folder, its project if one has it, the project this dialog made, the two rows. */
export interface AddInput {
  target: string;
  existing: Project | undefined;
  /** The project that this dialog's last Use this folder made, whose variables' save did not go through. */
  made: string | null;
  worktree: boolean;
  vars: FieldRead;
}
export type AddResult = { kind: "added"; id: string } | { kind: "line"; line: string } | { kind: "notSaved"; made: string; refused: string[] };

/**
 * Use this folder (D54, row 73, D60): the project (POST /api/projects), then the variables once, after it exists. For
 * the project this dialog made already (`made` is the folder's project), only the save goes again. `notSaved`: the
 * project exists and the save was refused or failed, so the dialog keeps the field for the next press.
 */
export async function addEnvironment(input: AddInput): Promise<AddResult> {
  const { target, existing, made, worktree, vars } = input;
  const ours = made !== null && existing?.id === made;
  let id: string;
  if (ours) id = made;
  else {
    const r = await act.addFolder(target, { worktree: !existing && worktree });
    if (!("id" in r)) return { kind: "line", line: r.line };
    id = r.id;
  }
  if ((ours || !existing) && vars.set.length) {
    const change = { set: vars.set, remove: [] };
    const answer = await saveEnv(id, change);
    if (!answer.ok) return { kind: "notSaved", made: id, refused: refusedLines(answer, change, vars) };
    act.tookEnvCount(id, answer.reply.vars.length);
  }
  return { kind: "added", id };
}

export function NewEnvironmentDialog({ onAdded, onClose }: { onAdded: (projectId: string) => void; onClose: () => void }) {
  return (
    <Modal title={NEW_ENVIRONMENT} testId="dialog-new-environment" onClose={onClose} full>
      <Finder onAdded={onAdded} onClose={onClose} />
    </Modal>
  );
}

/** What the finder holds before its own reads come: the home folder's listing and the suggestions (a test's render). */
export interface FinderStart {
  listing?: FoldersReply;
  suggested?: SuggestedFolder[];
  /** Row 73: the Worktree read's answer for the folder Use this folder takes, and the switch's state. */
  can?: WorktreeCan | null;
  worktree?: boolean;
  /** D60: the KEY=value field, open with this text. */
  vars?: string;
  /** D60: the project this dialog made, whose save did not go through, with the save's refused lines. */
  made?: string;
  refused?: string[];
}

export function Finder({ onAdded, onClose, start }: { onAdded: (projectId: string) => void; onClose: () => void; start?: FinderStart }) {
  const machine = useStore((s) => s.machine);
  const projects = useStore((s) => s.projects);
  const folders = useMemo(() => new Set(projects.map((p) => p.folder)), [projects]);
  const touch = useViewport().touch;
  const sheet = useModalSheet(true);
  const [text, setText] = useState("");
  const [dir, setDir] = useState("~"); // the folder browsed to: "~" at the start, then a listed folder's path
  const [picked, setPicked] = useState<number | null>(null); // the row the arrows moved to
  // The listings read while the dialog is open, by key: a folder seen before shows at once while it is read again.
  const [listings, setListings] = useState<ReadonlyMap<string, FoldersReply>>(() => new Map(start?.listing ? [[askKey({ path: "~", hidden: false }), start.listing]] : []));
  const [home, setHome] = useState<string | null>(() => start?.listing?.home || null);
  const [suggested, setSuggested] = useState<SuggestedFolder[]>(() => start?.suggested ?? []);
  const [adding, setAdding] = useState(false);
  const [line, setLine] = useState<string | null>(null); // why the folder was not added
  // Row 73: the Worktree switch, and the read of whether a worktree can be made in the folder Use this folder takes.
  const [worktree, setWorktree] = useState(start?.worktree ?? false);
  const [can, setCan] = useState<{ folder: string; can: WorktreeCan | null } | null>(null);
  // D60: the KEY=value field (open or not, its text), this dialog's own state; a refused save's lines.
  const [varsOpen, setVarsOpen] = useState(start?.vars !== undefined);
  const [varsText, setVarsText] = useState(start?.vars ?? "");
  const [varsRefused, setVarsRefused] = useState<string[] | null>(start?.refused ?? null);
  // The project the last Use this folder made while its variables' save did not go through (addEnvironment).
  const [made, setMade] = useState<string | null>(start?.made ?? null);
  const field = useRef<HTMLInputElement>(null);
  const varsField = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const trail = useRef<HTMLOListElement>(null);
  const id = useId();

  const first = finderView({ text, dir, home, listing: null, suggested });
  // The folder's own listing; over the cap, the filter is read with it (finder.ts listingAsk).
  const whole = listings.get(askKey(first.list)) ?? null;
  const ask = listingAsk(first.list, first.filter, whole);
  const key = askKey(ask);
  // The listing of the folder asked for (its whole listing while the filtered one loads), or null while it loads the
  // first time: a row of the folder before never shows under the next folder's breadcrumb.
  const now = listings.get(key) ?? (ask.q ? whole : null);
  const view = finderView({ text, dir, home, listing: now, suggested, projects: folders });

  useEffect(() => {
    let live = true;
    const read = () =>
      void readFolders(ask).then((reply) => {
        if (!live) return;
        setListings((m) => new Map(m).set(key, reply));
        if (reply.home) setHome(reply.home);
      });
    const wait = first.typed || ask.q ? setTimeout(read, TYPED_WAIT_MS) : null;
    if (!wait) read();
    return () => {
      live = false;
      if (wait) clearTimeout(wait);
    };
  }, [key]);
  useEffect(() => {
    let live = true;
    void readSuggested().then((s) => {
      if (live) setSuggested(s);
    });
    return () => {
      live = false;
    };
  }, []);

  const rows = [...view.suggested, ...view.browse];
  const active = activeRow(picked, rows.length, view.filter);
  const pick = { active: active === null ? null : rows[active]!, typed: view.typed, filter: view.filter, listing: now };
  const target = folderToUse(pick);
  const here = now?.path.startsWith("/") ? now.path : expand(first.list.path, home);
  // The folder that Use this folder takes, made absolute, and the project that has it already, if one does.
  const targetFull = target ? (expand(target, home) ?? target) : null;
  const existing = targetFull ? projects.find((p) => p.folder === targetFull) : undefined;
  // The project this dialog made while its save waits for a retry: the dialog keeps the new folder's rows for it.
  const ours = made !== null && existing?.id === made ? existing : undefined;
  const other = ours ? undefined : existing;
  // The Worktree read asks only for a listed folder (finder.ts folderToRead).
  const readFolder = folderToRead(pick);
  const readFull = readFolder ? (expand(readFolder, home) ?? readFolder) : null;
  const vars = readField(varsText);
  const varsBad = vars.lines.some((l) => l.problem) || vars.problem !== null;
  // Lines in the field while the folder has a project of its own: they would go nowhere, so Use this folder waits.
  const strayVars = other !== undefined && vars.lines.length > 0;
  // The read's answer for this folder (start's for a test); a git mark of the row says "not a repository" at once.
  const known = can && can.folder === targetFull ? can.can : (start?.can ?? null);
  const activeRowGit = active === null ? null : rows[active]!.git;
  const off = known && !known.ok ? known.why : activeRowGit === false ? "not_git" : null;
  const trailPath = here ? crumbs(here, home) : [];
  const rowId = (i: number) => `${id}-row-${i}`;
  // A long breadcrumb shows its end, the folder Browse is in.
  useLayoutEffect(() => {
    const el = trail.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [here]);

  /** Into a folder (a typed `~/...` made absolute): the rows become its folders, and the field is cleared. */
  const go = (path: string) => {
    setDir(expand(path, home) ?? path);
    setText("");
    setPicked(null);
    setLine(null);
    list.current?.scrollTo?.({ top: 0 });
    if (!touch) field.current?.focus({ preventScroll: true }); // a touch keyboard stays down until the field is tapped
  };
  const useOff = !target || adding || (!other && varsBad) || strayVars;
  const use = () => {
    if (useOff) return;
    setAdding(true);
    setLine(null);
    setVarsRefused(null);
    // D60: the values go once, after the project exists. A refused or failed save keeps the dialog, with its lines,
    // for that project: the next press sends the save again, and the form gets the project only after it.
    void addEnvironment({ target, existing, made, worktree: worktree && off === null, vars }).then((r) => {
      setAdding(false);
      if (r.kind === "line") {
        setLine(r.line);
        return;
      }
      if (r.kind === "notSaved") {
        setMade(r.made);
        setLine(ENV_WORDS.notSaved);
        setVarsOpen(true);
        setVarsRefused(r.refused);
        return;
      }
      setMade(null);
      setVarsText("");
      onAdded(r.id);
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = finderKey({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, active, rows.length);
    if (!k) return;
    if (k.kind === "use") {
      e.preventDefault();
      use();
      return;
    }
    if (e.target !== field.current) return; // Enter on a breadcrumb or a button presses it
    e.preventDefault();
    if (k.kind === "move") {
      setPicked(k.to);
      document.getElementById(rowId(k.to))?.scrollIntoView({ block: "nearest" });
    } else if (active !== null) go(rows[active]!.path);
    else if (view.typed) go(view.typed.full);
  };

  useEffect(() => {
    if (!readFull || existing) return;
    let live = true;
    const t = setTimeout(() => {
      void readWorktreeCan(readFull).then((answer) => {
        if (live) setCan({ folder: readFull, can: answer });
      });
    }, TYPED_WAIT_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [readFull, !!existing]);

  const rowClass = sheet ? "group-row scr-env-row" : "menu-row scr-env-row";
  const groupClass = sheet ? "group scr-env-rows" : "scr-env-rows";
  const titleClass = sheet ? "group-title scr-env-title" : "scr-env-title";
  const suggestedId = `${id}-suggested`;
  const browseId = `${id}-browse`;
  let n = 0;
  const row = (r: FinderRow) => {
    const i = n++;
    return (
      <div key={r.key} id={rowId(i)} role="option" aria-selected={i === active} data-active={i === active || undefined} className={rowClass} data-testid="env-row" data-from={r.from} onClick={() => go(r.path)}>
        <IconFolder className="scr-pick-icon" />
        <span className="scr-pick-text">
          <span className="scr-pick-name">{r.name}</span>
          {r.from === "suggested" ? <span className="row-hint mono">{tilde(parentOf(r.path), home)}</span> : null}
        </span>
        {r.git ? (
          <span className="scr-env-git" title="Git repository">
            <IconBranch />
            <span className="visually-hidden">Git repository</span>
          </span>
        ) : null}
        {r.more ? <IconRight className="scr-env-more" /> : null}
      </div>
    );
  };

  return (
    <div className="scr-env" onKeyDown={onKeyDown}>
      {machine ? (
        <p className="scr-env-host" data-testid="env-host">
          On {machine}
        </p>
      ) : null}
      <input
        ref={field}
        className="field scr-env-filter"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={`${suggestedId} ${browseId}`}
        aria-activedescendant={active === null ? undefined : rowId(active)}
        aria-label={FILTER_HINT}
        placeholder={FILTER_HINT}
        value={text}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        data-autofocus={touch ? undefined : ""}
        data-testid="env-filter"
        onChange={(e) => {
          setText(e.target.value);
          setPicked(null);
          setLine(null);
        }}
      />
      <div className="scr-env-list" ref={list}>
        {view.suggested.length ? (
          <section className="scr-env-part">
            <h3 className={titleClass} id={`${suggestedId}-title`}>
              Suggested
            </h3>
            <div className={groupClass} role="listbox" id={suggestedId} aria-labelledby={`${suggestedId}-title`} data-testid="env-suggested">
              {view.suggested.map(row)}
            </div>
          </section>
        ) : null}
        <section className="scr-env-part" data-testid="env-browse">
          {view.suggested.length ? <h3 className={titleClass}>Browse</h3> : null}
          {trailPath.length ? (
            <nav className="scr-env-crumbs" aria-label="Folder path">
              <ol ref={trail} data-testid="env-crumbs">
                {trailPath.map((c, i) => (
                  <li key={c.path}>
                    {i ? <IconRight className="scr-env-sep" /> : null}
                    {i < trailPath.length - 1 ? (
                      <button type="button" className="btn plain scr-env-crumb" onClick={() => go(c.path)}>
                        {c.label}
                      </button>
                    ) : (
                      <span className="scr-env-here" aria-current="location">
                        {c.label}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
          {view.browse.length ? (
            <div className={groupClass} role="listbox" id={browseId} aria-label="Browse">
              {view.browse.map(row)}
            </div>
          ) : null}
          {now && !now.ok ? (
            <p className="scr-env-line" role="status" data-testid="env-line">
              {now.line}
            </p>
          ) : null}
        </section>
      </div>
      <div className="scr-env-opts" data-testid="env-options">
        {other ? (
          <>
            <ul className="group scr-env-opt-group">
              <li>
                <Link to={href("projectEnvironment", { project: other.id })} className="group-row scr-env-opt" onNavigate={onClose}>
                  <span className="group-label">{WORKTREE_WORDS.option}</span>
                  <span className="group-value">{other.worktree ? "On" : "Off"}</span>
                  <IconRight className="group-chevron" />
                </Link>
              </li>
              <li>
                <Link to={href("projectEnvironment", { project: other.id })} className="group-row scr-env-opt" onNavigate={onClose}>
                  <span className="group-label">{ENV_WORDS.title}</span>
                  <span className="group-value">{envCell(other)}</span>
                  <IconRight className="group-chevron" />
                </Link>
              </li>
            </ul>
            {strayVars ? (
              <div className="scr-env-varsbox scr-env-stray" data-testid="env-existing-vars">
                <p className="scr-env-line" role="status">
                  {HAS_ENVIRONMENT}{" "}
                  <Link to={href("projectEnvironment", { project: other.id })} onNavigate={onClose}>
                    its editor
                  </Link>
                  .
                </p>
                {/* The field stays in view, so its lines can be copied into the editor or emptied here. */}
                <VarsField text={varsText} onText={setVarsText} read={vars} fieldRef={varsField} />
              </div>
            ) : null}
          </>
        ) : (
          <ul className="group scr-env-opt-group">
            <li>
              {ours ? (
                <WorktreeOption on={ours.worktree === true} off={ours.worktreeOff ?? null} disabled onChange={() => {}} testId="new-env-worktree" />
              ) : (
                <WorktreeOption on={worktree && off === null} off={off} onChange={setWorktree} testId="new-env-worktree" />
              )}
            </li>
            <li className="scr-env-vars">
              <button
                type="button"
                className="group-row scr-env-opt"
                aria-expanded={varsOpen}
                data-testid="new-env-vars"
                onClick={() => {
                  // A field with a problem stays open, so the line that keeps Use this folder off stays in view.
                  const open = !varsOpen || varsBad;
                  setVarsOpen(open);
                  // A laptop's field takes the focus; a touch keyboard stays down until the field is tapped.
                  if (open && !touch) requestAnimationFrame(() => varsField.current?.focus({ preventScroll: true }));
                }}
              >
                <span className="group-label">{ENV_WORDS.title}</span>
                {/* The lines that pass; while a line has a problem, no count (its line under the field says which). */}
                {varsBad ? null : <span className="group-value">{vars.set.length ? countWords(vars.set.length) : ENV_WORDS.none}</span>}
                <IconChevron className="group-chevron scr-env-fold" />
              </button>
              {varsOpen ? (
                <div className="scr-env-varsbox">
                  <VarsField text={varsText} onText={setVarsText} read={vars} fieldRef={varsField} />
                  {varsRefused ? (
                    <ul className="env-notes" role="alert">
                      {varsRefused.map((l, i) => (
                        <li key={i} className="env-note is-bad">
                          {l}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="env-actions">
                    <button type="button" className="btn" disabled={varsBad} onClick={() => setVarsOpen(false)}>
                      {ENV_WORDS.done}
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          </ul>
        )}
      </div>
      {line ? (
        <p className="scr-dlg-error scr-env-error" role="alert">
          {line}
        </p>
      ) : null}
      <div className="dialog-actions">
        {!sheet ? (
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        ) : null}
        <button type="button" className="btn primary" data-testid="confirm-use-folder" disabled={useOff} title={target ? tilde(target, home) : undefined} onClick={use}>
          {USE_FOLDER}
        </button>
      </div>
    </div>
  );
}
