// The keyboard on touch (DESIGN-B1 4.10, F6; PAGE 11): iOS raises the keyboard only for a field focused inside the
// user's own gesture, and the pane learns that the page's field took the focus only after the tap's round trip. So the
// Keyboard button focuses a hidden field inside its own tap, and lights while the server's `focus` frame says a field
// on the page has the focus. The hidden field copies that field's hints (type as inputmode, inputmode, enterkeyhint)
// and turns autocorrect, capitals and spell check off for password, email and url fields. Text, dictation and paste go
// to the page as text; Return is Enter; Backspace is a key; the field keeps one sentinel character so iOS sends
// Backspace on an "empty" field. A word that an input method composes shows in the strip above the key row, underlined,
// and goes when it is committed. While the keyboard is up, the key row has the keys a phone keyboard lacks (Esc, Tab, the
// four arrows) and Done, which hides the keyboard. The strip echoes the last 20 characters typed for 2 s, never for a
// password field and never kept.
// While More > Select text is on (selectText.ts), the foot shows Copy, which writes the page's selection. The foot and
// its key row are one owner of the hidden field for the keyboard release (data-kb-owner): a tap on either while the
// keyboard settles closed keeps the field.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserFocusFacts } from "../../shared/browser";
import { IconBack, IconCopy, IconForward, IconKeyboard } from "../ui/icons";
import { strokeFrames, type Stroke } from "./keys";
import { copyPageSelection, setSelectingText, useSelectingText } from "./selectText";
import { drawnN, sendInput } from "./store";

export const SENTINEL = "\u200b";
export const ECHO_CHARS = 20;
export const ECHO_MS = 2_000;

/** The hidden field's hints from the page's focused field (DESIGN-B1 4.10). */
export function fieldHints(f: BrowserFocusFacts | null): { inputMode: string; enterKeyHint: string | undefined; autoCorrect: "on" | "off"; autoCapitalize: "on" | "off" | "sentences"; spellCheck: boolean } {
  const type = f?.editable ? f.type : "text";
  const fromType: Record<string, string> = { email: "email", url: "url", tel: "tel", number: "numeric", search: "search" };
  const own = f?.editable && f.inputmode && /^(none|text|decimal|numeric|tel|search|email|url)$/.test(f.inputmode) ? f.inputmode : null;
  const plain = !(f?.editable && (f.password || type === "email" || type === "url" || type === "password"));
  const hint = f?.editable && f.enterkeyhint && /^(enter|done|go|next|previous|search|send)$/.test(f.enterkeyhint) ? f.enterkeyhint : undefined;
  return {
    inputMode: own ?? fromType[type] ?? "text",
    enterKeyHint: hint,
    autoCorrect: plain ? "on" : "off",
    autoCapitalize: plain ? "sentences" : "off",
    spellCheck: plain,
  };
}

/** The echo after `typed`: the last 20 characters; nothing for a password field. */
export function echoOf(prev: string, typed: string, password: boolean): string {
  if (password) return "";
  return (prev + typed).slice(-ECHO_CHARS);
}

const STROKE: Record<string, Stroke> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, mods: 0, text: "\r" },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8, mods: 0 },
  Delete: { key: "Delete", code: "Delete", vk: 46, mods: 0 },
  Escape: { key: "Escape", code: "Escape", vk: 27, mods: 0 },
  Tab: { key: "Tab", code: "Tab", vk: 9, mods: 0 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37, mods: 0 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38, mods: 0 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39, mods: 0 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40, mods: 0 },
};

function press(tab: string, name: keyof typeof STROKE) {
  for (const f of strokeFrames(STROKE[name]!, "both")) sendInput({ t: "key", tab, n: drawnN(tab), ...f });
}

/**
 * The foot on touch: on the phone Back, Forward, Keyboard and Tabs; beside the chat Keyboard (and Back and Forward when
 * the bar moved them); Copy before Keyboard while Select text is on.
 */
