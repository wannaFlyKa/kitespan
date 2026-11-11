// The new-chat form (DESIGN.md 6.9): the greeting, the prompt box and the row under it, as in Desktop: the project
// folder (its picker also holds New environment..., D54), the mode and the model (with effort), then Start. Home shows it with
// the project's remembered picks; /new fills it from the URL and waits for Start (5.1 rule 3: a link never acts by
// itself). Start sends one `new_chat` frame with only the user's own picks (null for one left out) and the form's
// uploads (act.newChat); the server remembers the picks for the project, except Plan, and new chats start with them
// while Settings > Chats > New chats start with is "My last choice here" (6.8). No agent line: kitespan is for Claude Code
// only (row 117).
// The look (plan v3): the greeting is the page's large title; the prompt box is a card in the composer's tokens, because
// it is the composer of a chat that does not exist yet; the pickers are pills; Start is the primary button. On a laptop
// and a tablet a picker is a menu; on the phone it is a sheet of grouped lists (.group on the grouped surface).
// The model rows are Claude Code's own list as the server keeps it (row 81; the same list in every chat and project):
// the form reads them when it shows a project (GET /api/projects/:project/models, beside the / menu's read, so a short
// read the server needs serves both) and again when the model picker opens while none is known; until they come the
// picker offers the Default row. A picker shows a
// head line only when it changes what a pick does: "Picked here; new chats in <project> start with it" (6.6).
// Files (D37, D50): files dropped on the form, pasted into the prompt or picked with Add files or photos (the + button,
// as in the composer) become attachment chips in the card, with no path in the prompt; Start sends their ids and the
// server adds the references to the first message. A paste follows the composer's rule (composer/attach.ts): text
// wins, and a nameless pasted image is named pasted.<type>. The chat does not exist yet: each drop, paste or pick is
// one act.uploadForNewChat for the session the chat will have, the uploads wait in the store under that session's key,
// and Start (act.newChat with the session) moves them to the new chat.
// The draft (D49's open point 4: per device): the form's session, prompt, project and picks are kept in this device's
// local storage until Start, so a user who leaves Home or /new and comes back (a chat, then New chat, Back, or a
// reload) finds the same prompt. A link names what it sets: its project and picks win each time it opens, its text
// once (Back to the same link keeps the user's edits). Start ends the draft. The draft is view state, never recorded.
// The prompt box is a chat's composer (D59, DECISIONS-OWNER row 75; composer/useFormBox.ts): "/" in the empty field
// opens the / menu over the project's commands (GET /api/projects/:project/commands, read when the form shows the
// project and once more about 3 s later while the server has none yet) and a pick is the command chip, whose command
// with its arguments is the first message; "/" mid-line opens the same rows as text (D57); "@" (or the @ button on
// touch) opens the picker over the project's folder (the project corpus routes), and a pick is a mention chip that
// Start sends in the new_chat frame (paths relative to the project's folder; the server checks and references them as
// a send's). The same keys, the IME guard, the same menus and chips, on every size; a "!" stays text (a chat starts
// with a message). The chip and the mentions are the draft's too; the mentions belong to their project, and a link's
// text still only pre-fills, as plain text (/new?text=/x is the text "/x"). The chip and the field share one line
// (row 76; composer.css .cmp-line).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { LIMITS, mentionsOf } from "../../shared/protocol";
import { href, navigate } from "../router";
import { act, newChatUploadsKey, newSessionId, NO_UPLOADS, uploadRoot, uploadRootLabel, useStore, type KeyValueStore } from "../state/store";
import { EFFORTS } from "../state/catalog";
import type { ModeId, Picks } from "../state/types";
import { useViewport } from "../layout/size";
import { Popup } from "../ui/primitives";
import { AttachChip, DropOverlay, filesFrom, hasFiles, useFileDrop, type FileFacts } from "../ui/files";
import { IconCheck, IconChevron, IconFolder, IconPlus } from "../ui/icons";
import { ModeList, listKeys } from "../composer/lists";
import { clipboardFiles, mentionChipsOf, pastedFacts } from "../composer/attach";
import { MentionChip } from "../composer/Chip";
import { findCommand, menuRowsOf, type Draft } from "../composer/draft";
import { COMMANDS_AGAIN_MS, asksAgain, formCanStart, formStartText, withPath } from "../composer/formBox";
import { useCoarse } from "../composer/keyboard";
import { AtButton, MentionMenu } from "../composer/MentionMenu";
import { SlashMenu } from "../composer/SlashMenu";
import { useFormBox } from "../composer/useFormBox";
import { ExternalLinkLine } from "../composer/ExternalLinkLine";
import { MinimumWords, useClaudeFacts } from "../panels/parts";
import { EffortBars } from "../composer/icons";
import { effortLevel } from "../composer/labels";
import { NewEnvironmentDialog } from "../dialogs/NewEnvironment";
import { askModelRows, byLastUse, effortLabel, effortsOf, modeLabel, modelLabel, useModelRows, useModelRowsFor, usePopupFocus, usePopupRows } from "./common";
import { WORKTREE_WORDS } from "../worktree/worktree";
import { formSideLine } from "../side/btw";

