// Claude Code's own lines and quiet rows (DESIGN.md 6.3): the status and retry lines, the refusal notice, info lines
// at their level, the memory recall row, the plugin install rows, the error row (with the sign-in line in place of
// the auth-status message), hook rows (Verbose) and the reconnect dividers. What Claude Code wrote shows as plain text.
import type { ReactNode } from "react";
import type { ErrorItem, HookItem, InfoItem, MemoryItem, PluginItem, ReconnectItem, RefusalItem, RetryItem, StatusItem } from "../../state/types";
import { useOpen } from "./context";
import { delayLabel, plural } from "./format";
import { IconBan, IconCompress, IconError, IconHook, IconInfo, IconMemory, IconPuzzle, IconRetry, IconWarning } from "./icons";
import { ListLines } from "./Lines";
import { Divider } from "./Misc";
import { Chevron } from "./Tool";
import { StartLine } from "../../worktree/StartLine";
import { UnreadableLine, isUnreadableLine } from "../../env/UnreadableLine";

export const SEND_TO_CONTINUE = "Send a message to continue.";
export const SIGN_IN_LINE = "Claude Code could not sign in to its provider. Sign in again in your terminal, then send a message to continue.";
/** Desktop's two rows for a reconnect. */
export const RECONNECT_LINE: Record<ReconnectItem["phase"], string> = {
  loading: "Loading recent output...",
  missing: "Some output produced while you were disconnected may be missing here.",
};
const SCOPE: Record<MemoryItem["items"][number]["scope"], string> = { personal: "Personal", team: "Team", organization: "Organisation" };

/** One quiet line: an icon in the rows' icon column, then text that wraps. */
function Note(props: { icon: ReactNode; tone?: "text" | "bad"; level?: string; children: ReactNode }) {
  const { icon, tone, level, children } = props;
  return (
    <div className={`chat-note${tone ? ` is-${tone}` : ""}`} data-level={level}>
      <span className="chat-row-icon">{icon}</span>
      <p className="chat-note-text">{children}</p>
    </div>
  );
}

/** "Compacting the conversation..." while Claude Code compacts; "Compaction failed." and the error after a failure. */
export function StatusLine({ item }: { item: StatusItem }) {
  if (item.status === "compacting") return <Note icon={<IconCompress size={15} />}>Compacting the conversation...</Note>;
  if (item.compact !== "failed") return null;
  return (
    <Note icon={<IconCompress size={15} />}>
      <span className="chat-note-lead">Compaction failed.</span>
      {item.error ? ` ${item.error}` : null}
    </Note>
  );
}

/** "Retrying (n of m) in N s", with the error kind as words (rate_limit reads "rate limit"). */
export function RetryLine({ item }: { item: RetryItem }) {
  return (
    <Note icon={<IconRetry size={15} />}>
      Retrying ({item.attempt} of {item.max}) in {delayLabel(item.delayMs)}
      {item.error ? (
        <>
          <span className="visually-hidden">, </span>
          <span className="chat-note-tail">{item.error.replace(/_/g, " ")}</span>
        </>
      ) : null}
    </Note>
  );
}

export function RefusalNotice({ item }: { item: RefusalItem }) {
  return (
    <Note icon={<IconBan size={15} />} tone="text">
      {item.text}
    </Note>
  );
}

/** An info line at its level: info and notice quiet, suggestion and warning in the text colour, "Warning" first. */
export function InfoLine({ item }: { item: InfoItem }) {
  // A refused start's line (W4, W5) draws its buttons under it, and Claude Code's own line (also once settled).
  if (item.start || item.detail) return <StartLine item={item} />;
  // D60 (L39): a start that the environment's unreadable variables refused links to the environment.
  if (isUnreadableLine(item)) return <UnreadableLine text={item.text} />;
  const warning = item.level === "warning";
  return (
    <Note icon={warning ? <IconWarning size={15} /> : <IconInfo size={15} />} tone={warning || item.level === "suggestion" ? "text" : undefined} level={item.level}>
      {warning ? <span className="chat-note-lead">Warning </span> : null}
      {item.text}
    </Note>
  );
}

