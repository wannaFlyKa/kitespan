// Iteration 2's component fixes: a stopped tool row and its summary, the list rows' Stop and archive from the server's
// `busy`, and the W11 review's small items. Rendered with React's server renderer; no browser.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemView } from "../../web/chat/items/ItemView";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { summarize } from "../../web/chat/fold";
import { SummaryRow } from "../../web/chat/items/Tool";
import { resetState } from "../../web/state/store";
import type { Chat, Item, ToolItem } from "../../web/state/types";
import { rowMenuItems } from "../../web/screens/ChatListBody";
import { archiveItem, archiveStop, isBusy } from "../../web/screens/common";
import { PLUGINS_UNREAD, PluginsList } from "../../web/composer/PlusMenu";
import { PermissionCardView } from "../../web/chat/cards/PermissionCard";
import { cardOf } from "../../web/state/reduce";
import type { Card as WireCard } from "../../shared/protocol";
import type { PermissionCard } from "../../web/state/types";
import { CHATS, useScriptedCatalog } from "./fixtures";

useScriptedCatalog();

const CHAT_ID = "f1xesxxxxxxxxxxxxxxx";
const ctx: Transcript = { chatId: CHAT_ID, view: "verbose", readOnly: false, isOpen: (_, d) => d, toggle: () => {} };
const inChat = (item: Item) => renderToStaticMarkup(createElement(TranscriptProvider, { value: ctx }, createElement(ItemView, { item, chatId: CHAT_ID })));
const tool = (id: string, name: string, summary: string, status: ToolItem["status"] = "ok"): ToolItem => ({ kind: "tool", id, name, summary, status });

describe("a stopped tool call (tool_stopped): one quiet tag, and its summary does not count it as done", () => {
  test("the row says Stopped once, in the row's plain tag style, with no spinner", () => {
    resetState({ chats: [], projects: [], ready: true });
    const html = inChat(tool("b1", "Bash", "bun test", "stopped"));
    expect(html.match(/Stopped/g)?.length).toBe(1);
    expect(html).toContain('<span class="chat-tag">Stopped</span>');
    expect(html).not.toContain("is-bad");
    expect(html).not.toContain("chat-spin");
  });

  test("the summary leaves a stopped call out of its done words and tags the run Stopped", () => {
    expect(summarize([tool("r", "Read", "a"), tool("b", "Bash", "x", "stopped")])).toEqual({ label: "Read 1 file", running: false, tags: ["Stopped"] });
    expect(summarize([tool("b1", "Bash", "x"), tool("b2", "Bash", "y", "stopped")]).label).toBe("Ran 1 command");
    // Nothing done: the words of what ran when it stopped, never a count of done calls.
    expect(summarize([tool("b", "Bash", "x", "stopped")])).toEqual({ label: "Running a command", running: false, tags: ["Stopped"] });
    expect(summarize([tool("e", "Bash", "x", "error"), tool("b", "Bash", "y", "stopped")]).tags).toEqual(["Error", "Stopped"]);
  });

  test("the summary row draws Stopped quiet and Error as bad", () => {
    resetState({ chats: [], projects: [], ready: true });
    const ctxNormal: Transcript = { ...ctx, view: "normal" };
    const items: Item[] = [tool("e", "Bash", "x", "error"), tool("b", "Bash", "y", "stopped")];
    const sum = renderToStaticMarkup(createElement(TranscriptProvider, { value: ctxNormal }, createElement(SummaryRow, { id: "s", items })));
    expect(sum).toContain('<span class="chat-tag is-bad">Error</span>');
    expect(sum).toContain('<span class="chat-tag">Stopped</span>');
  });
});

describe("the list rows read the server's busy (D48): Stop and archive in the menu, the long-press and the swipe", () => {
  const idle = CHATS.find((c) => c.id === "idleo6xxxxxxxxxxxxxx")!;
  // A row the page has not attached: no turn, no card and no task it knows of; only the chat list's `busy` says it.
  const busyRow = { ...idle, busy: true } as Chat;
  test("a busy row's archive item is Stop and archive, and its frame carries stop", () => {
    expect(isBusy(idle)).toBe(false);
    expect(isBusy(busyRow)).toBe(true);
    expect(rowMenuItems(busyRow)).toEqual(["Rename", "Open in terminal", "Stop and archive", "Delete"]);
    // The swipe's first action is the same item (ChatListBody draws archiveItem's label there too).
    expect(archiveItem(busyRow)).toEqual({ label: "Stop and archive", testId: "confirm-stop-and-archive" });
    expect(archiveStop(busyRow)).toBe(true);
  });
  test("busy false leaves the row as its own state says", () => {
    expect(rowMenuItems({ ...idle, busy: false } as Chat)[2]).toBe("Archive");
    expect(archiveItem({ ...idle, busy: true, archived: true } as Chat).label).toBe("Unarchive");
  });
});

describe("the + menu's Plugins (6.5): the chat's plugins with their versions, not a dead link", () => {
  const html = (plugins: Parameters<typeof PluginsList>[0]["plugins"]) => renderToStaticMarkup(createElement(PluginsList, { plugins }));
  const words = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  test("each plugin the chat loaded, with its version when its manifest declares one", () => {
    const out = html([{ name: "lint-tools", version: "1.4.0" }, { name: "notes", version: null }]);
    expect(words(out)).toBe("lint-tools 1.4.0 notes");
    expect(out).not.toMatch(/<a |<button/);
  });
  test("none loaded says None; a chat whose Claude Code has not started yet says how to read it", () => {
    expect(words(html([]))).toBe("None");
    expect(words(html(null))).toBe(PLUGINS_UNREAD);
    expect(PLUGINS_UNREAD).toBe("Send a message to read it.");
  });
});

describe("a plan's record keeps the text sent with No, keep planning", () => {
  test("the note shows under the record, once; an approved plan has none", () => {
    resetState({ chats: [], projects: [], ready: true });
    const plan = (answered: "keep-planning" | "auto", note?: string): Item => ({ kind: "card", id: "card-p1", card: { kind: "plan", id: "p1", markdown: "1. Do it", answered, ...(note ? { note } : {}) } });
    const kept = inChat(plan("keep-planning", "Split the migration first."));
    expect(kept.match(/Split the migration first\./g)?.length).toBe(1);
    expect(kept).toContain('class="chat-record-note"');
    expect(inChat(plan("auto"))).not.toContain("chat-record-note");
  });
});

describe("the W11 review's small items that the components hold", () => {
  test("a permission card with no title from Claude Code says Allow Claude to use <tool>? (the prototype's words)", () => {
    resetState({ chats: [], projects: [], ready: true });
    const wire: WireCard = { kind: "permission", id: "toolu_b1", toolUseId: "toolu_b1", toolName: "Bash", title: null, displayName: null, description: null, reason: null, blockedPath: null, input: { command: "ls" }, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: true, parent: null };
    const chat = { ...CHATS[0]!, id: CHAT_ID, pending: [] } as Chat;
    const out = renderToStaticMarkup(createElement(PermissionCardView, { chat, card: cardOf(wire) as PermissionCard, cardRef: { current: null } }));
    expect(out).toContain("Allow Claude to use Bash?");
    const titled = renderToStaticMarkup(createElement(PermissionCardView, { chat, card: cardOf({ ...wire, title: "Claude wants to list the folder" }) as PermissionCard, cardRef: { current: null } }));
    expect(titled).toContain("Claude wants to list the folder");
    expect(titled).not.toContain("Allow Claude to use");
  });
});