export function TouchFoot(props: {
  tab: string | null;
  phone: boolean;
  nav: boolean;
  canBack: boolean;
  canForward: boolean;
  backName: string;
  onBack: () => void;
  onForward: () => void;
  tabs: number;
  onTabs: () => void;
  focus: BrowserFocusFacts | null;
  up: boolean;
  onUp: (up: boolean) => void;
  onTyped: () => void;
}) {
  const { tab, phone, nav, focus, up, onUp } = props;
  const field = useRef<HTMLTextAreaElement>(null);
  const [echo, setEcho] = useState("");
  const [composing, setComposingNow] = useState<string | null>(null);
  const composingRef = useRef(false);
  const setComposing = (v: string | null) => {
    composingRef.current = v !== null;
    setComposingNow(v);
  };
  const echoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hints = fieldHints(focus);
  const password = !!(focus?.editable && focus.password);
  const lit = !!focus?.editable;
  useEffect(() => () => void (echoTimer.current && clearTimeout(echoTimer.current)), []);
  // Select text goes off when the pane closes.
  useEffect(() => () => setSelectingText(false), []);
  const selecting = useSelectingText();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  useEffect(() => {
    if (!up) setEcho("");
  }, [up]);
  const echoed = (t: string) => {
    if (password) return;
    setEcho((e) => echoOf(e, t, false));
    if (echoTimer.current) clearTimeout(echoTimer.current);
    echoTimer.current = setTimeout(() => setEcho(""), ECHO_MS);
  };
  const reset = () => {
    const el = field.current;
    if (el && el.value !== SENTINEL) {
      el.value = SENTINEL;
      el.setSelectionRange(1, 1);
    }
  };
  const text = (t: string) => {
    if (!tab || !t) return;
    sendInput({ t: "text", tab, n: drawnN(tab), text: t.replace(/\r\n?/g, "\n").slice(0, 65_536) });
    echoed(t);
    props.onTyped();
  };
  // The native beforeinput (React's onBeforeInput is its own textInput-based event, with no inputType): each edit the
  // keyboard asks for goes to the page, and the field keeps its sentinel. A composition's words go at its end.
  const before = useRef<(ne: InputEvent) => void>(() => {});
  before.current = (ne) => {
    if (!tab || ne.isComposing || ne.inputType === "insertCompositionText") return;
    ne.preventDefault();
    if (ne.inputType === "insertText" || ne.inputType === "insertReplacementText") text(ne.data ?? "");
    else if (ne.inputType === "insertFromPaste" || ne.inputType === "insertFromDrop") text(ne.dataTransfer?.getData("text/plain") ?? ne.data ?? "");
    else if (ne.inputType === "insertLineBreak" || ne.inputType === "insertParagraph") {
      press(tab, "Enter");
      props.onTyped();
    } else if (ne.inputType === "deleteContentBackward" || ne.inputType === "deleteWordBackward") {
      press(tab, "Backspace");
      props.onTyped();
    } else if (ne.inputType === "deleteContentForward") {
      press(tab, "Delete");
      props.onTyped();
    }
    reset();
  };
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const on = (e: Event) => before.current(e as InputEvent);
    el.addEventListener("beforeinput", on);
    return () => el.removeEventListener("beforeinput", on);
  }, []);
  const toggle = () => {
    const el = field.current;
    if (!el) return;
    if (up) {
      el.blur();
      return;
    }
    reset();
    el.focus({ preventScroll: true }); // inside the tap: iOS raises the keyboard
  };
  const keyBtn = (label: ReactNode, name: keyof typeof STROKE, aria?: string) => (
    <button key={name} type="button" className="term-key" aria-label={aria} onMouseDown={(e) => e.preventDefault()} onClick={() => tab && (press(tab, name), props.onTyped())}>
      {label}
    </button>
  );
  const arrow = (d: string) => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
  const kb = (
    <button
      type="button"
      className={`bp-foot-btn${lit && !up ? " is-invite" : ""}`}
      aria-pressed={up}
      onMouseDown={(e) => up && e.preventDefault()}
      onClick={toggle}
      data-testid="browser-keyboard"
    >
      <IconKeyboard size={18} />
      <span>{up ? "Hide keyboard" : "Keyboard"}</span>
    </button>
  );
  const copy = selecting ? (
    <button
      type="button"
      className="bp-foot-btn"
      data-testid="browser-copy"
      onClick={() =>
        tab &&
        void copyPageSelection(tab).then((r) => {
          if (r === "copied") setCopied(true);
        })
      }
    >
      <IconCopy size={18} />
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  ) : null;
  return (
    <div className="bp-touch" data-kb-owner="">
      {up ? (
        <>
          {composing !== null || echo ? (
            <div className="bp-echo" aria-hidden="true" data-testid="browser-echo">
              {composing !== null ? (
                <>
                  {echo}
                  <u>{composing}</u>
                </>
              ) : (
                echo
              )}
            </div>
          ) : null}
          <div className="term-keys" role="toolbar" aria-label="Page keys" data-testid="browser-keys">
            {keyBtn("Esc", "Escape")}
            {keyBtn("Tab", "Tab")}
            <div className="term-arrows" role="group" aria-label="Arrow keys">
              {keyBtn(arrow("M12.5 8h-9M7 4.5 3.5 8 7 11.5"), "ArrowLeft", "Left")}
              {keyBtn(arrow("M8 12.5v-9M4.5 7 8 3.5 11.5 7"), "ArrowUp", "Up")}
              {keyBtn(arrow("M8 3.5v9M4.5 9 8 12.5 11.5 9"), "ArrowDown", "Down")}
              {keyBtn(arrow("M3.5 8h9M9 4.5 12.5 8 9 11.5"), "ArrowRight", "Right")}
            </div>
            <button type="button" className="term-key" aria-label="Done, hide keyboard" onClick={() => field.current?.blur()}>
              Done
            </button>
          </div>
        </>
      ) : null}
      <div className={`bp-foot${phone ? "" : " is-end"}`} role="toolbar" aria-label={phone ? "Browser controls" : "Touch keys"} data-testid="browser-foot">
        {phone || nav ? (
          <>
            <button type="button" className="bp-foot-btn" aria-label={props.backName} disabled={!props.canBack} onClick={props.onBack} data-testid="browser-foot-back">
              <IconBack size={18} />
              <span>Back</span>
            </button>
            <button type="button" className="bp-foot-btn" disabled={!props.canForward} onClick={props.onForward} data-testid="browser-foot-forward">
              <IconForward size={18} />
              <span>Forward</span>
            </button>
          </>
        ) : null}
        {copy}
        {kb}
        {phone ? (
          <button type="button" className="bp-foot-btn" aria-label={`Tabs, ${props.tabs} open`} onClick={props.onTabs} data-testid="browser-tabs-button">
            <span className="bp-count" aria-hidden="true">
              {props.tabs}
            </span>
            <span aria-hidden="true">Tabs</span>
          </button>
        ) : null}
        <textarea
          ref={field}
          className="bp-type"
          aria-label="Type into the page"
          inputMode={hints.inputMode as React.HTMLAttributes<HTMLTextAreaElement>["inputMode"]}
          enterKeyHint={hints.enterKeyHint as React.HTMLAttributes<HTMLTextAreaElement>["enterKeyHint"]}
          autoCorrect={hints.autoCorrect}
          autoCapitalize={hints.autoCapitalize}
          spellCheck={hints.spellCheck}
          defaultValue={SENTINEL}
          data-testid="browser-type"
          onFocus={() => onUp(true)}
          onBlur={() => {
            setComposing(null);
            onUp(false);
          }}
          onKeyDown={(e) => {
            if (!tab || e.nativeEvent.isComposing) return;
            const name = e.key as keyof typeof STROKE;
            if (name === "Enter" || name === "Backspace" || name === "Delete" || name === "Tab" || name === "Escape" || name.startsWith("Arrow")) {
              if (!(name in STROKE)) return;
              e.preventDefault();
              press(tab, name);
              props.onTyped();
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            text(e.clipboardData.getData("text/plain"));
            reset();
          }}
          onCompositionUpdate={(e) => setComposing(e.data)}
          onCompositionEnd={(e) => {
            setComposing(null);
            text(e.data);
            reset();
          }}
          onInput={() => {
            // Text the browser still wrote with no cancelled beforeinput (a keyboard that sends none, autocorrect): it goes
            // to the page as text, and the field goes back to its sentinel. A composition commits at its end.
            const el = field.current;
            if (composingRef.current || !el) return;
            const typed = el.value.split(SENTINEL).join("");
            if (typed) text(typed);
            reset();
          }}
        />
      </div>
    </div>
  );
}
