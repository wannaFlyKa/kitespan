// R127 (DESIGN-R127 5): the Trust this folder line under a refused row: one quiet line in S59's note place (the row's
// head, above its open body; or the closed summary row, the folded turn's line, a closed subagent block's head that
// holds the row), with the folder's last two segments in --text and its full path as the title, in every state. Its
// state is the server's, the same on every device (D49), and a change is read out once (role=status). Its one button is
// a link: Trust this folder and Try again open the confirm, Open in terminal opens the Terminal pane with Claude Code's
// own command typed and not run. Nothing here sends anything.
import { useStore } from "../../state/store";
import { Link } from "../../ui/primitives";
import { TRUST_WORDS, lineButton, lineState, trustHref, trustName, trustTerminalHref, type TrustRow } from "../trust";
import { useTranscript, useTrustLines } from "./context";
import type { Item } from "../../state/types";

export function TrustLine({ row }: { row: TrustRow }) {
  const ctx = useTranscript();
  const chatId = ctx?.chatId ?? "";
  const state = useStore((s) => lineState(s.chats.find((c) => c.id === chatId)?.trust, row.path));
  const canAttest = useStore((s) => s.trustFolder);
  const view = ctx && ctx.view !== "normal" ? ctx.view : undefined;
  const w = TRUST_WORDS[state];
  const name = (
    <span className="chat-trust-path" title={row.path}>
      {trustName(row.path)}
    </span>
  );
  const button = lineButton(state, canAttest);
  // Every state names the folder on screen, with its full path as the title. The line takes the focus when the confirm
  // it opened closes and its button is gone (an answer took it away; ui/primitives useLayer's data-focus-return), so the
  // focus stays at the answer.
  return (
    <p className="chat-row-note chat-trust" data-state={state} role="status" tabIndex={-1} data-focus-return="true" data-testid={`trust-line-${row.id}`}>
      <span className="chat-trust-words">
        {w.before}
        {name}
        {w.after}
      </span>
      {button ? (
        <>
          {" "}
          <Link to={button.to === "confirm" ? trustHref(chatId, row.id, view) : trustTerminalHref(chatId, row.id, view)} className="btn chat-mini chat-trust-btn" data-testid={`trust-${button.to}-${row.id}`}>
            {button.label}
          </Link>
        </>
      ) : null}
    </p>
  );
}

/** The lines that the refused rows among `items` (deep) carry here: none inside a folded turn's work or a read-only view. */
export function TrustLines({ items }: { items: readonly Item[] }) {
  const rows = useTrustLines(items);
  return rows.length ? (
    <>
      {rows.map((r) => (
        <TrustLine key={r.id} row={r} />
      ))}
    </>
  ) : null;
}
