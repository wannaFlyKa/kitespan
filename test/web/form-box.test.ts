// The new-chat form's box as a chat's composer (D59, DECISIONS-OWNER row 75; the contracts of FIX-W19d section 4):
// "/" in the empty field opens the / menu over the project's commands and a pick is the command chip, whose command is
// the first message; "/" mid-line opens the same rows as plain text (D57); "@" opens the picker over the project's
// folder and a pick is a mention chip that Start sends in the new_chat frame; the keys, the IME guard and the look are
// the composer's. A "!" stays text (a chat starts with a message, no Bash mode), and a link's text stays plain. The
// rows come from GET /api/projects/:project/commands, asked again once about 3 s later while the server had none (at
// null). The draft keeps its chip and its mentions on this device until Start. No browser: the pure parts run here,
// the store runs on a fake socket, the hook's key order is read from its source (the click-through drives the real
// form: scripts/ui-check.ts, the form flows).
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS, PROTOCOL_VERSION, type ClientFrame, type CommandInfo, type ServerFrame } from "../../shared/protocol";
import { EMPTY, type Draft } from "../../web/composer/draft";
import { COMMANDS_AGAIN_MS, MENU_MAX, MENU_MIN_BELOW, asksAgain, formCanStart, formStartRows, formStartText, formTyped, menuSide, withPath } from "../../web/composer/formBox";
import type { MenuRow } from "../../web/composer/draft";
import { Connection, type SocketLike } from "../../web/net/socket";
import { opened, readFormDraft, writeFormDraft, type FormDraft } from "../../web/screens/NewChatForm";
import { act, connectWith, getState, resetState, type KeyValueStore } from "../../web/state/store";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
/** `part` is in `text` (a short failure line, not the whole file). */
const has = (text: string, part: string) => expect([part, text.includes(part)]).toEqual([part, true]);

const PROJECT = "k3m7q2x4ab";
const chatText = (text: string): Draft => ({ mode: "chat", command: null, text, fromLink: false });

