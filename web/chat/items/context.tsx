// What the transcript rows share. Inside a chat, ChatView provides it: the view, the block that the URL opens, the
// message it highlights, and open state that follows the URL (opening a block pushes its route; closing it goes back
// to the chat path). Outside a chat (the read-only session preview) there is no provider, and each row keeps its own
// open state.
import { createContext, useContext, useState } from "react";
import type { Item } from "../../state/types";
import type { CardCalls, View } from "../fold";
import { trustRowsIn, type TrustRow } from "../trust";
import { bgRowsIn, type BgRow } from "../background";

/** The block kinds that have a route of their own (DESIGN.md 5.2). */
export type BlockRoute = "tool" | "agent" | "workflow" | "thinking";

export interface Transcript {
  chatId: string;
  view: View;
  readOnly: boolean;
  /** The block the URL opened (tool, agent, workflow, thinking). */
  openId?: string;
  /** The row the URL highlights (/m/<message>). */
  highlightId?: string;
  /** Row 111: the queued message that carries Send now (the last one, state/sendNow.ts). */
  sendNowId?: string;
  /** This page's press of it stands: the button is gone, and its place is kept. */
  sendNowPressed?: boolean;
  /** Rows a link shows in any view (a thinking block in Normal). */
  reveal?: ReadonlySet<string>;
  /** The calls a card stands for (fold.ts cardCalls): the chat's waiting cards and its card records. */
  calls?: CardCalls;
  /** R127: the rows that carry the Trust this folder line (chat/trust.ts trustRows), by tool use id; none in a read-only view. */
  trust?: ReadonlyMap<string, TrustRow>;
  /** R131: the rows that carry a background session's line (chat/background.ts bgRows), by tool use id; none in a read-only view. */
  background?: ReadonlyMap<string, readonly BgRow[]>;
  isOpen(id: string, byDefault: boolean): boolean;
  toggle(id: string, route: BlockRoute | null, open: boolean): void;
}

const Ctx = createContext<Transcript | null>(null);
export const TranscriptProvider = Ctx.Provider;

export function useTranscript(): Transcript | null {
  return useContext(Ctx);
}

/**
 * R131: the route shows this chat's conversation and its newest history is drawn (the chat's seen report's rules 2 and
 * 3, as ChatView judges them: the phone's sheets and panes cover it otherwise). A background session's line counts as on
 * screen only then, and only while it is in view itself (BackgroundLine), never because the chat is at its end.
 */
const Shown = createContext(false);
export const ConversationShownProvider = Shown.Provider;
export function useConversationShown(): boolean {
  return useContext(Shown);
}

/**
 * R127: the rows under this provider are a folded turn's work (hidden until found): no line goes there, because the
 * turn's own line carries it (DESIGN-R127 5.2).
 */
const Hidden = createContext(false);
export const HiddenWorkProvider = Hidden.Provider;

/** The Trust this folder lines that rows among `items` (deep) carry, where this place draws them; none inside folded work. */
export function useTrustLines(items: readonly Item[]): TrustRow[] {
  const ctx = useContext(Ctx);
  const hidden = useContext(Hidden);
  if (hidden || !ctx?.trust?.size || ctx.readOnly) return [];
  return trustRowsIn(items, ctx.trust);
}

/** R131: the background sessions' lines that rows among `items` (deep) carry here; none inside folded work or a read-only view. */
export function useBackgroundLines(items: readonly Item[]): BgRow[] {
  const ctx = useContext(Ctx);
  const hidden = useContext(Hidden);
  if (hidden || !ctx?.background?.size || ctx.readOnly) return [];
  return bgRowsIn(items, ctx.background);
}

/** A block's open state and its toggle. */
export function useOpen(id: string, route: BlockRoute | null, byDefault: boolean): [boolean, () => void] {
  const ctx = useContext(Ctx);
  const [local, setLocal] = useState<boolean | null>(null);
  if (ctx) {
    const open = ctx.isOpen(id, byDefault);
    return [open, () => ctx.toggle(id, route, open)];
  }
  const open = local ?? byDefault;
  return [open, () => setLocal(!open)];
}

/** The view outside a chat: every row as it is, nested rows unfolded. */
export function useView(): View {
  return useContext(Ctx)?.view ?? "verbose";
}
