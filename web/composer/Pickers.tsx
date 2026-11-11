// The composer's pickers (DESIGN.md 6.6). Model and effort are one menu, as in Desktop ("select a level under
// Effort"): the one model button shows both values and opens it, and Cmd+Shift+E and /c/<chat>/effort open it at its
// Effort section. The rows are the chat's own (`get models`); the effort list starts with Default, the user's Claude
// Code default, which the button shows while the user picked no level. A section has a head line only when it changes
// what Switch does (origin.ts, M19), and "Forget for <project>" while the project remembers a pick that the menu shows
// (the model menu a model or an effort, the mode menu a mode). A row click switches at once; a value that a link
// pre-filled is only marked, and its Switch button does the switch (a link never acts by itself, 5.1 rule 3). A pick
// is judged only once the chat's rows came (5.1 rule 6).
// A laptop and a tablet show them as .menu popovers with .menu-row rows and a heading per section; the phone shows them
// as sheets of .group lists on the look's grouped ground, each section's line under its group (plan v3).
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { href } from "../router";
import { Link, Popup } from "../ui/primitives";
import type { Chat, ModelRow, Project } from "../state/types";
import { EffortList, ModeList, ModelList, modeOffLine } from "./lists";
import { effortLabel, effortsFor, modeLabel, modelLabel, modelRow } from "./labels";
import { hasRemembered, headLine, type Field } from "./origin";

/** The 5.4 line for a pick the chat does not offer. */
export const NOT_OFFERED_LINE = "That choice is not available in this chat.";

const MODEL_MENU: readonly Field[] = ["model", "effort"];
const MODE_MENU: readonly Field[] = ["mode"];

function Head(props: { line: string | null; project?: Project; forgets?: readonly Field[]; onForget?: () => void; sheet: boolean }) {
  const { line, project, forgets, onForget, sheet } = props;
  const forget = !!onForget && !!forgets && hasRemembered(project, forgets);
  if (!line && !forget) return null;
  return (
    <div className={sheet ? "group-foot cmp-origin" : "cmp-origin"}>
      <span>{line}</span>
      {forget ? (
        <button type="button" className="cmp-forget" data-testid="picker-forget" onClick={onForget}>
          Forget for {project!.name}
        </button>
      ) : null}
    </div>
  );
}

function Foot({ children }: { children: ReactNode }) {
  return <div className="cmp-picker-foot">{children}</div>;
}

/** Focus the named button when a link marked a value, else the current row of the section the picker opened at.
 *  With `scroll`, the section comes to the top of the menu or sheet first (the Effort section of the model menu). */
function useOpenFocus(open: boolean, box: RefObject<HTMLDivElement | null>, section: RefObject<HTMLDivElement | null>, key: string, scroll = false) {
  useEffect(() => {
    if (!open) return;
    const root = box.current;
    if (!root) return;
    const sec = section.current ?? root;
    const scroller = root.closest<HTMLElement>(".menu, .sheet");
    if (scroll && scroller && section.current) scroller.scrollTop += section.current.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
    const target =
      root.querySelector<HTMLElement>("[data-testid^='confirm-switch']") ??
      sec.querySelector<HTMLElement>('[aria-checked="true"]') ??
      sec.querySelector<HTMLElement>('[role="menuitemradio"]');
    target?.focus({ preventScroll: true });
  }, [open, key, box, section, scroll]);
}

function NotOffered() {
  return (
    <p className="notice cmp-picker-note" data-testid="link-notice" role="status">
      {NOT_OFFERED_LINE}
    </p>
  );
}

