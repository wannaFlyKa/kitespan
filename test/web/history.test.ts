// Back and Forward around the side panel (DESIGN.md 5.1 rule 4, 5.5 step 3): closing the pane or the sheet from a
// detail view goes back over every entry the panel pushed, so no dead entry is left behind. Closing never goes back to
// an earlier document of the tab (a link opened as a new document): it replaces. A reload keeps the document's id,
// because the entries pushed before it share the reloaded entry's document. The router reads the global history and
// location; this test gives it a small memory copy of both, and removes them at the end.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ENTRY_URLS_KEY, TRAIL_MAX, closeSteps, closeTo, currentUrl, documentId, entriesBefore, navigate, pushedState, readEntryUrls, rememberEntry, seedHistory, seededState, setSameView, type EntryState } from "../../web/router";

class MemoryHistory {
  entries: { url: string; state: unknown }[] = [{ url: "/", state: null }];
  at = 0;
  get state() {
    return this.entries[this.at]!.state;
  }
  get length() {
    return this.entries.length;
  }
  pushState(state: unknown, _title: string, url: string) {
    this.entries = this.entries.slice(0, this.at + 1);
    this.entries.push({ url, state: structuredClone(state) });
    this.at++;
  }
  replaceState(state: unknown, _title: string, url?: string) {
    this.entries[this.at] = { url: url ?? this.entries[this.at]!.url, state: structuredClone(state) };
  }
  go(n: number) {
    this.at = Math.max(0, Math.min(this.entries.length - 1, this.at + n));
  }
  back() {
    this.go(-1);
  }
  forward() {
    this.go(1);
  }
  /** Start again at one entry with no state, as a fresh tab does. */
  reset(url: string) {
    this.entries = [{ url, state: null }];
    this.at = 0;
  }
  urls() {
    return this.entries.map((e) => e.url);
  }
}

const mem = new MemoryHistory();
const g = globalThis as Record<string, unknown>;
const had = { history: g.history, location: g.location };

beforeAll(() => {
  g.history = mem;
  g.location = {
    get pathname() {
      return mem.entries[mem.at]!.url.split("?")[0];
    },
    get search() {
      const q = mem.entries[mem.at]!.url.indexOf("?");
      return q >= 0 ? mem.entries[mem.at]!.url.slice(q) : "";
    },
  };
});
afterAll(() => {
  setSameView(null);
  if (had.history === undefined) delete g.history;
  else g.history = had.history;
  if (had.location === undefined) delete g.location;
  else g.location = had.location;
});

const CHAT = "/c/idleo6xxxxxxxxxxxxxx";

describe("the trail an entry keeps", () => {
  test("a pushed entry names the entry before it and the ones behind that, newest first, and how many are this document's", () => {
    expect(pushedState(null, "/", "doc1")).toEqual({ from: "/", back: ["/"], doc: "doc1", inDoc: 1 });
    expect(pushedState({ from: "/", back: ["/"], doc: "doc1", inDoc: 1 }, CHAT, "doc1")).toEqual({ from: CHAT, back: [CHAT, "/"], doc: "doc1", inDoc: 2 });
    // An entry made before the trail existed has only `from`; the entry on screen is this document's, the one behind it unknown.
    expect(pushedState({ from: "/" }, CHAT, "doc1")).toEqual({ from: CHAT, back: [CHAT, "/"], doc: "doc1", inDoc: 1 });
    // Pushed from an entry of an earlier document (a reload since, or a seeded trail): only that entry is this document's.
    expect(pushedState({ from: "/", back: ["/"], doc: "doc0", inDoc: 1 }, CHAT, "doc1")).toEqual({ from: CHAT, back: [CHAT, "/"], doc: "doc1", inDoc: 1 });
    expect(pushedState({ from: "/", back: ["/"] }, CHAT, "doc1").inDoc).toBe(1);
  });
  test("the trail keeps at most TRAIL_MAX entries", () => {
    let st: EntryState | null = null;
    for (let i = 0; i < TRAIL_MAX + 5; i++) st = pushedState(st, `/c/c_n${i}`);
    expect(st!.back!.length).toBe(TRAIL_MAX);
    expect(st!.back![0]).toBe(`/c/c_n${TRAIL_MAX + 4}`);
    expect(st!.inDoc).toBe(TRAIL_MAX);
  });
});