export interface FormInit {
  project?: string;
  model?: string;
  effort?: string;
  mode?: ModeId;
  text?: string;
}

type Picker = "project" | "model" | "mode";

/** The form's draft: the session its uploads wait under, the prompt, the project and picks made here, and the text of
 *  the last link it took (a link fills its text once). One per device; Start ends it. D59: the / mode and its command
 *  chip (`text` is then the filter, or the command's arguments), and the mention chips with the project they are in. */
export interface FormDraft {
  session: string;
  text: string;
  fromLink: boolean;
  projectId?: string;
  picked: Picks;
  linkText?: string;
  mode?: "slash";
  command?: string;
  mentions?: { project: string; paths: string[] };
}

/** The local storage key of the form's draft on this device. */
export const FORM_DRAFT_KEY = "kitespan.newchat";

function storage(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The draft this device kept, or null (none, or not readable). */
export function readFormDraft(kv: KeyValueStore | null = storage()): FormDraft | null {
  try {
    const raw = kv?.getItem(FORM_DRAFT_KEY);
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (!v || typeof v.session !== "string" || typeof v.text !== "string") return null;
    const p = (v.picked ?? {}) as Record<string, unknown>;
    const mode = str(p.mode) as ModeId | undefined;
    const slash = v.mode === "slash";
    const m = (v.mentions ?? null) as { project?: unknown; paths?: unknown } | null;
    const paths = m && typeof m.project === "string" ? mentionsOf(m.paths, LIMITS.sendMentions) : null;
    return {
      session: v.session,
      text: v.text,
      fromLink: v.fromLink === true,
      projectId: str(v.projectId),
      picked: { model: str(p.model), effort: str(p.effort), mode },
      linkText: str(v.linkText),
      mode: slash ? "slash" : undefined,
      command: slash ? str(v.command) || undefined : undefined,
      mentions: paths?.length ? { project: m!.project as string, paths } : undefined,
    };
  } catch {
    return null;
  }
}

export function writeFormDraft(d: FormDraft, kv: KeyValueStore | null = storage()) {
  try {
    kv?.setItem(FORM_DRAFT_KEY, JSON.stringify(d));
  } catch {} // full or blocked storage: the draft stays in memory
}

export function clearFormDraft(kv: KeyValueStore | null = storage()) {
  try {
    kv?.removeItem(FORM_DRAFT_KEY);
  } catch {}
}

let DRAFT: FormDraft | null = null;
function formDraft(): FormDraft {
  DRAFT ??= readFormDraft() ?? { session: newSessionId(), text: "", fromLink: false, picked: {} };
  return DRAFT;
}

/**
 * The draft as this mount opens it: what the link names wins; the text of a link not taken yet replaces the prompt,
 * as plain text (no chip). Mention chips stay while the project is theirs.
 */
export function opened(d: FormDraft, init: FormInit): FormDraft {
  const picked: Picks = { model: init.model ?? d.picked.model, effort: init.effort ?? d.picked.effort, mode: init.mode ?? d.picked.mode };
  const mentions = d.mentions && (!init.project || init.project === d.mentions.project) ? d.mentions : undefined;
  const next: FormDraft = { ...d, projectId: init.project ?? d.projectId, picked, mentions };
  if (!init.text || init.text === d.linkText) return next;
  return { ...next, text: init.text, fromLink: true, linkText: init.text, mode: undefined, command: undefined };
}

/** The box's draft (the composer's Draft) from the form's. */
function boxDraft(f: FormDraft): Draft {
  return f.mode === "slash" ? { mode: "slash", command: f.command ?? null, text: f.text, fromLink: false } : { mode: "chat", command: null, text: f.text, fromLink: f.fromLink };
}

const NO_PATHS: readonly string[] = Object.freeze([]);

/** The form's Effort rows, as a chat's (composer/lists.tsx EffortList withDefault): Default first, then the model's levels. */
export function formEffortRows(levels: readonly string[]): { id: string; label: string }[] {
  return [{ id: "default", label: "Default" }, ...EFFORTS.filter((e) => levels.includes(e.id)).map((e) => ({ id: e.id, label: e.label }))];
}

/**
 * The level the chat starts with (undefined: none of the form's own, so Start sends none) and the row its picker
 * checks: the level picked here, else the project's remembered one, when the model has it; else Default.
 */
export function formEffort(picked: Picks, remembered: Picks, levels: readonly string[]): { effort: string | undefined; checked: string } {
  const want = picked.effort ?? remembered.effort;
  const effort = want && levels.includes(want) ? want : undefined;
  return { effort, checked: effort ?? "default" };
}

/** A pick in the form's Effort list: a level, or Default, which clears the form's own level. */
export function effortPick(id: string): string | undefined {
  return id === "default" ? undefined : id;
}

/** A model or effort list: rows only, a check on the current one (the caller's Popup holds it; a pick fills the form). */
function PickList({ label, grouped, items, value, onPick }: { label: string; grouped: boolean; items: { id: string; label: string; hint?: string }[]; value: string; onPick: (id: string) => void }) {
  const stop = items.some((i) => i.id === value) ? value : items[0]?.id;
  return (
    <div className={grouped ? "group scr-pick-group" : "scr-pick-list"} role="menu" aria-label={label} onKeyDown={listKeys}>
      {items.map((m) => (
        <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === value} tabIndex={m.id === stop ? 0 : -1} data-value={m.id} className={grouped ? "group-row" : "menu-row"} onClick={() => onPick(m.id)}>
          <span className="scr-pick-text">
            <span className="scr-pick-name">{m.label}</span>
            {m.hint ? <span className="row-hint">{m.hint}</span> : null}
          </span>
          <IconCheck className={grouped ? "group-check" : "menu-check"} />
        </button>
      ))}
    </div>
  );
}

