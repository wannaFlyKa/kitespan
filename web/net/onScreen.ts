// The seen report (owner row 116, DESIGN-R116 section 5): the page tells the server which attached chat it has on
// screen, with `{t: "on_screen", chat, on}`. The server holds one seen flag per chat for every device (D49): a turn
// that ends while no page has the chat on screen leaves it unseen (the list's unread or failed dot), and a page that
// says `on` clears it everywhere. A chat is on screen while all four hold:
//   1. the page is visible (document.visibilityState);
//   2. the route shows the chat's conversation (chat/seen.ts conversationShows);
//   3. the chat is attached and its newest history is drawn;
//   4. the conversation is at its end (the follow state of chat/follow.ts, where Jump to latest does not show).
// The view (chat/ChatView.tsx) judges 2 to 4 on what it drew and calls `view`; this sender adds 1, sends only a
// change, says off when the page hides (at once at pagehide), and never says on from a hidden page. It also holds rule
// 3 for the socket: the store says when it attaches a chat (`attaching`: an open, a reattach, an `attached` frame) and
// when that attach's replay is drawn (`drawn`), and a chat says on only from its `drawn` to its next `attaching` or a
// lost socket. So a page that reconnects, or that comes back to a chat it drew earlier in its life, says on only once the
// new replay is in, never on the history it drew before; the server forgets a socket's `on` when the socket closes,
// so the on goes again then. Like attach, the frame is not a request (no rid, no ack) and changes nothing the user
// made: seen is not an action, so a link only pre-fills (DESIGN.md 5.2). Nothing here touches the DOM; the store
// gives it its socket and the page's state.
// R131 (DESIGN-R131 9.5): a background session's view (/c/<chat>/background/<id>) reports on its own, with the
// session's id (`{t: "on_screen", chat, on, background: id}`): its on sees that session's end, never the chat's, and the
// chat's own on never stands for it. It follows rules 1 and 3 as the chat does (the chat's attach drawn, the page
// visible); its rules 2 and 4 are the view's own (bgView: mounted, with the session's state drawn).
export interface OnScreenDeps {
  /**
   * Write the frame now (`background`: the session's id, for a background session's view); false when it could not go
   * (the socket is down, or the chat is not attached on it).
   */
  write(chat: string, on: boolean, background?: string): boolean;
  /** The page is visible. */
  visible(): boolean;
}

/** A report's key: the chat's id, or the chat's id and a session's id (neither holds a space). */
const keyOf = (chat: string, background?: string) => (background ? `${chat} ${background}` : chat);
const chatOf = (key: string) => key.split(" ")[0]!;
const sessionOf = (key: string): string | undefined => key.split(" ")[1];

export class OnScreen {
  /** What each chat's view (or session's view) says of rules 2 to 4, by key (a view that left is not here). */
  private readonly shown = new Map<string, boolean>();
  /** The last value that went out on this socket, by key (none: off). */
  private readonly sent = new Map<string, boolean>();
  /** The chats whose last attach on this socket is drawn (its replay is in): rule 3. */
  private readonly ready = new Set<string>();
  /** pagehide came and no pageshow since: the page is going (or kept in the back-forward cache). */
  private gone = false;

  constructor(private readonly deps: OnScreenDeps) {}

  /** A chat's view: whether it shows the conversation's end on a drawn chat (rules 2 to 4). */
  view(chat: string, shows: boolean): void {
    this.shown.set(chat, shows);
    this.judge(chat);
  }

  /** The view left (another chat, another screen): off once, and the chat is forgotten. */
  leave(chat: string): void {
    this.shown.delete(chat);
    this.judge(chat);
    this.sent.delete(chat);
  }

  /** R131: a background session's view: whether it is mounted with the session's state drawn. */
  bgView(chat: string, background: string, shows: boolean): void {
    const key = keyOf(chat, background);
    this.shown.set(key, shows);
    this.judge(key);
  }

  /** R131: the session's view left: off once, and it is forgotten. */
  bgLeave(chat: string, background: string): void {
    const key = keyOf(chat, background);
    this.shown.delete(key);
    this.judge(key);
    this.sent.delete(key);
  }

  /** visibilitychange: each chat again. */
  visibility(): void {
    for (const chat of this.chats()) this.judge(chat);
  }

  /** pagehide: off for every chat, whatever visibilityState says yet. */
  hide(): void {
    this.gone = true;
    this.visibility();
  }

  /** pageshow (a page back from the back-forward cache). */
  show(): void {
    this.gone = false;
    this.visibility();
  }

  /** The store attaches the chat (an open, a reattach, an `attached` frame): its new replay is not drawn yet. */
  attaching(chat: string): void {
    this.ready.delete(chat);
    for (const key of this.keysOf(chat)) this.judge(key);
  }

  /** The chat's attach is drawn (its replay is in): a chat on screen that has no `on` on this socket says it now. */
  drawn(chat: string): void {
    this.ready.add(chat);
    for (const key of this.keysOf(chat)) this.judge(key);
  }

  /** The socket is down: the server forgot every on of it, and no attach is drawn on the next one yet. */
  lost(): void {
    this.sent.clear();
    this.ready.clear();
  }

  /** Tests only. */
  reset(): void {
    this.shown.clear();
    this.sent.clear();
    this.ready.clear();
    this.gone = false;
  }

  private chats(): string[] {
    return [...new Set([...this.shown.keys(), ...this.sent.keys()])];
  }

  /** The chat's own key first, then its sessions' views. */
  private keysOf(chat: string): string[] {
    return [chat, ...this.chats().filter((k) => k !== chat && chatOf(k) === chat)];
  }

  private wants(key: string): boolean {
    return !this.gone && this.ready.has(chatOf(key)) && this.shown.get(key) === true && this.deps.visible();
  }

  private judge(key: string): void {
    const on = this.wants(key);
    if ((this.sent.get(key) ?? false) !== on) this.send(key, on);
  }

  private send(key: string, on: boolean): void {
    // A frame that could not go leaves nothing on the server for this socket: off.
    const bg = sessionOf(key);
    this.sent.set(key, (bg ? this.deps.write(chatOf(key), on, bg) : this.deps.write(chatOf(key), on)) && on);
  }
}