describe("closing the side panel", () => {
  test("Details, then Context, then Close: Back leaves the chat, Forward opens Details and then Context again", () => {
    mem.reset("/");
    navigate(CHAT);
    navigate(`${CHAT}/details`);
    navigate(`${CHAT}/context`);
    closeTo(CHAT);
    expect(currentUrl()).toBe(CHAT);
    expect(mem.at).toBe(1); // went back over both panel entries; nothing was replaced
    expect(mem.urls()).toEqual(["/", CHAT, `${CHAT}/details`, `${CHAT}/context`]);
    mem.back();
    expect(currentUrl()).toBe("/");
    mem.forward();
    expect(currentUrl()).toBe(CHAT);
    mem.forward();
    expect(currentUrl()).toBe(`${CHAT}/details`);
    mem.forward();
    expect(currentUrl()).toBe(`${CHAT}/context`);
  });
  test("the transcript view in the query goes along", () => {
    mem.reset("/");
    navigate(`${CHAT}?view=verbose`);
    navigate(`${CHAT}/details?view=verbose`);
    navigate(`${CHAT}/outputs?view=verbose`);
    navigate(`${CHAT}/files/src/upload.ts?view=verbose`);
    closeTo(`${CHAT}?view=verbose`);
    expect(currentUrl()).toBe(`${CHAT}?view=verbose`);
    expect(mem.at).toBe(1);
  });
  test("Files, then a file, then Details, then Close: back over all three", () => {
    mem.reset("/");
    navigate(CHAT);
    navigate(`${CHAT}/uploads`);
    navigate(`${CHAT}/files/notes.md`);
    navigate(`${CHAT}/details`);
    closeTo(CHAT);
    expect(currentUrl()).toBe(CHAT);
    expect(mem.at).toBe(1);
  });
  test("a detail's Back row goes back to Details when Details is the entry before", () => {
    mem.reset("/");
    navigate(CHAT);
    navigate(`${CHAT}/details`);
    navigate(`${CHAT}/connectors`);
    closeTo(`${CHAT}/details`);
    expect(currentUrl()).toBe(`${CHAT}/details`);
    expect(mem.at).toBe(2);
  });
  test("a detail opened from the chat (the context ring): Back row replaces with Details, then Close goes back to the chat", () => {
    mem.reset("/");
    navigate(CHAT);
    navigate(`${CHAT}/context`);
    closeTo(`${CHAT}/details`);
    expect(mem.urls()).toEqual(["/", CHAT, `${CHAT}/details`]);
    closeTo(CHAT);
    expect(currentUrl()).toBe(CHAT);
    expect(mem.at).toBe(1);
  });
  test("a panel opened by a deep link, with no entry for the chat behind it, closes by replacing", () => {
    mem.reset(`${CHAT}/details`);
    navigate(`${CHAT}/context`);
    closeTo(CHAT);
    expect(mem.urls()).toEqual([`${CHAT}/details`, CHAT]);
  });
  test("an entry of another chat between them stops the walk: the close replaces", () => {
    mem.reset("/");
    navigate(CHAT);
    navigate("/c/demoolxxxxxxxxxxxxxx/details");
    navigate(`${CHAT}/details`);
    closeTo(CHAT);
    expect(mem.urls()).toEqual(["/", CHAT, "/c/demoolxxxxxxxxxxxxxx/details", CHAT]);
  });
  test("outside the panel the rule is the old one: back only when the entry before is the parent", () => {
    mem.reset("/");
    navigate(CHAT);
    navigate(`${CHAT}/m/m_a`);
    navigate(`${CHAT}/tool/tu_b`);
    closeTo(CHAT);
    expect(mem.urls()).toEqual(["/", CHAT, `${CHAT}/m/m_a`, CHAT]);
    mem.reset("/");
    navigate(CHAT);
    navigate(`${CHAT}/rename`);
    closeTo(CHAT);
    expect(mem.at).toBe(1);
    expect(mem.length).toBe(3);
  });
});