describe("the box's text (formBox.ts)", () => {
  test('"/" typed into the empty field picks the / mode, as in a chat; "!" stays text: no Bash mode', () => {
    expect(formTyped(EMPTY, "/", false)).toEqual({ mode: "slash", command: null, text: "", fromLink: false });
    expect(formTyped(EMPTY, "!", false)).toEqual({ mode: "chat", command: null, text: "!", fromLink: false });
    expect(formTyped(chatText("hello"), "!", true)).toEqual({ mode: "chat", command: null, text: "!", fromLink: false });
    // A / in front of text, or mid-line, is text (the mid-line menu's, D57).
    expect(formTyped(chatText("please"), "/please", false)).toMatchObject({ mode: "chat", text: "/please" });
    expect(formTyped(chatText("test "), "test /", false)).toMatchObject({ mode: "chat", text: "test /" });
  });
  test("a link's text stays plain: /new?text=/x is the text /x, and an edit keeps it so", () => {
    const link: Draft = { mode: "chat", command: null, text: "/compact now", fromLink: true };
    expect(formTyped(link, "/compact now!", false)).toEqual({ mode: "chat", command: null, text: "/compact now!", fromLink: true });
  });
  test("Start sends the message trimmed, or the command chip with its arguments as the first message", () => {
    expect(formStartText(chatText("  Plan it  "))).toBe("Plan it");
    expect(formStartText(chatText("   "))).toBe("");
    expect(formStartText({ mode: "slash", command: "acme-dev-capabilities-plugin:ws-sync-all", text: " all tests ", fromLink: false })).toBe("/acme-dev-capabilities-plugin:ws-sync-all all tests");
    expect(formStartText({ mode: "slash", command: "compact", text: "", fromLink: false })).toBe("/compact");
    // The / mode with no chip yet: the typed command as it is.
    expect(formStartText({ mode: "slash", command: null, text: "zzz", fromLink: false })).toBe("/zzz");
    expect(formStartText({ mode: "slash", command: null, text: "", fromLink: false })).toBe("");
  });
  test("Start as a chat's Send (W19d): a message may be files alone, mention chips or done uploads; a command needs its text", () => {
    const none = { uploads: 0, mentions: 0 };
    expect(formCanStart(chatText("Plan it"), none, false)).toBe(true);
    expect(formCanStart(chatText("  "), none, false)).toBe(false);
    expect(formCanStart(chatText(""), { uploads: 0, mentions: 1 }, false)).toBe(true);
    expect(formCanStart(chatText(""), { uploads: 1, mentions: 0 }, false)).toBe(true);
    // An upload on its way holds Start, as it holds Send.
    expect(formCanStart(chatText("Plan it"), { uploads: 1, mentions: 1 }, true)).toBe(false);
    // The / mode: the command is the message; chips alone start nothing.
    expect(formCanStart({ mode: "slash", command: null, text: "", fromLink: false }, { uploads: 1, mentions: 1 }, false)).toBe(false);
    expect(formCanStart({ mode: "slash", command: "review", text: "", fromLink: false }, none, false)).toBe(true);
  });
  test("the start menu leaves out the built-in commands that act on a conversation that exists (clear, compact), not a user's own", () => {
    const row = (name: string, source: "built-in" | "user" = "built-in"): MenuRow => ({ name, hint: `${name} it`, source });
    const rows = [row("clear"), row("compact"), row("context"), row("review"), row("clear", "user")];
    expect(formStartRows(rows).map((r) => `${r.source}:${r.name}`)).toEqual(["built-in:context", "built-in:review", "user:clear"]);
  });
  test("a mention chip: each path once, in order; unsafe paths and a 101st are refused", () => {
    expect(withPath([], "README.md")).toEqual(["README.md"]);
    const two = withPath(["README.md"], "docs/a b.md");
    expect(two).toEqual(["README.md", "docs/a b.md"]);
    expect(withPath(two!, "README.md")).toBe(two);
    for (const bad of ["/etc/hosts", "../x", "a/../b", "", "a\u0007b"]) expect([bad, withPath([], bad)]).toEqual([bad, null]);
    const full = Array.from({ length: LIMITS.sendMentions }, (_, i) => `f${i}.ts`);
    expect(withPath(full, "one-more.ts")).toBeNull();
  });
  test("the commands are asked again once about 3 s later only while the server had none (at null)", () => {
    expect(COMMANDS_AGAIN_MS).toBeGreaterThanOrEqual(2500);
    expect(COMMANDS_AGAIN_MS).toBeLessThanOrEqual(3500);
    expect(asksAgain({ commands: [], at: null })).toBe(true);
    expect(asksAgain({ commands: [], at: "2026-11-02T10:00:00.000Z" })).toBe(false);
    expect(asksAgain({ commands: [{}], at: null })).toBe(false);
    expect(asksAgain(null)).toBe(false);
    expect(asksAgain(undefined)).toBe(false);
  });
  test("the menus open under the box when there is room for a few rows, else on the side with more room", () => {
    const room = { top: 0, bottom: 800 };
    expect(menuSide({ top: 200, bottom: 300 }, room)).toEqual({ below: true, maxHeight: MENU_MAX });
    // The phone's keyboard leaves little under the box: above, where there is more.
    const low = menuSide({ top: 300, bottom: 420 }, { top: 56, bottom: 508 });
    expect(low.below).toBe(false);
    expect(low.maxHeight).toBe(300 - 56 - 14);
    // Little room on both sides: the larger one, never under 88 px.
    expect(menuSide({ top: 60, bottom: 400 }, { top: 50, bottom: 420 })).toEqual({ below: true, maxHeight: 88 });
    expect(menuSide({ top: 100, bottom: 300 }, { top: 0, bottom: 300 + MENU_MIN_BELOW + 14 })).toMatchObject({ below: true, maxHeight: MENU_MIN_BELOW });
  });
});

// ---- the store: the project's commands and the new_chat frame's mentions ----

