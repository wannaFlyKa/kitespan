// The chat's dialogs (DESIGN.md 6.10 and 5.3), each opened by its own path: rename (a sheet on the phone; the title
// bar draws the field in place elsewhere), archive and delete (D48), the Stop confirm and Copy the command, the
// fallback of the Terminal pane (D38) for a terminal of the user's own, with End it here and copy while the chat's
// Claude Code lives (endHere.ts). A centred dialog on a laptop and a medium
// touch device, a bottom sheet on a phone; each closes back to the page that opened it: a chat list row's Rename and
// Delete back to the list (or Home, a project page, another chat), else the chat's path (dialogParent); Copy the
// command, opened from the pane, closes back to the pane. v0.6 touch: Open on phone (OpenOnPhone.tsx), which closes
// back to the page that it holds the code of.
// Opening one acts on nothing: only its named button does (5.1 rule 3). The buttons are fills (plan v3): Cancel the
// secondary one, the action primary (Delete in --danger-fill); in the phone's sheet the top-right word closes it, so
// only the action shows: Done, or Cancel on the Archive, Delete and Stop confirms (7.6, E5) and on the rename sheet,
// where Done beside Save, and the keyboard's own "done" that saves, would read as "save it".
// Archive (/c/<chat>/archive): the chat's title, Cancel (D53: on every size, at the top right of the phone's sheet)
// and the action, Archive, Stop and archive while its Claude Code is busy, or Unarchive for an archived chat. Archive
// and Delete send their frame and the page leaves the chat at once (/ with replaceState, 6.10); no notice line
// follows. Every other page of a deleted chat gets `gone` and shows Home with the 5.4 line (ChatScreen), and an
// archived chat's other pages turn read-only (the composer's Unarchive bar). Unarchive, Stop and Rename's Save close
// the dialog on the server's ok ack only; a refusal keeps it, with the line (useAckClose). On Archive, Delete,
// Unarchive, Stop, Save and End it here, a double press is one press (ui/secondPress).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { closeTo, navigate, type Route } from "../router";
import { act, useStore } from "../state/store";
import type { Chat } from "../state/types";
import { useViewport } from "../layout/size";
import { COPY_FAILED, COPY_HINT, useCopy } from "../ui/Copy";
import { useAckClose } from "./ackClose";
import { CancelSheet, Modal, useModalSheet } from "./Modal";
import { RenameForm } from "./RenameForm";
import { archiveItem, dialogParent, pressArchive } from "../screens/common";
import { resumeCommand } from "../terminal/command";
import { shellBehind } from "../terminal/route";
import { END_HERE_WORDS, endHereClick, endHereLine, plainResume } from "./endHere";
import { archiveKeepsLine, chatFolder, deleteFacts, ownWorktree, sharedWorktree, type WorktreeStatus } from "../worktree/worktree";
import { readWorktreeStatus } from "../worktree/api";
import { WithPath } from "../worktree/PathText";
import { ENV_WORDS } from "../env/vars";
import { TrustDialog } from "./TrustDialog";
import { OpenOnPhone } from "./OpenOnPhone";
import { swallowSecondPress } from "../ui/secondPress";
import { readingOrder } from "../ui/primitives";

/**
 * Row 73: a worktree chat's changes, read once when its Archive or Delete dialog opens (a GET), so the dialog can name
 * them (L25, L26): only for kitespan's own worktree (W12: a terminal session's linked one is never removed), and only
 * when `want`. `undefined` while it reads; null when it could not, or when nothing was read.
 */
function useWorktreeStatus(chat: Chat, want = true): WorktreeStatus | null | undefined {
  const [status, setStatus] = useState<WorktreeStatus | null | undefined>(undefined);
  const has = want && ownWorktree(chat.worktree);
  useEffect(() => {
    if (!has) return;
    let live = true;
    void readWorktreeStatus(chat.id).then((r) => {
      if (live) setStatus(r);
    });
    return () => {
      live = false;
    };
  }, [chat.id, has]);
  return has ? status : null;
}

/** The delete confirm's one line (DESIGN.md 6.10, D48: a real delete, the transcript too). */
export const DELETE_LINE = "This can't be undone.";