export function ModelPicker(props: {
  open: boolean;
  at: "model" | "effort";
  pick?: string;
  anchor: RefObject<HTMLButtonElement | null>;
  sheet: boolean;
  chat: Chat;
  project?: Project;
  /** The chat's model rows, and whether Claude Code sent them yet. */
  rows: readonly ModelRow[];
  known: boolean;
  onClose: () => void;
  onModel: (id: string) => void;
  onEffort: (id: string) => void;
  onForget: () => void;
}) {
  const { open, at, pick, anchor, sheet, chat, project, rows, known, onClose, onModel, onEffort, onForget } = props;
  const box = useRef<HTMLDivElement>(null);
  const modelSec = useRef<HTMLDivElement>(null);
  const effortSec = useRef<HTMLDivElement>(null);
  // DESIGN.md 5.1 rule 6: a pick must be a value the live chat offers (a model row, a level the model supports).
  const modelPick = known && at === "model" && pick && modelRow(pick, rows) ? pick : undefined;
  const effortPick = known && at === "effort" && pick && effortsFor(chat.model, rows).includes(pick) ? pick : undefined;
  const notOffered = known && !!pick && !(at === "model" ? modelPick : effortPick);
  const modelLine = headLine("model", chat, project);
  const effortLine = headLine("effort", chat, project);
  useOpenFocus(open, box, at === "effort" ? effortSec : modelSec, `${at}|${pick ?? ""}|${known}`, at === "effort");
  return (
    <Popup open={open} onClose={onClose} anchor={anchor} title="Model" wide testId="picker-model">
      <div className={`cmp-picker${sheet ? " cmp-sheet" : ""}`} ref={box} data-testid={at === "effort" ? "picker-effort" : undefined}>
        {notOffered ? <NotOffered /> : null}
        <div className="cmp-picker-sec" ref={modelSec}>
          {sheet ? null : <h3 className="cmp-picker-h">Model</h3>}
          {sheet ? null : <Head line={modelLine} project={project} forgets={MODEL_MENU} onForget={onForget} sheet={false} />}
          <ModelList value={chat.model} marked={modelPick} grouped={sheet} rows={rows} onPick={onModel} />
          {sheet ? <Head line={modelLine} project={project} forgets={MODEL_MENU} onForget={onForget} sheet /> : null}
        </div>
        <div className="cmp-picker-sec" ref={effortSec}>
          <h3 className={sheet ? "group-title" : "cmp-picker-h"}>Effort</h3>
          {sheet ? null : <Head line={effortLine} sheet={false} />}
          <EffortList model={chat.model} value={chat.effort} marked={effortPick} grouped={sheet} rows={rows} withDefault onPick={onEffort} />
          {sheet ? <Head line={effortLine} sheet /> : null}
        </div>
        {modelPick && modelPick !== chat.model ? (
          <Foot>
            <button type="button" className="btn primary" data-testid="confirm-switch-model" onClick={() => onModel(modelPick)}>
              Switch to {modelLabel(modelPick, rows)}
            </button>
          </Foot>
        ) : null}
        {effortPick && effortPick !== chat.effort ? (
          <Foot>
            <button type="button" className="btn primary" data-testid="confirm-switch-effort" onClick={() => onEffort(effortPick)}>
              Switch to {effortLabel(effortPick)} effort
            </button>
          </Foot>
        ) : null}
      </div>
    </Popup>
  );
}

export function ModePicker(props: {
  open: boolean;
  pick?: string;
  anchor: RefObject<HTMLButtonElement | null>;
  sheet: boolean;
  chat: Chat;
  project?: Project;
  rows: readonly ModelRow[];
  allowBypass: boolean;
  onClose: () => void;
  onMode: (id: string) => void;
  onForget: () => void;
}) {
  const { open, pick, anchor, sheet, chat, project, rows, allowBypass, onClose, onMode, onForget } = props;
  const box = useRef<HTMLDivElement>(null);
  // DESIGN.md 5.4: Bypass from a link while Settings does not allow it gets its own line. A pick the chat cannot
  // switch to (Bypass in a chat that started without the bypass flag, D12; Auto on a model without it) is marked, and
  // its row stays off with the line that says why; no Switch shows.
  const bypassNeedsNewChat = !chat.bypassFlag;
  const bypassOff = pick === "bypassPermissions" && !allowBypass;
  const modePick = pick && !bypassOff ? pick : undefined;
  const canSwitch = !!modePick && modePick !== chat.mode && !modeOffLine(modePick, { bypassNeedsNewChat, model: chat.model, rows });
  const line = headLine("mode", chat, project);
  useOpenFocus(open, box, box, pick ?? "");
  return (
    <Popup open={open} onClose={onClose} anchor={anchor} title="Permission mode" testId="picker-mode">
      <div className={`cmp-picker${sheet ? " cmp-sheet" : ""}`} ref={box}>
        {bypassOff ? (
          <p className="notice cmp-picker-note" data-testid="link-notice" role="status">
            <span>
              Bypass permissions is off. You can allow it in{" "}
              <Link to={href("setting", { section: "chats", key: "allow-bypass" })}>Settings &gt; Chats</Link>.
            </span>
          </p>
        ) : null}
        {sheet ? null : <h3 className="cmp-picker-h">Permission mode</h3>}
        {sheet ? null : <Head line={line} project={project} forgets={MODE_MENU} onForget={onForget} sheet={false} />}
        <ModeList value={chat.mode} marked={modePick} allowBypass={allowBypass} bypassNeedsNewChat={bypassNeedsNewChat} model={chat.model} rows={rows} grouped={sheet} onPick={onMode} />
        {sheet ? <Head line={line} project={project} forgets={MODE_MENU} onForget={onForget} sheet /> : null}
        {canSwitch ? (
          <Foot>
            <button type="button" className="btn primary" data-testid="confirm-switch-mode" onClick={() => onMode(modePick)}>
              Switch to {modeLabel(modePick)}
            </button>
          </Foot>
        ) : null}
      </div>
    </Popup>
  );
}