class MemoryStorage implements KeyValueStore {
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

const g = globalThis as unknown as { window?: { __kitespanFrames?: { t: string }[] }; localStorage?: MemoryStorage; fetch: typeof fetch };
const own = { window: !g.window, storage: !g.localStorage };
g.window ??= {};
g.localStorage ??= new MemoryStorage();
const realFetch = g.fetch;
let replies: (unknown | number)[] = [];
const asked: string[] = [];
const askedHeaders: Record<string, string>[] = [];
g.fetch = (async (url: string, init?: RequestInit) => {
  asked.push(`${init?.method ?? "GET"} ${url}`);
  askedHeaders.push({ ...((init?.headers ?? {}) as Record<string, string>) });
  const next = replies.shift();
  if (typeof next === "number") return new Response(JSON.stringify({ error: { code: "internal", message: "no" } }), { status: next });
  return new Response(JSON.stringify(next ?? {}), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;
afterAll(() => {
  if (own.window) delete g.window;
  if (own.storage) delete g.localStorage;
  g.fetch = realFetch;
  connectWith(null);
  resetState();
});

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

function boot(): FakeSocket {
  resetState({ projects: [{ id: PROJECT, name: "demo", folder: "/work/demo", picks: {} } as never] });
  const sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7944/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: "lz2k3m-abcdefghijkl", version: "0.3.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.322", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: [] });
  asked.length = 0;
  return sock;
}

const COMMAND: CommandInfo = { name: "acme-dev-capabilities-plugin:ws-sync-all", description: "Sync every package", argumentHint: "[packages]", aliases: [], builtin: false, terminalOnly: false };

describe("the store's project commands (act.loadProjectCommands)", () => {
  test("one GET of /api/projects/:project/commands; the list and its `at` kept per project; two asks at once share it", async () => {
    boot();
    replies = [{ commands: [COMMAND], at: "2026-11-02T10:00:00.000Z" }];
    const [a, b] = await Promise.all([act.loadProjectCommands(PROJECT), act.loadProjectCommands(PROJECT)]);
    expect(asked).toEqual([`GET /api/projects/${PROJECT}/commands`]);
    // The page's own read: the sender header, which only it can send, lets the server start the short read (W19d).
    expect(askedHeaders.at(-1)).toMatchObject({ "x-kitespan": "1" });
    expect(a).toEqual({ commands: [COMMAND], at: "2026-11-02T10:00:00.000Z" });
    expect(b).toBe(a);
    expect(getState().projectCommands[PROJECT]).toEqual({ commands: [COMMAND], at: "2026-11-02T10:00:00.000Z" });
  });
  test("an empty list with at null is kept as it is (the page asks once more later); a failed read changes nothing", async () => {
    boot();
    replies = [{ commands: [], at: null }, 500];
    expect(await act.loadProjectCommands(PROJECT)).toEqual({ commands: [], at: null });
    expect(getState().projectCommands[PROJECT]).toEqual({ commands: [], at: null });
    expect(await act.loadProjectCommands(PROJECT)).toBeNull();
    expect(getState().projectCommands[PROJECT]).toEqual({ commands: [], at: null });
  });
  test("a reply that is not the contract's shape is read as no list", async () => {
    boot();
    replies = [{ commands: "nope", at: 7 }];
    expect(await act.loadProjectCommands(PROJECT)).toEqual({ commands: [], at: null });
  });
});

describe("the new_chat frame's mentions (act.newChat)", () => {
  test("the mention chips go in the frame, paths relative to the project's folder; none: no key", async () => {
    const sock = boot();
    void act.newChat({ projectId: PROJECT, text: "Read these", mentions: ["README.md", "docs/a b.md"] });
    void act.newChat({ projectId: PROJECT, text: "Plain", mentions: [] });
    void act.newChat({ projectId: PROJECT, text: "Older caller" });
    const frames = sock.sent.filter((f) => f.t === "new_chat") as Extract<ClientFrame, { t: "new_chat" }>[];
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ t: "new_chat", project: PROJECT, text: "Read these", uploads: [], mentions: ["README.md", "docs/a b.md"] });
    expect("mentions" in frames[1]!).toBe(false);
    expect("mentions" in frames[2]!).toBe(false);
  });
  test("a command chip's Start: the command with its arguments is the first message", async () => {
    const sock = boot();
    void act.newChat({ projectId: PROJECT, text: formStartText({ mode: "slash", command: COMMAND.name, text: "all tests", fromLink: false }) });
    const f = sock.sent.find((x) => x.t === "new_chat") as Extract<ClientFrame, { t: "new_chat" }>;
    expect(f.text).toBe(`/${COMMAND.name} all tests`);
  });
});