export function ChatDialogs({ chat, route }: { chat: Chat; route: Route }) {
  const vp = useViewport();
  const close = () => closeTo(dialogParent(chat.id, route));
  switch (route.name) {
    case "rename":
      if (vp.size !== "phone") return null; // the title bar holds the field (TopBar)
      return (
        <CancelSheet title="Rename chat" testId="dialog-rename" onClose={close}>
          <RenameForm key={String(route.query.title ?? "")} chat={chat} route={route} inline={false} />
        </CancelSheet>
      );
    case "archive":
      return <ArchiveDialog chat={chat} onClose={close} />;
    case "delete":
      return <DeleteDialog chat={chat} onClose={close} />;
    case "stop":
      // An archived chat has no turn to stop: its page is the archived chat, with Unarchive in the composer's place (5.4).
      return chat.archived ? null : <StopDialog chat={chat} onClose={close} />;
    case "terminal": {
      // Opened from the Terminal pane's Copy the command, it closes back to the pane, which stays under it.
      const pane = shellBehind(chat.id);
      return <TerminalDialog chat={chat} onClose={pane ? () => closeTo(pane) : close} />;
    }
    case "trust":
      // R127: Trust this folder's confirm for a refused row (an action route: only its button sends).
      return <TrustDialog chat={chat} route={route} onClose={close} />;
    case "phone":
      return <OpenOnPhone chat={chat} route={route} />;
    default:
      return null;
  }
}

/**
 * Archive, Stop and archive or Unarchive, with Cancel beside it (D53; the phone's sheet has Cancel at the top right).
 * The action acts on its click only. Stop and archive ends a running turn, so it never holds the focus as the dialog
 * opens or as the chat turns busy: Cancel takes it (on the sheet, the dialog itself), so an Enter from a hardware
 * keyboard stops nothing.
 */
function ArchiveDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const sheet = useModalSheet();
  const item = archiveItem(chat);
  const stops = item.testId === "confirm-stop-and-archive";
  const button = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const ack = useAckClose();
  // L25: a worktree with changes or ignored files stays on disk, and Archive says so in one line (a clean one goes; its
  // branch stays).
  const status = useWorktreeStatus(chat);
  const keeps = !chat.archived && status ? archiveKeepsLine(status) : null;
  // This runs after the layer's own first focus (Dialog focuses its primary button when nothing is marked autofocus).
  useLayoutEffect(() => {
    if (!stops) return;
    const box = button.current?.closest<HTMLElement>('[role="dialog"]');
    const at = document.activeElement;
    if (box && (at === button.current || !box.contains(at))) (cancel.current ?? box).focus({ preventScroll: true });
  }, [stops]);
  return (
    <Modal title={chat.title} testId="dialog-archive" onClose={onClose} confirm>
      {keeps ? <p data-testid="worktree-archive-line">{keeps}</p> : null}
      {ack.line ? (
        <p className="notice" data-testid="dialog-notice" role="status">
          {ack.line}
        </p>
      ) : null}
      <div className="dialog-actions scr-dlg-one">
        {!sheet ? (
          <button ref={cancel} type="button" className="btn" data-autofocus={stops ? true : undefined} onClick={onClose}>
            Cancel
          </button>
        ) : null}
        <button
          ref={button}
          type="button"
          className="btn primary"
          data-testid={item.testId}
          data-autofocus={stops ? undefined : true}
          disabled={ack.waiting}
          onClick={() => {
            // Unarchive: the chat is back in the lists on the ok ack, and its page shows it as it was. Archive leaves the
            // chat at once, so a double press's second one would land on the page it goes to.
            if (chat.archived) ack.press(act.unarchive(chat.id), onClose);
            else {
              swallowSecondPress();
              pressArchive(chat, true);
            }
          }}
        >
          {item.label}
        </button>
      </div>
    </Modal>
  );
}

/** Delete this chat?: one line, then Cancel and Delete (on the phone's sheet, Cancel at the top right). */
function DeleteDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  return (
    <Modal title="Delete this chat?" testId="dialog-delete" onClose={onClose} confirm>
      <DeleteBody chat={chat} onClose={onClose} />
    </Modal>
  );
}