export function PluginLine({ item }: { item: PluginItem }) {
  const icon = <IconPuzzle size={15} />;
  const name = item.name ?? "a plugin";
  switch (item.status) {
    case "started":
      return <Note icon={icon}>Installing plugins...</Note>;
    case "installed":
      return <Note icon={icon}>Installed {name}</Note>;
    case "failed":
      return (
        <Note icon={icon} tone="bad">
          <span className="chat-note-lead">Could not install {name}.</span>
          {item.error ? ` ${item.error}` : null}
        </Note>
      );
    case "completed":
      return <Note icon={icon}>Plugins installed</Note>;
  }
}

/** The error row: the reason, then what to do. A sign-in error says how to sign in again instead. */
/** An assistant message's error code (sdk.d.ts: `rate_limit`, `server_error`, ...) as words; any other text as it is. */
export function errorReason(text: string): string {
  return /^[a-z]+(?:_[a-z]+)+$/.test(text) ? (text[0]!.toUpperCase() + text.slice(1)).replace(/_/g, " ") + "." : text;
}

export function ErrorRow({ item }: { item: ErrorItem }) {
  return (
    <div className="chat-error">
      <span className="chat-row-icon">
        <IconError size={15} />
      </span>
      <div className="chat-error-text">
        <p className="chat-error-reason">{errorReason(item.text)}</p>
        <p className="chat-error-next">{item.signIn ? SIGN_IN_LINE : SEND_TO_CONTINUE}</p>
      </div>
    </div>
  );
}

/** "Recalled from memory": a folded row that opens to one row per memory, its scope and its text or path. */
export function MemoryRow({ item }: { item: MemoryItem }) {
  const [open, toggle] = useOpen(item.id, null, false);
  return (
    <div className={`chat-tool chat-memory${open ? " is-open" : ""}`}>
      <div className="chat-row-line">
        <button type="button" className="chat-row" aria-expanded={open} onClick={toggle}>
          <span className="chat-row-icon">
            <IconMemory size={15} />
          </span>
          <span className="chat-row-label">Recalled from memory</span>{" "}
          <span className="chat-row-meta">{plural(item.items.length, "memory", "memories")}</span>
          <Chevron />
        </button>
      </div>
      {open ? (
        <ul className="chat-row-body chat-mem-list">
          {item.items.map((m, i) => (
            <li key={i} className="chat-mem">
              <span className="chat-mem-scope">{SCOPE[m.scope]}</span>{" "}
              {m.text ? <span className="chat-mem-text">{m.text}</span> : <span className="chat-mem-path mono">{m.path}</span>}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A hook row (Verbose): the hook event and the hook's name; it opens to the hook's output. */
export function HookRow({ item }: { item: HookItem }) {
  const [open, toggle] = useOpen(item.id, null, false);
  const head = (
    <>
      <span className="chat-row-icon">
        <IconHook size={15} />
      </span>
      <span className="chat-row-label">{item.event} hook</span>{" "}
      <span className="chat-row-target mono">{item.name}</span>
      {item.output ? <Chevron /> : null}
    </>
  );
  return (
    <div className={`chat-tool chat-hook${open && item.output ? " is-open" : ""}`}>
      <div className="chat-row-line">
        {item.output ? (
          <button type="button" className="chat-row" aria-expanded={open} onClick={toggle}>
            {head}
          </button>
        ) : (
          <div className="chat-row is-static">{head}</div>
        )}
      </div>
      {open && item.output ? (
        <div className="chat-row-body">
          <ListLines text={item.output} />
        </div>
      ) : null}
    </div>
  );
}

export function ReconnectDivider({ item }: { item: ReconnectItem }) {
  return <Divider text={RECONNECT_LINE[item.phase]} />;
}
