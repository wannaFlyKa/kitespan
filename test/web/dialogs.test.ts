// Archive and delete on the page (D48; BUILD-CHECKLIST E4, E5; DESIGN.md 5.2, 5.4, 6.10, 7.6; MINIMALISM M20, M29 to
// M31): the one archive item a chat offers (Archive, Stop and archive, Unarchive) and the one frame its press sends,
// with the acting page leaving the chat; opening a dialog or a menu sends nothing; the delete confirm's words and the
// phone sheet's Cancel (on the Stop confirm and the rename sheet too); a dialog that a list row opened closes back to
// the list; the Rename form's source line, only while the field holds the saved title; the refused request's line on
// the phone's chat list; the new-chat form's draft on this device; Forget's confirm line; and the session preview
// drawn from the server's page of a transcript.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ChatRow, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { parse } from "../../web/router";
import { connectWith, getState, resetState } from "../../web/state/store";
import { archiveItem, archiveStop, dialogParent, endItems, pressArchive, SCREEN_NOTICE_MS } from "../../web/screens/common";
import { closeTo, pushedState } from "../../web/router";
import { NOTICE_MS } from "../../web/chat/ChatScreen";
import { ChatDialogs, DELETE_LINE } from "../../web/dialogs/ChatDialogs";
import { useAckClose, type AckClose } from "../../web/dialogs/ackClose";
import { acted, doublePress, expand, handlerOf, inRender, propsWhere } from "./presses";
import { SessionMenu } from "../../web/dialogs/SessionMenu";
import { sheetCloseWord } from "../../web/dialogs/Modal";
import { RenameForm } from "../../web/dialogs/RenameForm";
import { FORM_DRAFT_KEY, clearFormDraft, opened, readFormDraft, writeFormDraft, type FormDraft } from "../../web/screens/NewChatForm";
import { forgetLine, previewItems } from "../../web/screens/ProjectScreen";
import { CHATS } from "./fixtures";

const WEB = join(import.meta.dir, "..", "..", "web");
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const PROJECT = "k3m7q2x4ab";

class MemoryStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {}
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

// The router's history and address bar, and the page's frame record, for the presses below.
type Hist = { state: unknown; entries: string[]; pushState: (s: unknown, t: string, u: string) => void; replaceState: (s: unknown, t: string, u: string) => void; back: () => void; go: (n: number) => void };
const g = globalThis as unknown as { window?: { __kitespanFrames?: { t: string }[]; addEventListener?: () => void }; history?: Hist; location?: { pathname: string; search: string; href: string; origin: string } };
const own = { window: !g.window, history: !g.history, location: !g.location };
function goTo(url: string) {
  const u = new URL(url, "http://127.0.0.1");
  g.location = { pathname: u.pathname, search: u.search, href: u.href, origin: u.origin };
}
beforeAll(() => {
  g.window ??= {};
  g.history = {
    state: null,
    entries: [],
    pushState(s, _t, u) {
      this.state = s;
      this.entries.push(`push ${u}`);
      goTo(u);
    },
    replaceState(s, _t, u) {
      this.state = s;
      this.entries.push(`replace ${u}`);
      goTo(u);
    },
    back() {
      this.entries.push("back");
    },
    go(n) {
      this.entries.push(`go ${n}`);
    },
  };
});
afterAll(() => {
  connectWith(null);
  resetState();
  if (own.window) delete g.window;
  if (own.history) delete g.history;
  if (own.location) delete g.location;
});

