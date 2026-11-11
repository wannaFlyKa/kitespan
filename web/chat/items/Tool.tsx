// Tool rows (DESIGN.md 6.3): an icon by tool, the verb, the target in mono, a tag, a chevron; a spinner and the
// elapsed time ("12 s") while it runs. A row opens in place to its body; an Edit's diff there has no header of its
// own, because the row names the path and the counts (D51). A running Bash call also offers Run in background (beside
// the row; on the phone, styles put it on a line of its own under the command, so the row keeps its target readable),
// and a call in the background says so. A row whose target is a file offers Download (D37). A row's head has the row's
// menu (DESIGN-T1 2.1, toolMenu.ts: the file menu, or the command's, the pattern's, the link's, the query's and the
// output's copies): a long press or its "..." on touch, where the "..." takes the Download icon's place, and a right-
// click on a laptop; the body keeps the browser's own selection. An MCP tool's row names the
// tool as the verb and its server as the target, and when the server declares an MCP Apps view (S59) one line says
// kitespan does not show it. ToolSearch, Claude Code's own search for the tools it loads on demand, is one line with
// nothing to open (principle 0). The to-do list (a TodoWrite call, or a turn's task tools) is a row that opens to its
// checklist, with its count only while folded (D51), and in the Normal and Thinking views a run of calls folds into
// one summary row, whose time and spinner show only while it is folded (the running call's row has them once it is
// open). A call whose card waits shows no spinner: Claude waits for the user, and the call runs only once it is allowed.
import { Fragment, useEffect, type ReactNode } from "react";
import { act, useStore } from "../../state/store";
import type { Item, TodoItem, ToolItem } from "../../state/types";
import { IconFile, IconGlobe, IconPlug, IconRight, IconSearch, IconTerminal } from "../../ui/icons";
import { TOOL_TAG, inBackground, mcpTool, summarize, tagClass, targetOf } from "../fold";
import { useOpen, useTranscript } from "./context";
import { DownloadButton, fileTarget, hostPath, useProjectFolder } from "./Files";
import { VERB, toolMenu } from "./toolMenu";
import { fileOpener, useRowMenu } from "../../ui/RowMenu";
import { elapsedLabel } from "./format";
import { IconChecklist, IconFilePlus, IconPencil, IconStack } from "./icons";
import { CodeLines, CommandLines, DiffLines, ListLines, splitLines } from "./Lines";
import { ItemView } from "./ItemView";
import { TrustLines } from "./TrustLine";
import { BackgroundLines } from "./BackgroundLine";

export function Spinner({ label = "Running" }: { label?: string }) {
  return (
    <span className="chat-spin" role="img" aria-label={label}>
      <span className="chat-spin-still">{label}</span>
    </span>
  );
}

export function Chevron() {
  return <IconRight size={14} className="chat-chev" />;
}

/** S59: the line on the row of an MCP tool whose server declares an MCP Apps view (a `ui://` resource). */
export const VIEW_LINE = "This tool has an interactive view, which kitespan does not show.";

/** The chats whose connectors this page asked for, so a chat with MCP rows reads them once (a `get`, which reads only). */
const connectorsAsked = new Set<string>();

/**
 * S59's line under an MCP tool's row, when its server declares an interactive view: read from the chat's connectors
 * (`get connectors`, asked once per chat while its Claude Code is alive). Only MCP rows draw this, so the other rows
 * read nothing from the store for it.
 */
function ViewLine({ chatId, server, id, readOnly }: { chatId: string; server: string; id: string; readOnly: boolean }) {
  const known = useStore((s) => s.chats.find((c) => c.id === chatId)?.connectorInfo ?? null);
  const alive = useStore((s) => {
    const st = s.chats.find((c) => c.id === chatId)?.serverState;
    return st === "idle" || st === "running" || st === "waiting";
  });
  useEffect(() => {
    if (readOnly || known || !alive || connectorsAsked.has(chatId)) return;
    connectorsAsked.add(chatId);
    void act.load(chatId, "connectors");
  }, [chatId, readOnly, known, alive]);
  if (!known?.some((c) => c.name === server && c.hasView)) return null;
  return (
    <p className="chat-row-note" data-testid={`view-line-${id}`}>
      {VIEW_LINE}
    </p>
  );
}

