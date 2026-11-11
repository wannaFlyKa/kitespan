// The user's message (a bubble on the right, the text as typed, and above it a Download tile for each uploaded file
// it refers to: the tile stands for the file's reference, which the bubble leaves out, and a message with no other
// text shows the tiles alone, D50 and D51; Copy still copies the text as it was sent), Claude's reply (markdown, plain
// on the page, with Copy or the working mark under it) and the thinking row (folded; it opens to the thinking text as
// plain text). Row 79: a live reply, and thinking that shows while it streams, reveal word by word (reveal.ts); the
// user's message enters with a short fade and rise when it came live (arrivals.ts). Row 111: a queued message is the
// plain bubble, with Take back in its menu beside Copy and one Send now under the last queued message.
import { useEffect, useMemo, useRef, useState } from "react";
import { useViewport } from "../../layout/size";
import { act, useStore } from "../../state/store";
import type { Item, ThinkingItem } from "../../state/types";
import { CopyButton } from "../../ui/Copy";
import { motionNow } from "../../ui/motion";
import { enteredDone, entering } from "../arrivals";
import { INTERRUPTED } from "../fold";
import { MarkdownView, revealText, useHeldWord, useMarkdownModel } from "../Markdown";
import { useReveal } from "../reveal";
import { useOpen, useTranscript } from "./context";
import { MessageFiles, referencedUploads, splitRefs, useChatUploads, type MessagePart } from "./Files";
import { tokensLabel } from "./format";
import { IconSpark, IconThought } from "./icons";
import { Chevron } from "./Tool";

type UserItem = Extract<Item, { kind: "user" }>;
type AssistantItem = Extract<Item, { kind: "assistant" }>;

/**
 * Take back a queued message: its text goes back into the message box. The button leaves with the message, so on a
 * laptop the focus follows the text into the box, caret at the end; a touch device keeps the keyboard down.
 */
function takeBack(chatId: string, messageId: string, touch: boolean) {
  act.takeBack(chatId, messageId);
  if (touch) return;
  requestAnimationFrame(() => {
    const field = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  });
}

/**
 * What the bubble shows of a message: its text without the references that its tiles stand for, and without the
 * spaces the server put before them. "" when the message is only files.
 */
export function bubbleText(parts: readonly MessagePart[]): string {
  let out = "";
  // A reference was left out just before: the spaces around it close up to one, or to none at an edge.
  let cut = false;
  for (const p of parts) {
    if (typeof p !== "string") {
      out = out.replace(/[ \t]+$/, "");
      cut = true;
      continue;
    }
    if (!cut) out += p;
    else if (out !== "" && !out.endsWith("\n") && /^[ \t]/.test(p)) out += ` ${p.replace(/^[ \t]+/, "")}`;
    else out += p.replace(/^[ \t]+/, "");
    cut = false;
  }
  return cut ? out.replace(/\s+$/, "") : out;
}

