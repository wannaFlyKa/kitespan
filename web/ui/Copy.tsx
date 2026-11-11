// Copy that beats the full-screen TUI (DESIGN.md 7.10): the clipboard is written inside the click, from text the page
// already holds (the markdown source of a reply, the exact code of a block). A failed write is never silent: the
// button says "Copy failed", the text is selected, and one line asks the user to copy it with the system's own menu.
import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "./icons";

export type CopyState = "idle" | "copied" | "failed";
/** What to select when the write fails: an element, or a function that returns one when it is needed. */
export type CopyTarget = Element | null | undefined | (() => Element | null | undefined);

export const COPY_FAILED = "Copy failed";
export const COPY_HINT = "The text is selected. Copy it with your system's menu.";

/** The old way to copy, for a browser without the async clipboard: a hidden field, selected, and execCommand. */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const back = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  // Inside the open dialog or sheet, if any: a modal keeps the focus inside itself, and the field must take it.
  const modal = back?.closest('[aria-modal="true"]') ?? [...document.querySelectorAll('[aria-modal="true"]')].pop();
  (modal ?? document.body).appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  back?.focus?.({ preventScroll: true });
  return ok;
}

/** Select the text of an element, so the user can copy it by hand. */
export function selectContents(target: CopyTarget) {
  const el = typeof target === "function" ? target() : target;
  if (!el) return;
  const sel = window.getSelection();
  if (!sel) return;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Write text to the clipboard: the async clipboard first, then the old way. Resolves to true when it worked. */
export function writeClipboard(text: string): Promise<boolean> {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clip?.writeText) return Promise.resolve(legacyCopy(text));
  return clip.writeText(text).then(
    () => true,
    () => legacyCopy(text),
  );
}

/**
 * Copy text and say what happened: `[copy, copied, failed, state]`. Call `copy(text, target)` inside the click. On
 * a failed write, `failed` is true for 6 s and the text of `target` is selected, so the user can copy it by hand;
 * show COPY_FAILED, and COPY_HINT when there is room.
 */
export function useCopy(): [(text: string, target?: CopyTarget) => void, boolean, boolean, CopyState] {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const copy = (text: string, target?: CopyTarget) => {
    void writeClipboard(text).then((ok) => {
      if (!live.current) return;
      if (timer.current) clearTimeout(timer.current);
      setState(ok ? "copied" : "failed");
      if (!ok) selectContents(target);
      timer.current = setTimeout(() => setState("idle"), ok ? 1400 : 6000);
    });
  };
  return [copy, state === "copied", state === "failed", state];
}

/**
 * A Copy button: the icon alone (a reply, a message) or the icon and the word (a code block). It says "Copied",
 * or "Copy failed" with the hint line. The classes `copy*` are styled in base.css. With a label, `word` is the word it
 * shows at rest when that is shorter than its name ("Copy" for "Copy code"), and the name stays its label.
 */
export function CopyButton(props: {
  text: string;
  /** The element whose text is selected when the write fails. */
  target?: () => Element | null | undefined;
  /** Show the word next to the icon (code blocks); replies show the icon alone. */
  withLabel?: boolean;
  className?: string;
  testId?: string;
  label?: string;
  word?: string;
}) {
  const { text, target, withLabel, className, testId, label = "Copy" } = props;
  const [copy, , , state] = useCopy();
  const rest = props.word ?? label;
  const word = state === "copied" ? "Copied" : state === "failed" ? COPY_FAILED : rest;
  const name = withLabel ? (state === "idle" && rest !== label ? label : undefined) : word;
  const failed = state === "failed" ? " is-failed" : "";
  return (
    <span className={`copy${failed}${className ? " " + className : ""}`}>
      <button
        type="button"
        className={`copy-btn${withLabel ? " with-label" : ""}`}
        onClick={() => copy(text, target)}
        aria-label={name}
        title={withLabel ? undefined : word}
        data-testid={testId}
      >
        {state === "copied" ? <IconCheck size={14} /> : <IconCopy size={14} />}
        {withLabel || state !== "idle" ? <span>{word}</span> : null}
      </button>
      {state === "failed" ? (
        <span className="copy-hint" role="status">
          {COPY_HINT}
        </span>
      ) : (
        // A screen reader may not say a change of the focused button's own name: the success is said here too.
        <span className="visually-hidden" role="status">
          {state === "copied" ? "Copied" : ""}
        </span>
      )}
    </span>
  );
}