let sock: FakeSocket;
const row = (over: Partial<ChatRow> = {}): ChatRow => ({ chat: CHAT, title: "Fix the upload", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-10-31T10:00:00.000Z", archived: false, ...over });
function boot(r: ChatRow) {
  resetState();
  sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7945/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: "lz2k3m-abcdefghijkl", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.322", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: [r] });
  (g.window!.__kitespanFrames ??= []).length = 0;
  g.history!.entries = [];
  goTo(`/c/${CHAT}/archive`);
}
const chat = () => getState().chats.find((c) => c.id === CHAT)!;
const acting = () => sock.sent.filter((f) => !["hello", "ping", "attach", "detach", "get"].includes(f.t));
const recorded = () => (g.window!.__kitespanFrames ?? []).map((f) => f.t);

beforeEach(() => {
  if (g.window) (g.window.__kitespanFrames ??= []).length = 0;
});

describe("the archive item and its one frame (D48, 6.10)", () => {
  test("an idle chat: Archive sends archive {on: true, stop: false}, and the page that showed it goes to /", () => {
    boot(row());
    expect(archiveItem(chat())).toEqual({ label: "Archive", testId: "confirm-archive" });
    expect(acting()).toEqual([]);
    pressArchive(chat(), true);
    expect(acting()).toMatchObject([{ t: "archive", chat: CHAT, on: true, stop: false }]);
    expect(recorded()).toEqual(["archive"]);
    expect(g.history!.entries).toEqual(["replace /"]);
  });

  test("a running chat: Stop and archive sends stop: true; from another page the page stays where it is", () => {
    boot(row({ state: "running" }));
    expect(archiveItem(chat())).toEqual({ label: "Stop and archive", testId: "confirm-stop-and-archive" });
    pressArchive(chat(), false);
    expect(acting()).toMatchObject([{ t: "archive", on: true, stop: true }]);
    expect(g.history!.entries).toEqual([]);
  });

  test("a chat whose card waits reads Stop and archive too", () => {
    boot(row({ state: "waiting", needsYou: true }));
    expect(archiveItem(chat()).label).toBe("Stop and archive");
  });

  test("an archived chat: Unarchive sends archive {on: false} and the page stays", () => {
    boot(row({ archived: true, state: "sleeping" }));
    expect(archiveItem(chat())).toEqual({ label: "Unarchive", testId: "confirm-unarchive" });
    expect(endItems(chat())).toEqual(["Unarchive", "Delete"]);
    pressArchive(chat(), true);
    expect(acting()).toMatchObject([{ t: "archive", on: false, stop: false }]);
    expect(recorded()).toEqual(["archive"]);
    expect(g.history!.entries).toEqual([]);
  });

  test("the session menu and a row's menu end with the archive item, then Delete", () => {
    boot(row());
    expect(endItems(chat())).toEqual(["Archive", "Delete"]);
  });

  test("a list row's Archive of an idle chat this page has not attached sends stop: true, so a task it cannot see is no refusal", () => {
    // The row carries no background tasks: the server may hold one and would answer a plain Archive with `busy`.
    boot(row());
    goTo("/chats");
    expect(archiveItem(chat()).label).toBe("Archive");
    expect(archiveStop(chat())).toBe(true);
    pressArchive(chat(), false);
    expect(acting()).toMatchObject([{ t: "archive", chat: CHAT, on: true, stop: true }]);
    expect(g.history!.entries).toEqual([]);
  });

  test("the attached chat's idle Archive stays plain (its tasks are known); a sleeping chat has no process to stop", () => {
    boot(row());
    goTo(`/c/${CHAT}`);
    expect(archiveStop(chat())).toBe(false);
    boot(row({ state: "sleeping" }));
    goTo("/chats");
    expect(archiveStop(chat())).toBe(false);
    pressArchive(chat(), false);
    expect(acting()).toMatchObject([{ t: "archive", on: true, stop: false }]);
  });
});

describe("a dialog that a list row opened closes back to the list (5.1 rule 4)", () => {
  const route = (path: string) => parse(new URL(path, "http://127.0.0.1"));
  const opened = (from: string | null, path = `/c/${CHAT}/delete`) => {
    // An entry this page's router pushed from `from` (a step back stays in this document).
    g.history!.state = from === null ? null : pushedState(null, from);
    g.history!.entries = [];
    goTo(path);
    return route(path);
  };

  test("from /chats (a row's menu or its swipe), Cancel goes back one step to the list, not into the chat", () => {
    const r = opened("/chats");
    expect(dialogParent(CHAT, r)).toBe("/chats");
    closeTo(dialogParent(CHAT, r));
    expect(g.history!.entries).toEqual(["back"]);
    expect(dialogParent(CHAT, opened("/chats?filter=archived"))).toBe("/chats?filter=archived");
  });

  test("from Home, a project page or another chat (the laptop's sidebar), it goes back there", () => {
    expect(dialogParent(CHAT, opened("/"))).toBe("/");
    expect(dialogParent(CHAT, opened(`/p/${PROJECT}`, `/c/${CHAT}/rename`))).toBe(`/p/${PROJECT}`);
    expect(dialogParent(CHAT, opened("/c/pickthetestlayers2ab"))).toBe("/c/pickthetestlayers2ab");
  });

  test("over the chat itself, or opened by a URL with nothing behind it, it closes to the chat's own path", () => {
    expect(dialogParent(CHAT, opened(`/c/${CHAT}`))).toBe(`/c/${CHAT}`);
    expect(dialogParent(CHAT, opened(`/c/${CHAT}/details`))).toBe(`/c/${CHAT}`);
    expect(dialogParent(CHAT, opened(`/c/${CHAT}?view=verbose`, `/c/${CHAT}/rename?view=verbose`))).toBe(`/c/${CHAT}?view=verbose`);
    const direct = opened(null);
    expect(dialogParent(CHAT, direct)).toBe(`/c/${CHAT}`);
    closeTo(dialogParent(CHAT, direct));
    expect(g.history!.entries).toEqual([`replace /c/${CHAT}`]);
    // Never a URL that is not one of the page's own paths.
    expect(dialogParent(CHAT, opened("//elsewhere.invalid/x"))).toBe(`/c/${CHAT}`);
    expect(dialogParent(CHAT, opened("https://elsewhere.invalid/"))).toBe(`/c/${CHAT}`);
    expect(dialogParent(CHAT, opened("/c/notachat!"))).toBe(`/c/${CHAT}`);
  });

  test("opened as a new document after the list (a trail the page seeded, of no document of its own), Cancel replaces with the list", () => {
    g.history!.state = { from: "/chats", back: ["/chats"] };
    g.history!.entries = [];
    goTo(`/c/${CHAT}/rename`);
    const r = route(`/c/${CHAT}/rename`);
    expect(dialogParent(CHAT, r)).toBe("/chats");
    closeTo(dialogParent(CHAT, r));
    expect(g.history!.entries).toEqual(["replace /chats"]);
  });

  test("the chat's dialogs and the Rename form close with dialogParent, and opening one sends nothing", () => {
    const dialogs = readFileSync(join(WEB, "dialogs", "ChatDialogs.tsx"), "utf8");
    expect(dialogs).toContain("const close = () => closeTo(dialogParent(chat.id, route));");
    const rename = readFileSync(join(WEB, "dialogs", "RenameForm.tsx"), "utf8");
    expect(rename).toContain("dialogParent(chat.id, route)");
    expect(rename).not.toContain('chatHref("chat"');
    expect(recorded()).toEqual([]);
  });
});

describe("the delete confirm (6.10, 7.6, E5)", () => {
  test("Delete this chat?, the line that it cannot be undone, then Cancel and Delete", () => {
    expect(DELETE_LINE).toBe("This can't be undone.");
    const src = readFileSync(join(WEB, "dialogs", "ChatDialogs.tsx"), "utf8");
    expect(src).toContain('title="Delete this chat?"');
    expect(src).toMatch(/testId="dialog-delete" onClose=\{onClose\} confirm>/);
    expect(src).toMatch(/data-testid="confirm-delete"[\s\S]*?>\s*Delete\s*</);
    expect(src).toMatch(/testId="dialog-archive" onClose=\{onClose\} confirm>/);
    // No milestone tag and no "keeps the transcript" line: D48 deletes it.
    expect(src).not.toContain("v0.9");
    expect(src).not.toContain("keeps the transcript");
  });

  test("the phone's confirm sheet says Cancel at the top right, where other sheets say Done", () => {
    expect(sheetCloseWord(true)).toBe("Cancel");
    expect(sheetCloseWord(false)).toBe("Done");
    const src = readFileSync(join(WEB, "dialogs", "Modal.tsx"), "utf8");
    // Cancel unless the caller says Done (R127: a confirm with nothing left to cancel), in the regular weight as Cancel.
    expect(src).toContain('word = sheetCloseWord(true)');
    expect(src).toMatch(/className=\{`btn plain sheet-done\$\{word === "Cancel" \? " scr-sheet-cancel" : ""\}`\}[^>]*>\s*\{word\}/);
  });

  test("the Stop confirm is a confirm while there is a turn to stop: Cancel at the top right of the phone's sheet (7.6)", () => {
    const src = readFileSync(join(WEB, "dialogs", "ChatDialogs.tsx"), "utf8");
    const stop = src.slice(src.indexOf("function StopDialog"), src.indexOf("function TerminalDialog"));
    expect(stop).toContain('<Modal title="Stop Claude\'s response?" testId="dialog-stop" onClose={onClose} confirm={active}>');
  });

  test("the phone's rename sheet says Cancel at the top right, so only Save and the keyboard's done key save (6.10)", () => {
    const src = readFileSync(join(WEB, "dialogs", "ChatDialogs.tsx"), "utf8");
    const rename = src.slice(src.indexOf('case "rename":'), src.indexOf('case "archive":'));
    expect(rename).toContain('<CancelSheet title="Rename chat" testId="dialog-rename" onClose={close}>');
    expect(rename).not.toContain("<Popup");
    const modal = readFileSync(join(WEB, "dialogs", "Modal.tsx"), "utf8");
    expect(modal).toMatch(/export function CancelSheet\(/);
  });

  test("the Stop confirm has its title and buttons only (M33); a later route says Not in this version only (M16)", () => {
    const src = readFileSync(join(WEB, "dialogs", "ChatDialogs.tsx"), "utf8");
    const stop = src.slice(src.indexOf("function StopDialog"), src.indexOf("function TerminalDialog"));
    expect(stop).toContain('title="Stop Claude\'s response?"');
    expect(stop).not.toContain("Claude stops at once");
    expect(stop).not.toContain("stays in the chat");
    const later = readFileSync(join(WEB, "screens", "Later.tsx"), "utf8");
    expect(later).toContain("Not in this version.");
    expect(later).not.toMatch(/Comes with|milestoneWords|later-does/);
  });

  test("Delete leaves the chat at once: / with replaceState", () => {
    const src = readFileSync(join(WEB, "dialogs", "ChatDialogs.tsx"), "utf8");
    const press = src.slice(src.indexOf('data-testid="confirm-delete"'));
    expect(press.indexOf("act.remove(chat.id)")).toBeGreaterThan(0);
    expect(press).toMatch(/act\.remove\(chat\.id\);\s*navigate\("\/", \{ replace: true \}\)/);
  });
});

describe("the archive dialog's Cancel (D53) and the closes that wait for the ack", () => {
  const src = readFileSync(join(WEB, "dialogs", "ChatDialogs.tsx"), "utf8");
  const archive = src.slice(src.indexOf("function ArchiveDialog"), src.indexOf("function DeleteDialog"));
  const stop = src.slice(src.indexOf("function StopDialog"), src.indexOf("function TerminalDialog"));

  test("Cancel beside Archive, Stop and archive or Unarchive on the laptop and medium sizes; the phone's confirm sheet has it at the top right", () => {
    expect(archive).toMatch(/\{!sheet \? \(\s*<button ref=\{cancel\} type="button" className="btn" data-autofocus=\{stops \? true : undefined\} onClick=\{onClose\}>\s*Cancel\s*<\/button>/);
    // Cancel comes first, then the action, as in the Delete and Stop confirms.
    expect(archive.indexOf(">\n            Cancel")).toBeLessThan(archive.indexOf("data-testid={item.testId}"));
    // Stop and archive never holds the focus: Cancel takes it (on the sheet, the dialog itself).
    expect(archive).toContain("data-autofocus={stops ? undefined : true}");
    expect(archive).toContain("(cancel.current ?? box).focus({ preventScroll: true });");
    expect(archive).toContain('<Modal title={chat.title} testId="dialog-archive" onClose={onClose} confirm>');
  });

  test("Unarchive, Stop and Rename's Save close on the ok ack only; a refusal keeps the dialog with its line", () => {
    expect(archive).toContain("if (chat.archived) ack.press(act.unarchive(chat.id), onClose);");
    expect(archive).not.toMatch(/act\.unarchive\(chat\.id\);\s*onClose\(\)/);
    expect(stop).toContain("onClick={() => ack.press(act.stop(chat.id), onClose)}");
    const rename = readFileSync(join(WEB, "dialogs", "RenameForm.tsx"), "utf8");
    expect(rename).toContain("ack.press(act.rename(chat.id, clean), () => closeTo(parent));");
    expect(rename).not.toMatch(/act\.rename\(chat\.id, clean\);\s*closeTo\(parent\)/);
    for (const part of [archive, stop, rename]) expect(part).toMatch(/\{ack\.line\}/);
    const hook = readFileSync(join(WEB, "dialogs", "ackClose.ts"), "utf8");
    expect(hook).toContain("if (!open.current) return;");
    expect(hook).toContain("if (ok) close();");
    // The chat screen shows no second copy of that line behind the dialog.
    expect(readFileSync(join(WEB, "chat", "ChatScreen.tsx"), "utf8")).toContain("notice && !OWN_LINE_ROUTES.has(route.name)");
  });
});

describe("a double press is one press (ui/secondPress): a quick answer, or Archive's and Delete's own leave, comes between the two", () => {
  // Each press through the dialog's own handler, drawn as the route draws it; the second click lands 80 ms later
  // wherever the first one did, a later press after the double press's time.
  const dialogAt = (path: string) => {
    goTo(path);
    const route = parse(new URL(path, "http://127.0.0.1"));
    return inRender(() => expand(ChatDialogs({ chat: chat(), route })));
  };
  const swallowedOnce = (press: () => void) => {
    const { second, later } = doublePress(press);
    expect([acted(second), acted(later)]).toEqual([false, true]);
  };

  test("the dialogs that close on the ok ack (useAckClose): Unarchive, Stop, Rename's Save; and the hook's press itself", () => {
    boot(row({ archived: true, state: "sleeping" }));
    swallowedOnce(handlerOf(dialogAt(`/c/${CHAT}/archive`), "confirm-unarchive"));
    expect(acting()).toMatchObject([{ t: "archive", chat: CHAT, on: false }]);
    boot(row({ state: "running" }));
    swallowedOnce(handlerOf(dialogAt(`/c/${CHAT}/stop`), "confirm-stop"));
    boot(row());
    const path = `/c/${CHAT}/rename?title=Flaky%20upload%20test`;
    goTo(path);
    const form = inRender(() => RenameForm({ chat: chat(), route: parse(new URL(path, "http://127.0.0.1")), inline: false, testId: "rename-form" }));
    const submit = handlerOf(form, "rename-form", "onSubmit") as unknown as (e: { preventDefault(): void }) => void;
    swallowedOnce(() => submit({ preventDefault() {} }));
    expect(acting()).toMatchObject([{ t: "rename", chat: CHAT, title: "Flaky upload test" }]);
    // The hook's press, which an environment's Save and Remove and End it here use too.
    const ack = inRender((): AckClose => useAckClose());
    swallowedOnce(() => ack.press(Promise.resolve(true), () => {}));
    for (const [file, call] of [
      ["EnvironmentDialogs.tsx", "ack.press(act.renameProject(project.id, clean)"],
      ["EnvironmentDialogs.tsx", "ack.press(act.removeProject(project.id)"],
      ["ChatDialogs.tsx", "ack.press(\n        act.endHere(chat.id)"],
    ])
      expect(readFileSync(join(WEB, "dialogs", file!), "utf8")).toContain(call!);
    expect(readFileSync(join(WEB, "dialogs", "ackClose.ts"), "utf8")).toContain("press(sent, close) {\n      swallowSecondPress();");
  });

  test("Archive and Delete, which leave the chat at once: the second click would land on the page they go to", () => {
    boot(row());
    swallowedOnce(handlerOf(dialogAt(`/c/${CHAT}/archive`), "confirm-archive"));
    expect(acting()).toMatchObject([{ t: "archive", chat: CHAT, on: true, stop: false }]);
    expect(g.history!.entries).toEqual(["replace /"]);
    boot(row());
    const body = inRender(() => {
      goTo(`/c/${CHAT}/delete`);
      const dialog = expand(ChatDialogs({ chat: chat(), route: parse(new URL(`/c/${CHAT}/delete`, "http://127.0.0.1")) })) as { props: { children: Parameters<typeof expand>[0] } };
      return expand(dialog.props.children);
    });
    swallowedOnce(handlerOf(body, "confirm-delete"));
    expect(acting()).toMatchObject([{ t: "delete", chat: CHAT }]);
    expect(g.history!.entries).toEqual(["replace /"]);
  });
});

describe("Rename (6.10, M29, M30)", () => {
  const renameAt = (c: (typeof CHATS)[number], query: string, inline: boolean) => {
    goTo(`/c/${c.id}/rename${query}`);
    return renderToStaticMarkup(createElement(RenameForm, { chat: c, route: parse(new URL(`http://127.0.0.1/c/${c.id}/rename${query}`)), inline }));
  };
  test("the form says where the title came from, and the phone's sheet has no Current title line", () => {
    const c = { ...CHATS[0]!, titleSource: "generated" as const };
    const html = renameAt(c, "", false);
    expect(html).toContain('data-testid="title-source"');
    expect(html).toContain("Named by Claude Code");
    expect(html).not.toContain("Current title");
  });
  test("the source line describes the saved title: a link's other title in the field shows no source (M30)", () => {
    const c = { ...CHATS[0]!, titleSource: "generated" as const };
    for (const inline of [false, true]) {
      const html = renameAt(c, "?title=Flaky%20upload%20test", inline);
      expect(html).toContain('value="Flaky upload test"');
      expect(html).not.toContain('data-testid="title-source"');
      expect(html).not.toContain("Named by");
    }
    // The title bar's tip floats over the chat, so it is not drawn empty; the sheet keeps the line's height.
    expect(renameAt(c, "?title=Flaky%20upload%20test", true)).not.toContain("scr-rename-tip");
    expect(renameAt(c, "?title=Flaky%20upload%20test", false)).toMatch(/<p class="scr-rename-from" aria-hidden="true">\u00a0<\/p>/);
    // A link whose title is the saved one: the line shows.
    expect(renameAt(c, `?title=${encodeURIComponent(c.title)}`, true)).toContain("Named by Claude Code");
  });
  test("the session menu has no foot line about the title", () => {
    const src = readFileSync(join(WEB, "dialogs", "SessionMenu.tsx"), "utf8");
    expect(src).not.toContain("TITLE_SOURCE");
    expect(src).not.toContain("scr-menu-foot");
    expect(src).not.toContain("v0.9");
  });
});

describe("the session menu's Open in terminal and Side chat open by the opener rules, as the title bar's tools (U4)", () => {
  const menuAt = (path: string) => {
    goTo(path);
    const route = parse(new URL(path, "http://127.0.0.1"));
    return inRender(() => SessionMenu({ open: true, onClose: () => {}, anchor: { current: null }, chat: chat(), route }));
  };
  const item = (path: string, words: string) => propsWhere(menuAt(path), "children", words);

  test("a laptop: the Terminal alone from the chat, below a view that shows, and Close terminal while a half shows it", () => {
    boot(row());
    expect(item(`/c/${CHAT}`, "Open in terminal")).toMatchObject({ to: `/c/${CHAT}/shell?type=resume`, close: false });
    expect(item(`/c/${CHAT}/outputs`, "Open in terminal")).toMatchObject({ to: `/c/${CHAT}/shell?type=resume&above=outputs`, close: false });
    expect(item(`/c/${CHAT}/outputs?below=shell`, "Open in terminal")).toBeNull();
    expect(item(`/c/${CHAT}/outputs?below=shell`, "Close terminal")).toMatchObject({ to: `/c/${CHAT}/outputs`, close: true });
  });

  test("the phone (no split): Side chat opens the side chat; while it shows, the item closes it, and says so", () => {
    boot(row());
    resetState({ ...getState(), sideQuestions: true });
    const g2 = globalThis as unknown as { window: { innerWidth?: number; innerHeight?: number }; matchMedia?: unknown };
    const had = { mm: g2.matchMedia, w: g2.window.innerWidth, h: g2.window.innerHeight };
    g2.matchMedia = (q: string) => ({ matches: q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
    Object.assign(g2.window, { innerWidth: 390, innerHeight: 844 });
    try {
      expect(item(`/c/${CHAT}`, "Side chat")).toMatchObject({ to: `/c/${CHAT}/btw`, close: false });
      expect(item(`/c/${CHAT}/btw`, "Close side chat")).toMatchObject({ to: `/c/${CHAT}`, close: true });
    } finally {
      if (had.mm === undefined) delete g2.matchMedia;
      else g2.matchMedia = had.mm;
      if (had.w === undefined) {
        delete g2.window.innerWidth;
        delete g2.window.innerHeight;
      } else Object.assign(g2.window, { innerWidth: had.w, innerHeight: had.h });
    }
  });
});

describe("the new-chat form's draft on this device (6.9, D49 open point 4)", () => {
  const kv = new MemoryStorage();
  test("it is kept until Start and read back after a reload", () => {
    const d: FormDraft = { session: "7c9e6679-7425-40de-944b-e07fc1f90ae7", text: "Plan the upload feature", fromLink: false, projectId: PROJECT, picked: { model: "claude-haiku-5-5", mode: "plan" } };
    writeFormDraft(d, kv);
    expect(kv.getItem(FORM_DRAFT_KEY)).not.toBeNull();
    expect(readFormDraft(kv)).toEqual({ ...d, picked: { model: "claude-haiku-5-5", effort: undefined, mode: "plan" }, linkText: undefined });
    clearFormDraft(kv);
    expect(readFormDraft(kv)).toBeNull();
    kv.setItem(FORM_DRAFT_KEY, "{not json");
    expect(readFormDraft(kv)).toBeNull();
  });
  test("a link fills its text once, and sets its project and picks each time", () => {
    const d: FormDraft = { session: "s", text: "", fromLink: false, picked: {} };
    const first = opened(d, { project: PROJECT, model: "m1", text: "From the link" });
    expect(first).toMatchObject({ projectId: PROJECT, picked: { model: "m1" }, text: "From the link", fromLink: true, linkText: "From the link" });
    const edited = { ...first, text: "From the link, edited" };
    expect(opened(edited, { project: PROJECT, model: "m1", text: "From the link" }).text).toBe("From the link, edited");
  });
  test("the prompt holds no upload path (D50) and the form has no agent line (D51)", () => {
    const src = readFileSync(join(WEB, "screens", "NewChatForm.tsx"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toContain("draftWithRefs");
    expect(src).not.toContain("support is coming");
  });
});

describe("the project page and the session preview (6.9, M20, M31)", () => {
  test("Forget's confirm says what remembered choices do", () => {
    expect(forgetLine({ name: "kitespan" })).toBe("New chats in kitespan start with these. A Plan pick is never remembered.");
  });
  test("the preview draws the server's page of the transcript as a chat's history, and has no banner", () => {
    const items = previewItems(
      {
        history: [
          { k: "user", uuid: "11111111-2222-4333-8444-555555555555", text: "hello", queued: false },
          { k: "block", key: "msg_1:record-text-0", kind: "text", text: "Hi there.", parent: null },
        ],
      },
      "/tmp/project",
    );
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    const src = readFileSync(join(WEB, "screens", "ProjectScreen.tsx"), "utf8");
    expect(src).not.toContain("Read-only preview");
    expect(src).toContain("Close this session in your terminal first: two processes must not write one session.");
    expect(src).not.toContain("PREVIEW_SESSIONS");
  });
});
