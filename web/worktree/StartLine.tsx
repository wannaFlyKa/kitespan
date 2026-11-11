// The line of a refused start in the chat (W4, W5; L34, L35), with its buttons under it: kitespan's own gone worktree
// (its check before a start, or Claude Code's cwd_unavailable there) has Make it again from its branch and Continue in
// the project folder; a terminal session's linked worktree that is gone (W12) has Continue in the project folder only;
// worktree_unverified has Try again; worktree_resume_refused has Continue in a copy and, only as an explicit choice,
// Continue without the worktree. The line is kitespan's own sentence for the code (DESIGN 4.4), and for
// worktree_resume_refused Claude Code's first error line under it, in mono. Nothing starts by itself, and each button
// acts on its own click or tap only. Continue in a copy forks the chat's session, whose id the chat list gives a chat
// that has not run on this page. After Make it again or Continue in the project folder, the refused message waits in
// the box: on a laptop the box's field takes the focus, so Send (or Enter) is the next step. The session preview and an
// archived chat draw the line with no button, and a line above a later start keeps its words only
// (state/reduce.ts settledStarts).
import { useState } from "react";
import { href, navigate } from "../router";
import { act, useStore } from "../state/store";
import type { InfoItem } from "../state/types";
import { useViewport } from "../layout/size";
import { useTranscript } from "../chat/items/context";
import { IconWarning } from "../chat/items/icons";
import { WORKTREE_WORDS, startActions, type StartAction } from "./worktree";

/** The chat's message box field, once the line's buttons are gone (the next frame, after the ack's render). */
function focusComposer() {
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="composer-input"]')?.focus({ preventScroll: true }));
}

export function StartLine({ item }: { item: InfoItem }) {
  const t = useTranscript();
  const touch = useViewport().touch;
  const chat = useStore((s) => (t ? s.chats.find((c) => c.id === t.chatId) : undefined));
  const [busy, setBusy] = useState<StartAction | null>(null);
  const actions = item.start && chat && !t?.readOnly && !chat.archived ? startActions(item.start, chat.worktree) : [];
  const press = (a: StartAction) => {
    if (!chat || busy) return;
    setBusy(a);
    const done = () => setBusy(null);
    if (a === "copy") {
      // A fork of the session, in a new chat (D58's Continue in a copy): this chat stays as it is.
      void act.continueSession(chat.projectId, chat.sessionId, true).then((id) => {
        done();
        if (id) navigate(href("chat", { chat: id }));
      });
      return;
    }
    void act.worktreeAct(chat.id, a === "again" ? "again" : a === "project" ? "project" : "start").then((ok) => {
      done();
      if (ok && !touch) focusComposer();
    });
  };
  return (
    <div className="chat-note is-text wt-start" data-testid="start-line" data-code={item.start}>
      <span className="chat-row-icon">
        <IconWarning size={15} />
      </span>
      <div className="chat-note-text wt-start-text">
        <p className="wt-start-line">{item.text}</p>
        {item.detail ? <p className="wt-start-detail mono">{item.detail}</p> : null}
        {actions.length ? (
          <div className="wt-start-actions" role="group" aria-label={item.text}>
            {actions.map((a, i) => (
              <button
                key={a}
                type="button"
                className={i === 0 && a !== "without" ? "btn primary" : "btn"}
                data-testid={`start-${a}`}
                disabled={busy !== null || (a === "copy" && !chat?.sessionId)}
                aria-busy={busy === a || undefined}
                onClick={() => press(a)}
              >
                {WORKTREE_WORDS[a]}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