function toolIcon(name: string): ReactNode {
  switch (name) {
    case "Read":
      return <IconFile size={15} />;
    case "Write":
      return <IconFilePlus size={15} />;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return <IconPencil size={15} />;
    case "Grep":
    case "Glob":
      return <IconSearch size={15} />;
    case "Bash":
      return <IconTerminal size={15} />;
    case "WebFetch":
    case "WebSearch":
      return <IconGlobe size={15} />;
    default:
      return <IconPlug size={15} />;
  }
}

/** A running call's progress: the time it has run (when Claude Code reports it) and the spinner. */
function Running({ elapsed }: { elapsed?: number }) {
  return (
    <>
      {elapsed !== undefined ? <span className="chat-row-meta chat-elapsed">{elapsedLabel(elapsed)}</span> : null}{" "}
      <Spinner />
    </>
  );
}

/** What a row can open to, and the short meta it shows instead when the output is one line. */
function bodyOf(item: ToolItem): { body: ReactNode | null; meta: string } {
  // Its target is the query; what it found are tool references, which say nothing to the reader.
  if (item.name === "ToolSearch") return { body: null, meta: "" };
  // The row above names the path and the counts, so the diff has no header of its own here (D51).
  if (item.diff) return { body: <DiffLines removed={item.diff.removed} added={item.diff.added} />, meta: `+${item.diff.added.length} -${item.diff.removed.length}` };
  const out = item.output ?? "";
  const outLines = out ? splitLines(out) : [];
  if (item.name === "Bash") {
    const cmd = item.input ?? item.summary;
    return item.input || out ? { body: <CommandLines command={cmd} output={out} />, meta: outLines.length > 1 ? `${outLines.length} lines` : "" } : { body: null, meta: "" };
  }
  const oneLine = outLines.length === 1 && !item.input && outLines[0]!.length <= 48;
  if (oneLine) return { body: null, meta: outLines[0]! };
  if (item.name === "Grep" || item.name === "Glob") return { body: out ? <ListLines text={out} /> : null, meta: out ? `${outLines.length} ${outLines.length === 1 ? "result" : "results"}` : "" };
  if (item.name === "Read" || item.name === "Write") {
    const text = item.name === "Write" ? item.input ?? out : out;
    return { body: text ? <CodeLines text={text} /> : null, meta: text ? `${splitLines(text).length} lines` : "" };
  }
  if (!item.input && !out) return { body: null, meta: "" };
  return {
    body: (
      <>
        {item.input ? <ListLines text={item.input} max={24} /> : null}
        {out ? <ListLines text={out} /> : null}
      </>
    ),
    meta: "",
  };
}

export function ToolRow({ item }: { item: ToolItem }) {
  const ctx = useTranscript();
  const [open, toggle] = useOpen(item.id, "tool", false);
  const bg = inBackground(item);
  const running = item.status === "running" && !ctx?.calls?.waiting.has(item.id);
  const { body, meta } = bodyOf(item);
  const tag = TOOL_TAG[item.status];
  const canBackground = running && item.name === "Bash" && !bg && !(ctx?.readOnly ?? true);
  const file = fileTarget(item);
  const folder = useProjectFolder(ctx?.chatId);
  const mcp = mcpTool(item.name);
  const chatId = ctx?.chatId ?? "";
  const readOnly = ctx?.readOnly ?? true;
  const menu = useRowMenu((here) => (chatId ? toolMenu(item, { chatId, folder, open: fileOpener(chatId, here.route), attach: !readOnly }) : null), { openerClass: "chat-row-more" });
  const head = (
    <>
      {/* The spaces between the parts are not drawn in the flex row; they keep the words apart for screen readers
          and for a copy of the row. */}
      <span className="chat-row-icon">{toolIcon(item.name)}</span>
      <span className="chat-row-verb">{mcp ? mcp.tool : (VERB[item.name] ?? item.name)}</span>{" "}
      <span className="chat-row-target mono">{mcp ? mcp.server : targetOf(item)}</span>{" "}
      {tag ? <span className={tagClass(tag)}>{tag}</span> : null}{" "}
      {bg && running ? <span className="chat-tag">In the background</span> : null}{" "}
      {meta && item.status !== "running" ? <span className="chat-row-meta">{meta}</span> : null}{" "}
      {running ? <Running elapsed={item.elapsedSeconds} /> : null}
      {body ? <Chevron /> : null}
    </>
  );
  return (
    <div className={`chat-tool${open && body ? " is-open" : ""}`} data-status={item.status}>
      <div className="chat-row-line">
        {body ? (
          <button type="button" className="chat-row" aria-expanded={open} onClick={toggle} {...menu.target}>
            {head}
          </button>
        ) : (
          <div className="chat-row is-static" {...menu.target}>
            {head}
          </div>
        )}
        {canBackground ? (
          <button type="button" className="btn chat-mini chat-bg" data-testid="confirm-background" onClick={() => act.runInBackground(ctx!.chatId, item.id)}>
            Run in background
          </button>
        ) : null}
        {/* On touch the row's "..." takes Download's place: Download is its menu's second row. */}
        {file && ctx?.chatId && !menu.touch ? <DownloadButton chatId={ctx.chatId} path={hostPath(file, folder)} folder={folder} testId={`download-${item.id}`} /> : null}
        {menu.opener}
      </div>
      {menu.menu}
      {item.trust ? <TrustLines items={[item]} /> : null}
      {/* R131: a launch row's background sessions, one line each, in the note's place. */}
      {item.launches ? <BackgroundLines items={[item]} /> : null}
      {mcp && ctx?.chatId ? <ViewLine chatId={ctx.chatId} server={mcp.server} id={item.id} readOnly={ctx.readOnly} /> : null}
      {open && body ? <div className="chat-row-body">{body}</div> : null}
    </div>
  );
}

