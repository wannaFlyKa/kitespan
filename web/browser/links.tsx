// Links from a chat (DESIGN-B1 4.15, DESIGN 9.5 PA-14; Desktop: "The first time you click an external link in the
// chat, a dialog asks whether links open in the Browser pane or in your default browser"). The first click or tap on an
// http or https link in Claude's text asks once per device: "Open links in the browser pane?", with New tab and
// Browser pane; the answer is this device's preference (local storage), which More > Open chat links here and Settings
// > Browser > Open chat links change too. With Browser pane, the click opens the chat's Browser by the opener rules and
// sends tab_new with the address (the user's own press acts, DESIGN 5.1 rule 3); on a page whose browser socket is not
// open yet (a device's first use, when the question shows) it waits briefly for the socket first. With the browser off
// or missing, the pane opens in its state and the address waits in a new tab's field, which says nothing of an external
// link (it came from Claude's text here). Cmd-click, Ctrl-click and a middle click always open a new tab of this device;
// so does a link that the URL rule refuses (kitespan's own page, another scheme).
import { useEffect, useRef, useState } from "react";
import { browserUrlProblem } from "../../shared/browser";
import { navigate, type Route } from "../router";
import { Modal, useModalSheet } from "../dialogs/Modal";
import { openHref, splitLive } from "../layout/split";
import { pageRefusals } from "./address";
import { browserHref, chatLinks, markChatLink, setChatLinks } from "./nav";
import { getBrowser, holdLink, request, whenOpened } from "./store";

export const LINK_WORDS = {
  title: "Open links in the browser pane?",
  line: "Links from chats can open in the browser that you share with Claude, or in a new tab here.",
  where: "You can change this in Settings > Browser.",
  tab: "New tab",
  pane: "Browser pane",
} as const;

/** What a click on a chat's link does: the page's own new tab, the question, or the browser pane. */
export function linkAction(i: { href: string; plain: boolean; pref: "ask" | "pane" | "tab"; refused: boolean }): "tab" | "ask" | "pane" {
  if (!i.plain || i.refused || !/^https?:/i.test(i.href)) return "tab";
  return i.pref === "tab" ? "tab" : i.pref === "ask" ? "ask" : "pane";
}

/** How long a chat link's Browser pane waits for a socket that is not open yet. */
export const LINK_WAIT_MS = 3_000;

/**
 * Open `url` in the chat's Browser: a new tab when the browser runs (the socket opened first if it was not), else the
 * pane with the address waiting. `at` reads the chat and the route when the pane opens.
 */
async function openInPane(at: () => { chat: string; route: Route }, url: string) {
  const release = holdLink();
  let tab: string | null = null;
  let waits = true;
  try {
    const b = getBrowser().opened && getBrowser().link === "open" ? getBrowser() : await whenOpened(LINK_WAIT_MS);
    if (b?.host?.state === "running") {
      const a = await request({ t: "tab_new", url });
      if (a.ok && a.tab) tab = a.tab;
      else waits = !a.ok;
    }
  } finally {
    release();
  }
  const { chat, route } = at();
  const view = typeof route.query.view === "string" ? route.query.view : undefined;
  if (!tab && waits) markChatLink(url);
  navigate(openHref(route, tab ? browserHref(chat, tab, view) : browserHref(chat, null, view, waits ? url : undefined), splitLive()));
}

/** The chat's link clicks (Claude's text only), and the question the first time. Mount once per chat screen. */
export function ChatLinks({ chat, route }: { chat: string; route: Route }) {
  const [ask, setAsk] = useState<string | null>(null);
  const live = useRef({ chat, route });
  live.current = { chat, route };
  const sheet = useModalSheet();
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>(".chat-assistant a[href]") : null;
      if (!a) return;
      const href = a.href;
      const refused = browserUrlProblem(href, pageRefusals(getBrowser().host?.port ?? null)) !== null;
      const act = linkAction({ href, plain: !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey), pref: chatLinks(), refused });
      if (act === "tab") return;
      e.preventDefault();
      if (act === "ask") setAsk(href);
      else void openInPane(() => live.current, href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  if (!ask) return null;
  const answer = (v: "pane" | "tab") => {
    const url = ask;
    setAsk(null);
    setChatLinks(v);
    if (v === "tab") window.open(url, "_blank", "noopener,noreferrer");
    else void openInPane(() => live.current, url);
  };
  return (
    <Modal title={LINK_WORDS.title} testId="browser-links-question" onClose={() => setAsk(null)}>
      <p>{LINK_WORDS.line}</p>
      <p>{LINK_WORDS.where}</p>
      <div className="dialog-actions">
        {sheet ? (
          <>
            <button type="button" className="btn primary" onClick={() => answer("pane")} data-testid="browser-links-pane">
              {LINK_WORDS.pane}
            </button>
            <button type="button" className="btn" onClick={() => answer("tab")} data-testid="browser-links-tab">
              {LINK_WORDS.tab}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => answer("tab")} data-testid="browser-links-tab">
              {LINK_WORDS.tab}
            </button>
            <button type="button" className="btn primary" onClick={() => answer("pane")} data-testid="browser-links-pane">
              {LINK_WORDS.pane}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