// ---- the form's draft on this device ----

describe("the form's draft keeps the chip and the mentions until Start", () => {
  test("written and read back: the / mode, its command and the mentions with their project", () => {
    const kv = new MemoryStorage();
    const d: FormDraft = { session: "s1", text: "all tests", fromLink: false, projectId: PROJECT, picked: {}, mode: "slash", command: COMMAND.name, mentions: { project: PROJECT, paths: ["README.md"] } };
    writeFormDraft(d, kv);
    expect(readFormDraft(kv)).toEqual({ ...d, picked: { model: undefined, effort: undefined, mode: undefined }, linkText: undefined });
  });
  test("an older draft has none of them; bad values are left out", () => {
    const kv = new MemoryStorage();
    kv.setItem("kitespan.newchat", JSON.stringify({ session: "s2", text: "hi", picked: {} }));
    const old = readFormDraft(kv)!;
    expect([old.mode, old.command, old.mentions]).toEqual([undefined, undefined, undefined]);
    kv.setItem("kitespan.newchat", JSON.stringify({ session: "s3", text: "", picked: {}, mode: "bash", command: 5, mentions: { project: PROJECT, paths: ["../x"] } }));
    const bad = readFormDraft(kv)!;
    expect([bad.mode, bad.command, bad.mentions]).toEqual([undefined, undefined, undefined]);
    // A command with no / mode is no chip.
    kv.setItem("kitespan.newchat", JSON.stringify({ session: "s4", text: "", picked: {}, command: "compact" }));
    expect(readFormDraft(kv)!.command).toBeUndefined();
  });
  test("a link's text replaces the prompt as plain text: no chip; the mentions stay for the same project only", () => {
    const d: FormDraft = { session: "s", text: "args", fromLink: false, projectId: PROJECT, picked: {}, mode: "slash", command: "compact", mentions: { project: PROJECT, paths: ["README.md"] } };
    const linked = opened(d, { text: "/compact now" });
    expect(linked).toMatchObject({ text: "/compact now", fromLink: true, mode: undefined, command: undefined, mentions: { project: PROJECT, paths: ["README.md"] } });
    expect(opened(d, { project: "otherproj2" }).mentions).toBeUndefined();
    expect(opened(d, {}).mode).toBe("slash");
  });
});

// ---- the hook's part (web/composer/useFormBox.ts) and the form's (web/screens/NewChatForm.tsx) ----