export function TodoRow({ item }: { item: TodoItem }) {
  const [wantOpen, toggle] = useOpen(item.id, "tool", true);
  const done = item.items.filter((t) => t.status === "completed").length;
  // A task row before its first item comes (the call's input streams) has nothing to open.
  const open = wantOpen && item.items.length > 0;
  const head = (
    <>
      <span className="chat-row-icon">
        <IconChecklist size={15} />
      </span>
      <span className="chat-row-verb">To-do list</span>
    </>
  );
  return (
    <div className={`chat-tool chat-todo${open ? " is-open" : ""}`}>
      <div className="chat-row-line">
        {item.items.length ? (
          <button type="button" className="chat-row" aria-expanded={open} onClick={toggle}>
            {head}
            {open ? null : (
              <span className="chat-row-meta">
                {done} of {item.items.length} done
              </span>
            )}
            <Chevron />
          </button>
        ) : (
          <div className="chat-row is-static">{head}</div>
        )}
      </div>
      {open ? (
        <ul className="chat-row-body chat-todos">
          {item.items.map((t, i) => (
            <li key={t.taskId ? `task-${t.taskId}` : `at-${i}`} className={`chat-todo-item is-${t.status}`}>
              <span className="chat-todo-box" aria-hidden="true" />
              <span className="visually-hidden">{t.status === "completed" ? "Done: " : t.status === "in_progress" ? "In progress: " : "To do: "}</span>
              <span className="chat-todo-text">{t.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One row for a run of tool calls between two other rows (Normal and Thinking views). */
export function SummaryRow({ id, items }: { id: string; items: Item[] }) {
  const ctx = useTranscript();
  const [open, toggle] = useOpen(id, null, false);
  const s = summarize(items, ctx?.calls?.waiting);
  // data-rows: its calls' ids, so the reader's place (anchor.ts) finds the summary of a call that a view folds.
  return (
    <div className={`chat-item chat-compact chat-item-summary${open ? " is-open" : ""}`} data-testid={`summary-${items[0]?.id ?? id}`} data-rows={items.map((it) => it.id).join(" ")}>
      <div className="chat-row-line">
        <button type="button" className="chat-row is-summary" aria-expanded={open} onClick={toggle}>
          <span className="chat-row-icon">
            <IconStack size={15} />
          </span>
          <span className="chat-row-label">{s.label}</span>{" "}
          {s.tags.map((t) => (
            <Fragment key={t}>
              <span className={tagClass(t)}>{t}</span>{" "}
            </Fragment>
          ))}
          {/* While it is open, the running call's own row under it carries the time and the spinner (M25's rule). */}
          {s.running && !open ? <Running elapsed={s.elapsed} /> : null}
          <Chevron />
        </button>
      </div>
      {/* R127: closed, the summary row is the first line that holds a refused row, so its line goes here. */}
      {open ? null : <TrustLines items={items} />}
      {open ? null : <BackgroundLines items={items} />}
      {open ? (
        <div className="chat-row-body chat-summary-body">
          {items.map((it) => (
            <ItemView key={it.id} item={it} chatId={ctx?.chatId ?? ""} readOnly={ctx?.readOnly} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