/**
 * Delete's body (exported for the tests). L26: the confirm of a chat whose Delete removes kitespan's own worktree names
 * it and how many files have changes, and says when its branch stays; a terminal session's linked worktree (W12) and a
 * worktree that another chat shares (L27, Continue in a copy) stay, so it names none. While the read of the changes is
 * on its way the line makes no claim about them ("...") and Delete waits; a read that failed says so, and Delete is on.
 */
export function DeleteBody({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const sheet = useModalSheet();
  const shared = useStore((s) => sharedWorktree(s.chats, chat));
  const status = useWorktreeStatus(chat, !shared);
  const facts = deleteFacts(chat.worktree, status, shared);
  return (
    <>
      <p>{DELETE_LINE}</p>
      {facts.line ? (
        <p className="wt-path-line" data-testid="worktree-delete-line" aria-busy={facts.reading || undefined}>
          <WithPath text={facts.line} path={chat.worktree?.path ?? ""} />
          {facts.reading ? <span className="scr-dim"> ...</span> : null}
        </p>
      ) : null}
      {facts.branch ? <p data-testid="worktree-branch-line">{facts.branch}</p> : null}
      <div className="dialog-actions">
        {!sheet ? (
          <button type="button" className="btn" data-autofocus onClick={onClose}>
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          className="btn primary danger"
          data-testid="confirm-delete"
          disabled={facts.reading}
          onClick={() => {
            swallowSecondPress(); // a double press's second one would land on the page it goes to
            act.remove(chat.id);
            navigate("/", { replace: true }); // DESIGN.md 6.10: after Delete the URL becomes / with replaceState
          }}
        >
          Delete
        </button>
      </div>
    </>
  );
}

function StopDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const sheet = useModalSheet();
  const ack = useAckClose();
  const active = chat.state === "running" || chat.state === "waiting";
  // M33: while a turn runs, the title and the Stop button say it all. It is a confirm then: the phone's sheet says
  // Cancel at the top right, not Done beside Stop (7.6); with nothing to stop, Done closes it.
  return (
    <Modal title="Stop Claude's response?" testId="dialog-stop" onClose={onClose} confirm={active}>
      {active ? null : <p>Claude is not working in this chat, so there is nothing to stop.</p>}
      {ack.line ? (
        <p className="notice" data-testid="dialog-notice" role="status">
          {ack.line}
        </p>
      ) : null}
      <div className="dialog-actions">
        {!sheet ? (
          <button type="button" className="btn" onClick={onClose}>
            {active ? "Cancel" : "Close"}
          </button>
        ) : null}
        {active ? (
          <button
            type="button"
            className="btn primary"
            data-testid="confirm-stop"
            disabled={ack.waiting}
            onClick={() => ack.press(act.stop(chat.id), onClose)}
          >
            Stop
          </button>
        ) : null}
      </div>
    </Modal>
  );
}

function TerminalDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const sheet = useModalSheet();
  // A worktree chat's command goes into its worktree (W11, L28), the folder its Claude Code runs in.
  const project = useStore((s) => s.projects.find((p) => p.id === chat.projectId));
  const folder = chatFolder(chat.worktree, project?.folder) ?? "~";
  return (
    <Modal title="Copy the command" testId="dialog-terminal" onClose={onClose}>
      <TerminalBody chat={chat} folder={folder} sheet={sheet} onClose={onClose} vars={project?.env ?? 0} />
    </Modal>
  );
}

/**
 * Copy the command's body (exported for the tests). From v0.4 resume, while the chat's Claude Code lives, End it here
 * and copy beside Copy a fork command (endHere.ts): it copies the plain command inside the click, then sends
 * `end_here`; while the chat is handed to the terminal, its line says Wait until the process ended (the box keeps the
 * fork command, Copy a fork command still works, and End it here shows as done), then Ended, over the plain command.
 * While kitespan's own orphan of the server before finishes its turn (the `finishing` hold, R16), only the fork command
 * is offered: no process of this server ends at a quiet moment there (Stop in the box ends that orphan).
 */
export function TerminalBody({ chat, folder, sheet, onClose, vars = 0 }: { chat: Chat; folder: string; sheet: boolean; onClose: () => void; vars?: number }) {
  // ui/Copy writes inside the click, from text the page holds (7.10); a failed write selects the command, never silent.
  const [copy, copied, failed] = useCopy();
  const [copyPlain, plainCopied, plainFailed] = useCopy();
  const [pressed, setPressed] = useState(false);
  // A refused End it here keeps the dialog with its line (useAckClose); an ok one keeps it too, for Wait and Ended.
  const ack = useAckClose();
  const box = useRef<HTMLPreElement>(null);
  // While the chat's Claude Code process lives (any state but sleeping, and failed until its process is known to have
  // died; idle keeps the process; the finishing hold's orphan too), only a fork may be resumed (6.10).
  // terminal/command.ts holds the rule; the Terminal pane types the same command.
  const r = resumeCommand(chat, folder);
  const live = r.case === "fork";
  const noSession = r.command === null;
  const endLine = endHereLine(chat);
  const canEnd = live && chat.held?.kind !== "finishing";
  // Pressed, or handed while the process still runs (Wait): End it here is done; Ended comes once the chat sleeps.
  const ending = canEnd && (pressed || endLine !== null);
  // The box shows the plain command only once the process ended, or when End it here's copy failed (it selects it).
  const plain = live && plainFailed ? plainResume(chat, folder) : null;
  const command = plain ?? r.command ?? "";
  const failedAny = failed || plainFailed;
  const label = copied ? "Copied" : failed ? COPY_FAILED : live ? "Copy a fork command" : "Copy";
  const endLabel = plainCopied ? "Copied" : plainFailed ? COPY_FAILED : END_HERE_WORDS.button;
  const endHere = () => {
    const text = plainResume(chat, folder);
    if (!text) return;
    setPressed(true);
    const sent = () =>
      ack.press(
        act.endHere(chat.id).then((ok) => {
          if (!ok) setPressed(false);
          return ok;
        }),
        () => {},
      );
    endHereClick(text, (t) => copyPlain(t, () => box.current), sent);
  };
  return (
    <>
      {noSession ? (
        <p>{r.note}</p>
      ) : (
        <>
          {endLine ? (
            <p role="status" data-testid="end-here-line">
              {endLine}
            </p>
          ) : live ? (
            <p>
              This chat's Claude Code is still open. While a conversation's Claude Code process is still running, don't run <code>claude --resume</code> for it. A
              fork command opens a copy in your terminal and leaves this chat as it is.
            </p>
          ) : (
            <p>Run this in a terminal of your own to continue this chat in Claude Code.</p>
          )}
          <pre className="scr-cmd" ref={box}>
            <code>{command}</code>
          </pre>
          {/* D60: a terminal of the user's own does not get the environment's variables (the Terminal pane does). */}
          {vars > 0 ? <p data-testid="terminal-env-line">{ENV_WORDS.terminal}</p> : null}
          {failedAny ? (
            <p className="scr-dlg-error" role="alert">
              {COPY_HINT}
            </p>
          ) : null}
          {ack.line ? (
            <p className="notice" data-testid="dialog-notice" role="status">
              {ack.line}
            </p>
          ) : null}
          <span className="visually-hidden" role="status">
            {copied || plainCopied ? "Copied" : ""}
          </span>
        </>
      )}
      {/* FIX-Q1: the phone's sheet stacks them with End it here on top, first in the DOM too (readingOrder). */}
      <div className="dialog-actions">
        {readingOrder(
          <>
            {!sheet ? (
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            ) : null}
            {!noSession ? (
              <button type="button" className={live ? "btn" : "btn primary"} data-testid={live ? "confirm-copy-fork" : "confirm-copy"} onClick={() => copy(r.command ?? "", () => box.current)}>
                {label}
              </button>
            ) : null}
            {canEnd ? (
              <button type="button" className="btn primary" data-testid="confirm-end-here" disabled={ack.waiting || ending} onClick={endHere}>
                {endLabel}
              </button>
            ) : null}
          </>,
          sheet,
        )}
      </div>
    </>
  );
}