describe("the form's box has the composer's keys (useFormBox.ts)", () => {
  const hook = src("composer", "useFormBox.ts");
  const keys = hook.slice(hook.indexOf("const onKeyDown = "), hook.indexOf("// ---- the end of the keys ----"));
  test("the @ picker's keys, then the mid-line menu's, then the start menu's, then Backspace, then Enter's Start", () => {
    const order = ["if (mentionShown) {", "if (slashShown) {", "if (menuVisible && !ime) {", 'if (e.key === "Backspace"', 'if (e.key === "Enter" && !e.shiftKey && !e.altKey) {', "onStart();"].map((p) => keys.indexOf(p));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
  });
  test("the one IME guard for both menus, as the composer's; Enter on touch follows the Return key setting", () => {
    // composer/composition.ts imeKey (DESIGN-T1 T-18): the key's marks with a fine pointer, marked text on touch.
    has(keys, "const ime = imeKey(e.nativeEvent, coarse);");
    has(keys, "const k = mentionKey({ key: e.key, shiftKey: e.shiftKey, ime }, n, mentionCurrent);");
    has(keys, "const k = mentionKey({ key: e.key, shiftKey: e.shiftKey, ime }, n);");
    has(keys, 'if (k === "ime") return;');
    has(keys, 'if (coarse && returnKey !== "send" && !forced) return;');
    has(keys, "if (ime) return;");
    expect(keys.indexOf("if (ime) return;")).toBeLessThan(keys.indexOf('if (coarse && returnKey !== "send" && !forced) return;'));
  });
  test("the menus open from the input event and the caret, never from a key", () => {
    const change = hook.slice(hook.indexOf("const onChange = "), hook.indexOf("const onKeyDown = "));
    has(change, "followMention(nextToken(mention, d, next, caret, inputType.current));");
    has(change, "followSlash(nextSlash(slash, d, next, caret, inputType.current));");
    has(hook, "inputType.current = (e as InputEvent).inputType ?? null;");
    expect(change.indexOf("followSlash(")).toBeLessThan(change.indexOf("inputType.current = null;"));
  });
  test("the start menu leaves out terminal-only rows (no chat to open them in); the mid-line one is plain text", () => {
    has(hook, "commandRows(filtering ? d.text : \"\", true, startRows)");
    has(hook, "const startRows = useMemo(() => formStartRows(rows), [rows]);");
    has(hook, "commandRows(slash.filter, false, rows)");
    const pick = hook.slice(hook.indexOf("const pickSlash = "), hook.indexOf("// ---- the `@` picker ----"));
    has(pick, "const out = slashPick(d.text, slash, c.name);");
    for (const no of ["navigate(", "act.", "onStart(", "command:", "mode:"]) expect([no, pick.includes(no)]).toEqual([no, false]);
  });
  test("a pick of a file is a chip: the @<filter> text leaves the field; no upload, no request", () => {
    const pick = hook.slice(hook.indexOf("const pickMention = "), hook.indexOf("const openAt = "));
    has(pick, "const out = withoutToken(d.text, mention);");
    has(pick, "onMention(row.path);");
    expect(/upload|apiSend|fetch\(/i.test(pick)).toBe(false);
  });
  test("the picker's files are the project's folder (the project corpus routes)", () => {
    has(hook, "useProjectFileEngine(mentionShown ? project : null)");
  });
});

describe("the form (NewChatForm.tsx)", () => {
  const form = src("screens", "NewChatForm.tsx");
  test("the same menus, chips and line as the composer's", () => {
    has(form, "<SlashMenu ");
    has(form, "<MentionMenu ");
    has(form, "<MentionChip ");
    has(form, '<div className="cmp-line scr-line">');
    has(form, '<span className="cmp-chip is-slash" aria-hidden="true" title={d.command ? `/${d.command}` : undefined}>');
    has(form, "<AtButton ");
  });
  test("Start sends the box's text (the command chip's command as the first message) and the mentions", () => {
    has(form, "const message = formStartText(d);");
    // One rule for the key and the button: the composer's (files alone may start a chat, W19d).
    has(form, "const canStart = formCanStart(d, { uploads: uploads.filter((u) => u.state === \"done\").length, mentions: shownMentions.length }, busy);");
    // W3: and none while a Start waits for its ack (one chat, one worktree per press).
    has(form, "if (!canStart || starting) return;");
    has(form, "disabled={!canStart || starting}");
    has(form, "act.newChat({ projectId: project.id, model, effort, mode, text: message, sessionId: session, mentions: shownMentions })");
  });
  test("the rows are the project's commands, read on open and asked again once", () => {
    has(form, "act.loadProjectCommands(");
    has(form, "asksAgain(");
    has(form, "COMMANDS_AGAIN_MS");
  });
});