/**
 * Under the box, below kitespan's minimum Claude Code version (rows 118, 119): the one line that Settings > Claude Code
 * shows too, in the form's under-box look. It is no control and never holds Start: a chat still starts.
 */
function ClaudeMinimumLine() {
  const { belowMinimum } = useClaudeFacts();
  if (!belowMinimum) return null;
  return (
    <p className="cmp-ext" role="note" data-testid="form-claude-minimum">
      <MinimumWords below={belowMinimum} />
    </p>
  );
}

export function NewChatForm({ init, autoFocus }: { init: FormInit; autoFocus: boolean }) {
  const projects = useStore((s) => s.projects);
  const chats = useStore((s) => s.chats);
  const allowBypass = useStore((s) => s.settings.allowBypass);
  const returnKey = useStore((s) => s.settings.returnKey);
  const sideOn = useStore((s) => s.sideQuestions);
  const startsWithLast = useStore((s) => s.settings.newChats === "last");
  const uploadFolder = useStore((s) => s.settings.uploadFolder);
  const customFolder = useStore((s) => s.settings.customFolder);
  const models = useModelRows();
  // The session the chat will have: Claude Code's uploads folder is per session (~/.claude/uploads/<session>/), and
  // the form's uploads wait in the store under it until Start. It is the draft's, so it outlives this mount.
  const [session] = useState(() => formDraft().session);
  const uploadsKey = newChatUploadsKey(session);
  const uploads = useStore((s) => s.uploads[uploadsKey] ?? NO_UPLOADS);
  const [first] = useState(() => opened(formDraft(), init));
  const vp = useViewport();
  const phone = vp.size === "phone";
  const ordered = useMemo(() => byLastUse(projects, chats), [projects, chats]);
  const [projectId, setProjectId] = useState(first.projectId);
  // The user's own picks in this form (or from the link); a key left out falls back to the project's remembered pick.
  const [picked, setPicked] = useState<Picks>(first.picked);
  // The box's draft (the composer's: Chat mode, or the / mode with its chip) and its mention chips with their project.
  const [d, setD] = useState<Draft>(() => boxDraft(first));
  const [mentions, setMentions] = useState<{ project: string; paths: readonly string[] } | null>(first.mentions ?? null);
  // The draft follows the form, so the next mount (or a reload) opens where this one was left; Start ends it (ended).
  const ended = useRef(false);
  useEffect(() => {
    if (ended.current) return;
    const slash = d.mode === "slash";
    const kept = mentions?.paths.length ? { project: mentions.project, paths: [...mentions.paths] } : undefined;
    DRAFT = { session, text: d.text, fromLink: d.fromLink, projectId, picked, linkText: first.linkText, mode: slash ? "slash" : undefined, command: slash ? (d.command ?? undefined) : undefined, mentions: kept };
    writeFormDraft(DRAFT);
  }, [d, projectId, picked, mentions]);
  const [open, setOpen] = useState<Picker | null>(null);
  const [adding, setAdding] = useState(false); // the New environment dialog
  const field = useRef<HTMLTextAreaElement>(null);
  const startBtn = useRef<HTMLButtonElement>(null);
  const attachRow = useRef<HTMLDivElement>(null);
  const projectRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const modeRef = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const startNow = useRef<() => void>(() => {});
  const [pathOf, setPathOf] = useState<string | null>(null); // the mention chip whose path shows

  usePopupFocus(open === "project", "form-picker-project", projectRef);
  usePopupFocus(open === "model", "form-picker-model", modelRef);
  usePopupFocus(open === "mode", "form-picker-mode", modeRef);

  const project = projects.find((p) => p.id === projectId) ?? ordered[0];
  const stored: Picks = project?.picks ?? {};
  const remembered: Picks = startsWithLast ? stored : {}; // "My Claude Code defaults" starts every chat without them
  const model = picked.model ?? remembered.model;
  // A remembered or linked model shows by its name: the rows are read once when the page has none for it yet.
  useModelRowsFor(model, project?.id);
  const levels = effortsOf(model, models);
  const { effort, checked: effortChecked } = formEffort(picked, remembered, levels);
  const wantMode = picked.mode ?? remembered.mode;
  const mode = wantMode === "bypassPermissions" && !allowBypass ? undefined : wantMode;
  const hasStored = Boolean(stored.model || stored.effort || stored.mode);
  const rows = usePopupRows();
  const sheet = rows.sheet; // Popup draws a bottom sheet there
  const folder = uploadRootLabel(uploadRoot({ uploadFolder, customFolder }, session));

  // The / menu's rows (D59): the project's commands, read when the form shows the project, and once more about 3 s
  // later while the server has none yet (its first read runs or failed: an empty list with no `at`).
  const coarse = useCoarse();
  const projectKey = project?.id ?? null;
  const commandsRead = useStore((s) => (projectKey ? s.projectCommands[projectKey] : undefined));
  const commandRows = useMemo(() => menuRowsOf({ commands: commandsRead?.commands ?? null }), [commandsRead]);
  useEffect(() => {
    if (projectKey) void act.loadProjectCommands(projectKey);
  }, [projectKey]);
  // Row 81: the model rows, read with the commands, so the picker and a remembered model show Claude Code's names.
  useEffect(() => {
    if (projectKey) askModelRows(projectKey);
  }, [projectKey]);
  const askedAgain = useRef(new Set<string>());
  useEffect(() => {
    if (!projectKey || !asksAgain(commandsRead) || askedAgain.current.has(projectKey)) return;
    askedAgain.current.add(projectKey);
    let fired = false;
    const t = setTimeout(() => {
      fired = true;
      void act.loadProjectCommands(projectKey);
    }, COMMANDS_AGAIN_MS);
    return () => {
      clearTimeout(t);
      if (!fired) askedAgain.current.delete(projectKey);
    };
  }, [projectKey, commandsRead]);
  // The mention chips of the project shown: paths relative to its folder.
  const shownMentions = mentions && projectKey && mentions.project === projectKey ? mentions.paths : NO_PATHS;
  const mentionChips = useMemo(() => mentionChipsOf(shownMentions, project?.folder), [shownMentions, project?.folder]);
  const promptBox = useFormBox({
    d,
    setDraft: setD,
    rows: commandRows,
    project: projectKey,
    coarse,
    returnKey,
    field,
    box: boxRef,
    onMention: (path) => {
      if (!projectKey) return;
      setMentions((m) => {
        const next = withPath(m && m.project === projectKey ? m.paths : NO_PATHS, path);
        return next ? { project: projectKey, paths: next } : m;
      });
    },
    onStart: () => startNow.current(),
    onRowsWanted: () => {
      if (projectKey) void act.loadProjectCommands(projectKey);
    },
  });

  // An action route pre-fills and focuses: with text from a link, focus goes to Start (DESIGN.md 5.3); otherwise the
  // field takes focus on a laptop only, so a touch keyboard stays down until the user taps the field. The caret goes
  // after a kept prompt, where the user left off.
  useEffect(() => {
    const el = field.current;
    if (init.text) startBtn.current?.focus();
    else if (autoFocus && !vp.touch && el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);
  // The field grows with its text up to its CSS max-height, then scrolls.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [d.text, d.mode, d.command, vp.width]);
  // New chips come in at the end of the chip row, which scrolls past two rows (W19d, as a chat's box): bring the end
  // into view so the file just picked or added shows.
  const chipTotal = uploads.length + mentionChips.length;
  const chipCount = useRef(chipTotal);
  useLayoutEffect(() => {
    const row = attachRow.current;
    if (row && chipTotal > chipCount.current) row.scrollTop = row.scrollHeight;
    chipCount.current = chipTotal;
  }, [chipTotal]);

  // Files: called only from a drop, a paste or the file input's change, never from a render or an effect. Each file is
  // one upload (recorded: it writes on the host) and one chip; the prompt holds no path (D50).
  const addFiles = (files: FileFacts[]) => {
    if (files.length) act.uploadForNewChat(session, files, project?.id);
  };
  const drop = useFileDrop(addFiles);
  // A file dropped elsewhere on the page (Recent, the sidebar) would make the browser open it and leave the app: while
  // the form is shown, such a drop comes to the form too. The form's own drop stops before it reaches the window, and
  // App's guard may prevent the default first, so the default is not a sign that someone took the files.
  const addLatest = useRef(addFiles);
  addLatest.current = addFiles;
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const dropped = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      addLatest.current(filesFrom(e.dataTransfer?.files));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", dropped);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", dropped);
    };
  }, []);
  // The composer's rule: a paste that carries text goes into the field as typed, even with an image beside it (cells
  // copied from a spreadsheet carry both); only a paste of files alone uploads.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    addFiles(pastedFacts(filesFrom(files)));
  };

  // W3: Start is off from the press until the server's ack, which in a worktree project comes after git checked the
  // worktree out; there, one step line takes Start's place meanwhile (DESIGN 6.9).
  const starting = useStore((s) => s.newChatOut.length > 0);
  const making = starting && project?.worktree === true && !project.worktreeOff;

  // A first start has no project yet: the one thing to do is to pick the machine's folder (D54), so the form is that
  // button, and the sheet opens from it; the new project is then selected and the full form shows.
  if (!project)
    return (
      <>
        <div className="scr-first-env">
          <button type="button" className="btn primary" data-testid="new-environment-first" onClick={() => setAdding(true)}>
            New environment…
          </button>
        </div>
        {adding ? (
          <NewEnvironmentDialog
            onClose={() => setAdding(false)}
            onAdded={(id) => {
              setAdding(false);
              setProjectId(id);
            }}
          />
        ) : null}
      </>
    );
  const close = () => setOpen(null);
  // The chip takes the focus first, so the picker gives it back there however it was pressed (Safari focuses no button
  // on a click, and a script's click presses nothing).
  const toggle = (p: Picker, chip: HTMLElement) => {
    chip.focus({ preventScroll: true });
    setOpen((o) => (o === p ? null : p));
    // The model rows are Claude Code's: one read when the picker opens and the page knows none yet (a read, 5.5).
    if (p === "model" && open !== "model" && models.length <= 1) askModelRows(project.id);
  };
  // Start sends the box as a chat's Send would (D59): the message, or the command chip's command with its arguments as
  // the first message, with the mention chips of this project; in Chat mode files alone may start a chat (W19d).
  const message = formStartText(d);
  const busy = uploads.some((u) => u.state === "uploading");
  const canStart = formCanStart(d, { uploads: uploads.filter((u) => u.state === "done").length, mentions: shownMentions.length }, busy);
  const start = () => {
    if (!canStart || starting) return;
    // R124: a side question needs a chat to ask about: a first message that is /btw sends nothing, and the line says
    // what to do (the box keeps the text).
    const sideLine = formSideLine(message, sideOn);
    if (sideLine) return act.setNotice(sideLine, null);
    void act.newChat({ projectId: project.id, model, effort, mode, text: message, sessionId: session, mentions: shownMentions }).then((id) => {
      if (!id) {
        // A refusal: Start is back in the step line's place, and takes the focus back if the step line had it.
        if (making) requestAnimationFrame(() => startBtn.current?.focus({ preventScroll: true }));
        return;
      }
      // The chat took the session and the uploads: the next form starts a new draft.
      ended.current = true;
      DRAFT = null;
      clearFormDraft();
      // The chat exists only after Start; replaceState, so Back does not return to the filled form (DESIGN.md 6.9).
      navigate(href("chat", { chat: id }), { replace: true });
    });
  };
  startNow.current = start;
  const removeMention = (path: string) => {
    if (pathOf === path) setPathOf(null);
    setMentions((m) => (m ? { project: m.project, paths: m.paths.filter((p) => p !== path) } : m));
    if (!coarse) requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
  };
  const chipPath = pathOf ? mentionChips.find((m) => m.path === pathOf) : undefined;
  const menuId = "form-slash";
  const mentionId = "form-mention";
  const pathId = "form-chip-path";
  const aria = promptBox.aria({ menu: menuId, mention: mentionId });
  const cmd = d.command ? findCommand(d.command, commandRows) : undefined;
  // The command chip (the composer's look; row 76: cut with an ellipsis, the whole name in its title).
  const chip =
    d.mode === "slash" ? (
      <span className="cmp-chip is-slash" aria-hidden="true" title={d.command ? `/${d.command}` : undefined}>
        <span className="cmp-chip-name">/{d.command ?? ""}</span>
      </span>
    ) : null;
  const atButton = coarse && d.mode === "chat" ? <AtButton open={promptBox.mentionShown} onOpen={promptBox.openAt} onClose={promptBox.closeMention} /> : null;
  // The picker's one head line (6.6, D51), only when it changes what a pick does: a pick made here is remembered for
  // the project at Start, except Plan, while Settings > Chats > New chats start with is "My last choice here".
  const headLine = (kind: "model" | "mode"): string | null => {
    const here = kind === "model" ? picked.model !== undefined || picked.effort !== undefined : picked.mode !== undefined;
    if (!here || !startsWithLast || (kind === "mode" && mode === "plan")) return null;
    return `Picked here; new chats in ${project.name} start with it`;
  };
  const forget = hasStored ? (
    <button type="button" className={`btn ${sheet ? "scr-sheet-btn" : "ghost"} scr-pick-forget`} data-testid="confirm-forget" onClick={() => act.forgetPicks(project.id)}>
      Forget for {project.name}
    </button>
  ) : null;
  // A row of a picker: a menu row in a laptop menu, a grouped-list row in a sheet.
  const { box, list, row, check, label } = rows;
  const head = sheet ? "group-title scr-pick-head" : "scr-pick-head";
  const modelHead = headLine("model");
  const modeHead = headLine("mode");

  // The folder, mode and model pills: in the row under the prompt on a laptop and a tablet; on the phone one row above
  // the card, as the phone composer's picker row (DESIGN.md 7.5), that scrolls sideways when the labels are long.
  const chips = (
    <div className="scr-chips" role="group" aria-label="Chat settings">
      <button ref={projectRef} type="button" className="chip scr-chip" data-pick="project" aria-haspopup="dialog" aria-expanded={open === "project"} onClick={(e) => toggle("project", e.currentTarget)}>
        <IconFolder />
        <span className="scr-chip-text">{project.name}</span>
        <IconChevron className="scr-chip-caret" />
      </button>
      <button ref={modeRef} type="button" className={`chip scr-chip${mode === "bypassPermissions" ? " scr-chip-warn" : ""}`} data-pick="mode" aria-haspopup="dialog" aria-expanded={open === "mode"} onClick={(e) => toggle("mode", e.currentTarget)}>
        <span className="scr-chip-text">{mode ? modeLabel(mode) : "Mode"}</span>
        <IconChevron className="scr-chip-caret" />
      </button>
      <button ref={modelRef} type="button" className="chip scr-chip" data-pick="model" aria-haspopup="dialog" aria-expanded={open === "model"} onClick={(e) => toggle("model", e.currentTarget)}>
        <span className="scr-chip-text">{model ? modelLabel(model, models) : "Model"}</span>
        {effort ? (
          <span className="scr-chip-sub scr-chip-effort">
            <EffortBars level={effortLevel(effort)} />
            {effortLabel(effort)}
          </span>
        ) : null}
        <IconChevron className="scr-chip-caret" />
      </button>
    </div>
  );

  return (
    <>
      <form
        className="scr-form"
        data-testid="new-chat"
        data-drop={drop.over ? "over" : undefined}
        onDragEnterCapture={drop.handlers.onDragEnter}
        onDragOverCapture={drop.handlers.onDragOver}
        onDragLeaveCapture={drop.handlers.onDragLeave}
        onDropCapture={drop.handlers.onDrop}
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <h1 className="scr-greeting">What should we work on in {project.name}?</h1>
        {phone ? chips : null}
        <div className="scr-box" ref={boxRef} data-mode={d.mode}>
          {/* The composer's menus (D59), under the box when it leaves room (it is near the top of the page). */}
          {promptBox.menuVisible ? (
            <SlashMenu id={menuId} rows={promptBox.menuRows} active={promptBox.active} filter={promptBox.menuFilter} below={promptBox.side.below} maxHeight={promptBox.side.maxHeight} onPick={promptBox.pick} onHover={promptBox.setActive} onClose={promptBox.closeMenu} />
          ) : null}
          {promptBox.mentionShown ? (
            <MentionMenu id={mentionId} rows={promptBox.fileRows} active={promptBox.mentionAt} below={promptBox.side.below} maxHeight={promptBox.side.maxHeight} onPick={promptBox.pickMention} onHover={promptBox.setMentionActive} onClose={promptBox.closeMention} />
          ) : null}
          {promptBox.slashShown ? (
            <SlashMenu id={menuId} rows={promptBox.slashRows} active={promptBox.slashAt} filter={promptBox.slashFilter} inText below={promptBox.side.below} maxHeight={promptBox.side.maxHeight} onPick={promptBox.pickSlash} onHover={promptBox.setSlashActive} onClose={promptBox.closeSlash} />
          ) : null}
          {uploads.length || mentionChips.length ? (
            <div ref={attachRow} className="scr-attachments" aria-label="Attachments" role="group">
              {uploads.map((u) => (
                <AttachChip
                  key={u.id}
                  upload={u}
                  onRemove={() => {
                    act.removeUpload(uploadsKey, u.id);
                    field.current?.focus({ preventScroll: true });
                  }}
                />
              ))}
              {mentionChips.map((m) => (
                <MentionChip key={`mention:${m.path}`} mention={m} open={pathOf === m.path} pathId={pathId} onToggle={() => setPathOf((p) => (p === m.path ? null : m.path))} onRemove={() => removeMention(m.path)} />
              ))}
            </div>
          ) : null}
          {chipPath ? (
            <p className="cmp-chip-path" id={pathId} data-testid="form-chip-path">
              {chipPath.abs ?? chipPath.path}
            </p>
          ) : null}
          <label className="visually-hidden" htmlFor="scr-prompt">
            Prompt
          </label>
          <div className="cmp-line scr-line">
            {chip}
            <textarea
              id="scr-prompt"
              ref={field}
              className="scr-prompt"
              rows={3}
              value={d.text}
              placeholder={d.mode === "slash" ? (d.command ? (cmd?.args ?? "") : "Filter commands") : "Describe a task or ask a question"}
              aria-label={d.mode === "slash" ? (d.command ? `Arguments for /${d.command}` : "Command") : undefined}
              aria-controls={aria.controls}
              aria-activedescendant={aria.activedescendant}
              enterKeyHint={coarse && returnKey === "newline" ? "enter" : "send"}
              autoCapitalize={d.mode === "chat" ? "sentences" : "off"}
              autoComplete="off"
              spellCheck
              onPaste={onPaste}
              onChange={(e) => promptBox.onChange(e.target.value)}
              onSelect={promptBox.onSelect}
              onKeyDown={promptBox.onKeyDown}
            />
          </div>
          <div className="scr-box-row">
            {/* The composer's + button and Desktop's prompt box: here it opens the file picker at once (the / commands
                are the "/" typed in the field). On touch, the @ button beside it (7.5), as in a chat. */}
            <button type="button" className="icon-btn scr-attach" aria-label="Add files or photos" title="Add files or photos" onClick={() => picker.current?.click()}>
              <IconPlus size={18} />
            </button>
            {atButton}
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              data-testid="new-chat-files"
              onChange={(e) => {
                addFiles(filesFrom(e.currentTarget.files));
                e.currentTarget.value = ""; // the same file again is a new upload
              }}
            />
            {phone ? null : chips}
            {making ? (
              <span className="scr-start scr-start-step" role="status" data-testid="start-step">
                {WORKTREE_WORDS.making}
              </span>
            ) : (
              <button ref={startBtn} type="submit" className="btn primary scr-start" data-testid="confirm-start" disabled={!canStart || starting} aria-busy={starting || undefined}>
                Start
              </button>
            )}
          </div>
          {drop.over ? <DropOverlay folder={folder} /> : null}
        </div>
        <ExternalLinkLine text={d.fromLink ? d.text : ""} />
        <ClaudeMinimumLine />

        <Popup open={open === "project"} onClose={close} anchor={projectRef} title="Project folder" wide testId="form-picker-project">
          <div className={box}>
            <div className={list} role="group" aria-label="Projects">
              {ordered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={p.id === project.id}
                  className={row}
                  onClick={() => {
                    if (p.id !== project.id) setMentions(null); // a mention is a file of its project's folder
                    setProjectId(p.id);
                    close();
                  }}
                >
                  <IconFolder className="scr-pick-icon" />
                  <span className="scr-pick-text">
                    <span className="scr-pick-name">{p.name}</span>
                    <span className="row-hint mono">{p.folder}</span>
                  </span>
                  <IconCheck className={check} />
                </button>
              ))}
              <button
                type="button"
                className={row}
                data-testid="form-new-environment"
                onClick={() => {
                  close();
                  setAdding(true);
                }}
              >
                <IconPlus className="scr-pick-icon" />
                <span className="scr-pick-text">New environment…</span>
              </button>
            </div>
          </div>
        </Popup>

        <Popup open={open === "model"} onClose={close} anchor={modelRef} title="Model" wide testId="form-picker-model">
          <div className={box}>
            {modelHead ? <p className={head}>{modelHead}</p> : null}
            <PickList
              label="Model"
              grouped={sheet}
              items={models.map((m) => ({ id: m.id, label: m.label, hint: m.hint }))}
              value={model ?? "default"}
              onPick={(id) => setPicked((p) => ({ ...p, model: id, effort: p.effort && effortsOf(id, models).includes(p.effort) ? p.effort : undefined }))}
            />
            {!sheet ? <hr className="menu-sep" /> : null}
            <p className={label}>Effort</p>
            <PickList
              label="Effort"
              grouped={sheet}
              items={formEffortRows(levels)}
              value={effortChecked}
              onPick={(id) => {
                setPicked((p) => ({ ...p, effort: effortPick(id) }));
                close();
              }}
            />
            {forget}
          </div>
        </Popup>

        <Popup open={open === "mode"} onClose={close} anchor={modeRef} title="Permission mode" wide testId="form-picker-mode">
          <div className={box}>
            {modeHead ? <p className={head}>{modeHead}</p> : null}
            <ModeList
              value={mode ?? ""}
              allowBypass={allowBypass}
              grouped={sheet}
              onPick={(id) => {
                setPicked((p) => ({ ...p, mode: id as ModeId }));
                close();
              }}
            />
            {forget}
          </div>
        </Popup>
      </form>
      {/* Outside the form: React sends a portal's events up its own tree, and a submit there must not start a chat. */}
      {adding ? (
        <NewEnvironmentDialog
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false);
            setProjectId(id);
          }}
        />
      ) : null}
    </>
  );
}