describe("the laptop column's same view", () => {
  const sameCards = (a: string, b: string) => a.replace(/\/details(?=$|\?)/, "") === b.replace(/\/details(?=$|\?)/, "");
  test("a detail opened from the chat goes back to the chat when its Back row asks for Details", () => {
    mem.reset("/");
    navigate(CHAT);
    navigate(`${CHAT}/context`);
    setSameView(sameCards);
    try {
      closeTo(`${CHAT}/details`);
    } finally {
      setSameView(null);
    }
    expect(currentUrl()).toBe(CHAT);
    expect(mem.at).toBe(1);
  });
  test("Details from the chat replaces the entry while the column shows the cards already", () => {
    mem.reset("/");
    navigate(CHAT);
    setSameView(sameCards);
    try {
      navigate(`${CHAT}/details`);
      expect(mem.urls()).toEqual(["/", `${CHAT}/details`]);
      navigate(`${CHAT}/context`);
      expect(mem.length).toBe(3); // a detail view is no same view: it pushes
    } finally {
      setSameView(null);
    }
    navigate(`${CHAT}/outputs`);
    expect(mem.length).toBe(4); // with no rule (another layout), every link pushes as before
  });
  test("closeSteps counts the entries to go back, and 0 means replace", () => {
    const st = { from: `${CHAT}/details`, back: [`${CHAT}/details`, CHAT, "/"], doc: "doc1", inDoc: 3 };
    expect(closeSteps(st, `${CHAT}/context`, `${CHAT}/details`, null, "doc1")).toBe(1);
    expect(closeSteps(st, `${CHAT}/context`, CHAT, null, "doc1")).toBe(2);
    expect(closeSteps(st, `${CHAT}/context`, "/", null, "doc1")).toBe(0); // the chat is not a panel view
    expect(closeSteps(null, `${CHAT}/context`, CHAT, null, "doc1")).toBe(0);
    expect(closeSteps({ from: CHAT, back: [CHAT], doc: "doc1", inDoc: 1 }, `${CHAT}/rename`, CHAT, null, "doc1")).toBe(1);
    expect(closeSteps({ from: CHAT, back: [CHAT], doc: "doc1", inDoc: 1 }, `${CHAT}/context`, `${CHAT}/details`, sameCards, "doc1")).toBe(1);
  });
  test("closeSteps goes back over this document's entries only: an earlier document's trail, or one with no document, is a replace", () => {
    const st = { from: `${CHAT}/details`, back: [`${CHAT}/details`, CHAT, "/"], doc: "doc1", inDoc: 3 };
    // A reload since: the entries behind belong to the document before it.
    expect(closeSteps(st, `${CHAT}/context`, CHAT, null, "doc2")).toBe(0);
    // Details is this document's, the chat's entry behind it an earlier document's: the walk stops before it.
    expect(closeSteps({ ...st, inDoc: 1 }, `${CHAT}/context`, CHAT, null, "doc1")).toBe(0);
    expect(closeSteps({ ...st, inDoc: 1 }, `${CHAT}/context`, `${CHAT}/details`, null, "doc1")).toBe(1);
    // A seeded trail (seedHistory: the entries of the tab's earlier documents) names no document.
    expect(closeSteps({ from: CHAT, back: [CHAT] }, `${CHAT}/send?text=hi`, CHAT, null, "doc1")).toBe(0);
    expect(closeSteps({ from: CHAT }, `${CHAT}/rename`, CHAT, null, "doc1")).toBe(0);
  });
});

