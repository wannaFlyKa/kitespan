// U4 review (FIX-U4, DESIGN-U4 11): Desktop's Close focused pane (Cmd backslash on macOS, Ctrl backslash elsewhere)
// closes the half of the split side panel that holds the focus. The divider between the halves is no half: with the
// focus on it, or after a drag of it (the pointer's last press, the focus left on the body), the key closes nothing
// and the URL stays. In a half it closes that half; with one view, that view. The page's document, history and
// location are stand-ins here, so the real closeFocusedPane runs with its real router.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parse, type Route } from "../../web/router";
import { setSplitLive } from "../../web/layout/split";
import { closeFocusedPane, notePanePress } from "../../web/ui/shortcuts";

const CHAT = "demoolxxxxxxxxxxxxxx";
const P = (rest: string) => `/c/${CHAT}/${rest}`;
const at = (u: string): Route => parse(new URL(u, "http://127.0.0.1"));

/** An element that sits inside the given places: "#fd-side", ".split-divider", and the half ("upper" or "lower"), if any. */
function element(places: string[], half?: "upper" | "lower") {
  const el = {
    isConnected: true,
    closest(selector: string) {
      for (const part of selector.split(",").map((s) => s.trim())) {
        if (part === "[data-half]") return half ? { getAttribute: (n: string) => (n === "data-half" ? half : null) } : null;
        if (places.includes(part)) return el;
      }
      return null;
    },
  };
  return el;
}

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const STUBS = ["document", "history", "location", "requestAnimationFrame"] as const;
let replaced: string[];
let backs: number;
let body: object;

function page(url: string, active: object | null) {
  const u = new URL(url, "http://127.0.0.1");
  g.location = { pathname: u.pathname, search: u.search, href: u.href };
  body = { classList: { contains: () => false } };
  g.document = { activeElement: active ?? body, body, querySelector: () => null };
}

beforeEach(() => {
  for (const k of STUBS) saved[k] = g[k];
  replaced = [];
  backs = 0;
  g.history = {
    state: null,
    replaceState: (_s: unknown, _t: string, u: string) => replaced.push(u),
    pushState: (_s: unknown, _t: string, u: string) => replaced.push(`push ${u}`),
    back: () => backs++,
    go: () => backs++,
  };
  g.requestAnimationFrame = () => 0;
  setSplitLive(true);
});
afterEach(() => {
  for (const k of STUBS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
  notePanePress(null);
  setSplitLive(false);
});

describe("Close focused pane and the divider", () => {
  test("the divider has the focus: nothing closes, the URL stays", () => {
    const url = P("files/src/upload.ts?below=shell");
    page(url, element(["#fd-side", ".split-divider"]));
    expect(closeFocusedPane(at(url))).toBe(false);
    expect([replaced, backs]).toEqual([[], 0]);
  });
  test("a drag of the divider (its press last, the focus on the body): nothing closes", () => {
    const url = P("files/src/upload.ts?below=shell");
    page(url, null);
    notePanePress(element(["#fd-side", ".split-divider"]) as unknown as Element);
    expect(closeFocusedPane(at(url))).toBe(false);
    expect([replaced, backs]).toEqual([[], 0]);
  });
  test("the focus in a half: that half closes, the other view takes the whole pane", () => {
    const url = P("search?q=upl&below=shell");
    page(url, element(["#fd-side"], "upper"));
    expect(closeFocusedPane(at(url))).toBe(true);
    expect(replaced).toEqual([P("shell")]);
    replaced = [];
    page(url, element(["#fd-side"], "lower"));
    expect(closeFocusedPane(at(url))).toBe(true);
    expect(replaced).toEqual([P("search?q=upl")]);
  });
  test("the pointer's last press in a half counts as its focus", () => {
    const url = P("files/src/upload.ts?below=shell");
    page(url, null);
    notePanePress(element(["#fd-side"], "upper") as unknown as Element);
    expect(closeFocusedPane(at(url))).toBe(true);
    expect(replaced).toEqual([P("shell")]);
  });
  test("one view: the key closes it; outside the side panel it does nothing", () => {
    page(P("outputs"), element(["#fd-side"]));
    expect(closeFocusedPane(at(P("outputs")))).toBe(true);
    expect(replaced).toEqual([`/c/${CHAT}`]);
    replaced = [];
    page(P("outputs"), element([".chat-screen"]));
    expect(closeFocusedPane(at(P("outputs")))).toBe(false);
    expect(replaced).toEqual([]);
  });
  test("over the chat (no split shows) a pair's URL shows its own view alone, and the key closes that one view", () => {
    setSplitLive(false);
    const url = P("files/src/upload.ts?below=shell");
    page(url, element([".side-over"]));
    expect(closeFocusedPane(at(url))).toBe(true);
    expect(replaced).toEqual([`/c/${CHAT}`]);
  });
});
