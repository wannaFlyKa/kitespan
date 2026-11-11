// The composer row's context ring (DESIGN.md 6.4): how full the chat's context window is, next to the model button as
// Desktop puts its usage ring. Plan limits do not apply on every provider, so the ring shows the context percent, and a
// click opens Context (/c/<chat>/context). On touch nothing hides behind hover, so the percent shows beside the ring
// (7.7). The phone has no ring here: its header carries it (7.2). Until Claude Code reports the chat's window (a
// sleeping or archived chat), a meter draws only its track and shows "..." where the percent goes (6.7).
import { useEffect } from "react";
import { href } from "../router";
import { act, useStore } from "../state/store";
import type { Chat } from "../state/types";
import { Link } from "../ui/primitives";

/**
 * A context meter reads the chat's context (`get`, a read that never starts a sleeping chat): when it shows, after
 * each turn and when the socket comes back. The side panel's Context card reads at the same times; the store shares
 * one get between them.
 */
export function useContextRead(chat: Chat) {
  const netOpen = useStore((s) => s.net === "open");
  const turnOpen = chat.turn !== null;
  useEffect(() => {
    if (netOpen) void act.load(chat.id, "context");
  }, [chat.id, netOpen, turnOpen]);
}

/** A context meter's name while Claude Code has not reported the chat's window (a sleeping or archived chat). */
export const CONTEXT_NOT_READ = "Context, not read yet";
/** The percent's place until Claude Code reports a value (DESIGN.md 6.7: "...", never a made-up value). */
export const CONTEXT_UNKNOWN = "...";

/**
 * What a context meter shows: the percent once Claude Code reported the window (the side panel's Context card has the
 * same rule, panels/cards.tsx), else "..." and only the ring's track, never "0%".
 */
export function contextMeter(chat: Pick<Chat, "context">): { known: boolean; pct: number; text: string; label: string } {
  const known = chat.context.windowTokens > 0;
  const pct = known ? Math.max(0, Math.min(100, Math.round(chat.context.usedPct))) : 0;
  return known ? { known, pct, text: `${pct}%`, label: `Context, ${pct}% used` } : { known, pct, text: CONTEXT_UNKNOWN, label: CONTEXT_NOT_READ };
}

const R = 7;
const C = 2 * Math.PI * R;

/** `to`: U4, where the message box sends it (Context by the split side panel's opener rules); else Context. */
export function ContextRing({ chat, view, open, named, to }: { chat: Chat; view?: string; open: boolean; named: boolean; to?: string }) {
  useContextRead(chat);
  const { pct, text, label } = contextMeter(chat);
  return (
    <Link
      to={to ?? href("context", { chat: chat.id }, { view })}
      className="icon-btn cmp-ring"
      data-testid="composer-context"
      aria-label={label}
      aria-current={open ? "page" : undefined}
      title={label}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={R} className="cmp-ring-track" />
        {pct > 0 ? <circle cx="9" cy="9" r={R} className="cmp-ring-fill" strokeDasharray={`${(C * pct) / 100} ${C}`} transform="rotate(-90 9 9)" /> : null}
      </svg>
      {named ? <span className="cmp-ring-pct">{text}</span> : null}
    </Link>
  );
}