export function UserMessage({ item }: { item: UserItem }) {
  const ctx = useTranscript();
  const bubble = useRef<HTMLDivElement>(null);
  const touch = useViewport().touch;
  const [shown, setShown] = useState(false);
  const uploads = useChatUploads(ctx?.chatId);
  // The paths of the mention chips that the message's event names are its tiles (9.3).
  const parts = useMemo(() => splitRefs(item.text, uploads, uploads.refFolder, item.mentions), [item.text, uploads, item.mentions]);
  const files = referencedUploads(parts);
  const text = bubbleText(parts);
  // This page's message that the server has not taken yet while the socket is down, or while its ack is overdue on an
  // open socket (a silent link, 4.3): an outline, with no word; the chat says Reconnecting... above the composer
  // (ChatScreen). Otherwise it shows as sent.
  const unsent = useStore((s) => !!ctx && (s.net !== "open" || s.overdue.includes(item.id)) && (s.outgoing[ctx.chatId]?.includes(item.id) ?? false));
  // Row 80: while another app holds the session (D58, or kitespan's own orphan), a send can only be refused: Not sent
  // keeps Take back, and its messages go when the hold ends (6.3). A hand-over to the terminal ends on Send again.
  const holdOff = useStore((s) => {
    if (!item.notSent || !ctx) return false;
    const held = s.chats.find((c) => c.id === ctx.chatId)?.held;
    return !!held && held.kind !== "handed";
  });
  // A press of Send again waits for its ack: off until then, so one press sends one.
  const againOut = useStore((s) => !!ctx && s.sendAgainOut.includes(ctx.chatId));
  // A message sent while a turn runs is queued at once; while it only waits in the outbox the server may not have it,
  // so it shows as not sent yet, with no Take back.
  const queued = !!item.queued && !unsent;
  const own = ctx && !ctx.readOnly ? ctx : null;
  // Row 111: Send now under the last queued message only (ChatView's sendNowId); a Not sent one is not in Claude Code's
  // queue. A link to the message (/m/<message>) shows its menu, so the route's Take back shows on touch too.
  const now = queued && !!own && !item.notSent && own.sendNowId === item.id;
  const menu = shown || ctx?.highlightId === item.id;
  // Sent from this page, or another page's message that this one sees live: it fades and rises in once.
  const [enter] = useState(() => entering(ctx?.chatId, item.id, motionNow()));
  const chatId = ctx?.chatId;
  useEffect(() => {
    if (enter) enteredDone(chatId, item.id);
  }, [enter, chatId, item.id]);
  return (
    <div className={`chat-user${queued ? " is-queued" : unsent ? " is-unsent" : ""}${menu ? " show-actions" : ""}${text ? "" : " is-files"}${enter ? " is-entering" : ""}`}>
      <MessageFiles uploads={files} />
      {/* The bubble's menu: a tap on touch shows Copy (and a queued message's Take back); a laptop shows it on hover or focus. */}
      {text ? (
        <div className="chat-bubble" dir="auto" ref={bubble} onClick={touch ? () => setShown((v) => !v) : undefined}>
          {text}
        </div>
      ) : null}
      <div className="chat-user-foot">
        <CopyButton text={item.text} target={() => bubble.current} className="chat-reveal" testId="copy-message" label="Copy message" />
        {/* A message of files alone has no bubble to tap on touch: its Take back stays in sight there. */}
        {queued && own ? (
          <button type="button" className={`chat-foot-btn${text || !touch ? " chat-reveal" : ""}`} data-testid="confirm-take-back" onClick={() => takeBack(own.chatId, item.id, touch)}>
            Take back
          </button>
        ) : null}
        {queued && item.notSent ? (
          <>
            {/* RD-8: a message that waited when the server stopped is Not sent, until Send again, the next send or a hold's end. */}
            <span className="chat-queued">Not sent</span>
            {own && !holdOff ? (
              <button type="button" className="btn chat-mini" data-testid="send-again" disabled={againOut} onClick={() => act.sendQueued(own.chatId)}>
                Send again
              </button>
            ) : null}
          </>
        ) : null}
        {/* After this page's press the button goes and its place stays, so nothing slides under the pointer. */}
        {now && own?.sendNowPressed ? (
          <span className="chat-send-now is-pressed" aria-hidden="true">
            Send now
          </span>
        ) : now && own ? (
          <button type="button" className="chat-send-now" data-testid="send-now" onClick={() => act.sendNow(own.chatId, item.id)}>
            Send now
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function WorkingMark() {
  return (
    <span className="chat-working" role="img" aria-label="Claude is working">
      <IconSpark size={16} />
    </span>
  );
}

/** The store ends an interrupted turn with a reply that says only this word; it shows as the foot's quiet line. */
export { INTERRUPTED };

export function AssistantText({ item }: { item: AssistantItem }) {
  const ctx = useTranscript();
  const prose = useRef<HTMLDivElement>(null);
  const model = useMarkdownModel(item.markdown, item.streaming, `${ctx?.chatId ?? ""}\n${item.id}`);
  // While it streams, what came shows over the next frames; the rest at once when the block ends.
  const cut = useReveal(ctx?.chatId, item.id, model.total, !!item.streaming);
  if (item.markdown === INTERRUPTED && !item.streaming) return <div className="chat-foot-line">Interrupted</div>;
  return (
    <div className={`chat-assistant${item.streaming ? " is-live" : ""}`}>
      <div ref={prose}>{item.markdown ? <MarkdownView model={model} reveal={cut} /> : null}</div>
      <div className="chat-foot">
        {item.streaming ? <WorkingMark /> : <CopyButton text={item.markdown} target={() => prose.current} className="chat-reveal" testId="copy-reply" label="Copy reply" />}
      </div>
    </div>
  );
}

/** "Thinking..." while live; "Thought for Ns" once done; "Thought" when its time is not known (history). */
export function thinkingLabel(item: Pick<ThinkingItem, "live" | "seconds">): string {
  if (item.live) return "Thinking...";
  return item.seconds >= 1 ? `Thought for ${item.seconds}s` : "Thought";
}

/**
 * "Thinking..." while the block streams, with Claude Code's estimate ("about 1.9k tokens", progress only, not the
 * billed count); "Thought for Ns" once it is done.
 */
export function ThinkingRow({ item }: { item: ThinkingItem }) {
  const ctx = useTranscript();
  const [open, toggle] = useOpen(item.id, "thinking", false);
  // Open while it streams: its text reveals as a reply's does, and its last word waits until it is whole.
  const text = useHeldWord(item.text, !!item.live, `${ctx?.chatId ?? ""}\n${item.id}:thinking`);
  const cut = useReveal(ctx?.chatId, `${item.id}:thinking`, text.length, open && !!item.live);
  return (
    <div className={`chat-think${open ? " is-open" : ""}${item.live ? " is-live" : ""}`}>
      <div className="chat-row-line">
        <button type="button" className="chat-row" aria-expanded={open} onClick={toggle}>
          <span className="chat-row-icon">
            <IconThought size={15} />
          </span>
          <span className="chat-row-label">{thinkingLabel(item)}</span>{" "}
          {item.live && item.tokenEstimate ? <span className="chat-row-meta chat-estimate">about {tokensLabel(item.tokenEstimate)} tokens</span> : null}
          <Chevron />
        </button>
      </div>
      {open ? <div className="chat-row-body chat-think-body">{revealText(text, cut)}</div> : null}
    </div>
  );
}