describe("an entry that opened a new document (a link to an action route, a URL typed after a kitespan page)", () => {
  const ORIGIN = "http://127.0.0.1:7941";
  const nav = (urls: string[], current: number) => ({ currentEntry: { index: current }, entries: () => urls.map((url, index) => ({ url, index })) });

  test("an entry whose URL the Navigation API hides (the server's no-referrer policy) is read from the tab's own record, by its key", () => {
    const hidden = { currentEntry: { index: 2, key: "k3" }, entries: () => [{ url: null, index: 0, key: "k1" }, { url: null, index: 1, key: "k2" }, { url: `${ORIGIN}${CHAT}/rename`, index: 2, key: "k3" }] };
    expect(entriesBefore(hidden, "", ORIGIN, 3, { k2: CHAT, k1: "/" })).toEqual([CHAT, "/"]);
    // A key this tab never noted ends the list: nothing is guessed.
    expect(entriesBefore(hidden, "", ORIGIN, 3, { k1: "/" })).toEqual([]);
    const store = new Map<string, string>();
    const kv = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    rememberEntry({ currentEntry: { index: 0, key: "k1" }, entries: () => [] }, kv, "/");
    rememberEntry({ currentEntry: { index: 1, key: "k2" }, entries: () => [] }, kv, CHAT);
    rememberEntry({ currentEntry: { index: 1, key: "k2" }, entries: () => [] }, kv, `${CHAT}?view=verbose`); // a replace keeps the key
    expect(readEntryUrls(kv)).toEqual({ k1: "/", k2: `${CHAT}?view=verbose` });
    for (let i = 0; i < 80; i++) rememberEntry({ currentEntry: { index: i, key: `n${i}` }, entries: () => [] }, kv, "/");
    expect(Object.keys(readEntryUrls(kv)).length).toBe(64);
    store.set(ENTRY_URLS_KEY, "{not json");
    expect(readEntryUrls(kv)).toEqual({});
  });

  test("the tab's kitespan entries before it, newest first, from the Navigation API; else a same-origin referrer", () => {
    // entries() lists only the tab's same-origin entries around this one: about:blank and other sites are not in it.
    expect(entriesBefore(nav([`${ORIGIN}/`, `${ORIGIN}${CHAT}`, `${ORIGIN}${CHAT}/rename?title=Better%20name`], 2), "", ORIGIN, 3)).toEqual([CHAT, "/"]);
    expect(entriesBefore(nav([`${ORIGIN}${CHAT}/rename`], 0), "", ORIGIN, 2)).toEqual([]);
    expect(entriesBefore(null, `${ORIGIN}${CHAT}?view=verbose`, ORIGIN, 2)).toEqual([`${CHAT}?view=verbose`]);
    expect(entriesBefore(null, "https://example.com/c/x", ORIGIN, 2)).toEqual([]);
    // A tab of its own (a link opened in a new tab) has nothing behind it, whatever its referrer says.
    expect(entriesBefore(null, `${ORIGIN}${CHAT}`, ORIGIN, 1)).toEqual([]);
    expect(entriesBefore(null, "", ORIGIN, 3)).toEqual([]);
  });

  test("an entry with no state of its own takes the entry before as its from; one that has a trail keeps it", () => {
    expect(seededState(null, [CHAT, "/"])).toEqual({ from: CHAT, back: [CHAT, "/"] });
    expect(seededState({ section: "general" }, [CHAT])).toEqual({ section: "general", from: CHAT, back: [CHAT] } as EntryState);
    expect(seededState({ from: "/" }, [CHAT])).toBe(null);
    expect(seededState({ back: ["/"] }, [CHAT])).toBe(null);
    expect(seededState(null, [])).toBe(null);
    const long = Array.from({ length: TRAIL_MAX + 4 }, (_, i) => `/c/${String(i).padStart(20, "x")}`);
    expect(seededState(null, long)!.back!.length).toBe(TRAIL_MAX);
  });

  test("opened after the chat as a new document, it knows the chat as its from, and Close replaces: it never goes back to the earlier document", () => {
    mem.entries = [{ url: CHAT, state: null }, { url: `${CHAT}/rename?title=Better%20name`, state: null }];
    mem.at = 1;
    // The chat's document noted its entry; the rename document finds it behind its own, with the URL hidden.
    const store = new Map<string, string>([[ENTRY_URLS_KEY, JSON.stringify({ k1: CHAT })]]);
    const kv = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const hidden = { currentEntry: { index: 1, key: "k2" }, entries: () => [{ url: null, index: 0, key: "k1" }, { url: `${ORIGIN}${CHAT}/rename?title=Better%20name`, index: 1, key: "k2" }] };
    seedHistory({ nav: hidden, referrer: "", origin: ORIGIN, store: kv });
    expect(mem.state).toEqual({ from: CHAT, back: [CHAT] });
    // A step back would unload this page (with a frame that Save just gave the socket): the chat replaces the entry.
    closeTo(CHAT);
    expect([mem.at, mem.urls()]).toEqual([1, [CHAT, CHAT]]);
    // A typed URL in a fresh tab has nothing behind it: Close replaces, as before.
    mem.reset(`${CHAT}/rename`);
    seedHistory({ nav: nav([`${ORIGIN}${CHAT}/rename`], 0), referrer: "", origin: ORIGIN, store: null });
    expect(mem.state).toBe(null);
    closeTo(CHAT);
    expect(mem.urls()).toEqual([CHAT]);
  });

  test("a reload, or a Back or Forward that loads the page again, keeps the id of the entry it opens; a new page load makes a new one", () => {
    const fresh = () => "the-new-document";
    expect(documentId({ from: CHAT, back: [CHAT, "/"], doc: "doc1", inDoc: 2 }, fresh)).toBe("doc1");
    // A link or a typed URL opens an entry with no state; a seeded trail (seedHistory) names no document.
    expect(documentId(null, fresh)).toBe("the-new-document");
    expect(documentId({ from: CHAT, back: [CHAT] }, fresh)).toBe("the-new-document");
    expect(documentId({ doc: 7 }, fresh)).toBe("the-new-document");
    expect(documentId("not an object", fresh)).toBe("the-new-document");
  });

  test("after a reload, the entries this page pushed before it stay in the page (they share the reloaded entry's document): Close goes back", () => {
    mem.reset("/");
    navigate(CHAT);
    navigate(`${CHAT}/rename`);
    // The reload keeps the entry's state, and the reloaded page takes its document id from it.
    const st = mem.state as EntryState;
    const doc = documentId(st, () => "the-new-document");
    expect(closeSteps(st, `${CHAT}/rename`, CHAT, null, doc)).toBe(1);
    // A sheet over the chat's panel, opened before the reload: back over both panel views, as before it.
    mem.reset("/");
    navigate(CHAT);
    navigate(`${CHAT}/details`);
    navigate(`${CHAT}/context`);
    const panel = mem.state as EntryState;
    expect(closeSteps(panel, `${CHAT}/context`, CHAT, null, documentId(panel, () => "the-new-document"))).toBe(2);
    // An entry of an earlier document of the tab (another id) still closes by replacing.
    expect(closeSteps(panel, `${CHAT}/context`, CHAT, null, "the-new-document")).toBe(0);
  });
});
