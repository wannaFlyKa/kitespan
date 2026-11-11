// R131 on the wire (shared/protocol.ts and shared/route.ts; DESIGN-R131 section 10; version 4, no raise): the launches
// on a tool result (never cut with its text), the `background` event and its worker, `attached.background`, the chat
// row's own field, `on_screen.background`, the `background_stop` request and its ack, the pane's `type_attach`, and the
// routes (the view and the Stop confirm name the chat and the short id, never a path or a session id; the shell route's
// `type=attach` with `bg`).
import { describe, expect, test } from "bun:test";
import {
  BG_LIMITS,
  BG_ROW_STATES,
  BG_STATES,
  BG_STOP_ANSWERS,
  BG_WAITS,
  CLIENT_FRAME_TYPES,
  PROTOCOL_VERSION,
  REQUEST_TYPES,
  SHELL_TYPED_CASES,
  ackOk,
  bgLaunchesOf,
  bgWorkerOf,
  capEvent,
  parseClientFrame,
  parseShellControl,
  type BgWorker,
  type ChatEvent,
} from "../../shared/protocol";
import { BG_ID } from "../../shared/ids";
import { PARAM_RULES, ROUTE_BY_NAME, SHELL_TYPES, href, parsePath } from "../../shared/route";

const RID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const ID = "3f9a1c2e";
const parse = (o: unknown) => parseClientFrame(JSON.stringify(o));
const worker = (over: Partial<BgWorker> = {}): BgWorker => ({ state: "working", name: "investigate", folder: "/srv/you/shop/worktrees/qty", view: true, startedAt: 1_762_300_000_000, ...over });

describe("background_stop", () => {
  const frame = (over: Record<string, unknown> = {}) => ({ t: "background_stop" as const, rid: RID, chat: CHAT, id: ID, ...over });
  test("parses to exactly its fields; a request with an ack", () => {
    expect(parse({ ...frame(), path: "/etc", session: RID })).toEqual({ ok: true, frame: frame() });
    expect((REQUEST_TYPES as readonly string[]).includes("background_stop")).toBe(true);
    expect((CLIENT_FRAME_TYPES as readonly string[]).includes("background_stop")).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(4);
  });
  test("an id that is not Claude Code's short id is refused, with the rid", () => {
    for (const id of ["3f9a1c2", "3f9a1c2e0", "3F9A1C2E", "--all", "", 7, undefined]) {
      const r = parse(frame({ id }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.rid).toBe(RID);
    }
  });
  test("the ack: stopped, not_found or failed", () => {
    expect([...BG_STOP_ANSWERS]).toEqual(["stopped", "not_found", "failed"]);
    expect(ackOk<"background_stop">(RID, { background: "stopped" })).toEqual({ t: "ack", rid: RID, ok: true, result: { background: "stopped" } });
  });
});

describe("on_screen with a background session's view", () => {
  test("the id is kept when it is one; absent is the chat's own report", () => {
    expect(parse({ t: "on_screen", chat: CHAT, on: true, background: ID })).toEqual({ ok: true, frame: { t: "on_screen", chat: CHAT, on: true, background: ID } });
    expect(parse({ t: "on_screen", chat: CHAT, on: false })).toEqual({ ok: true, frame: { t: "on_screen", chat: CHAT, on: false } });
    expect(parse({ t: "on_screen", chat: CHAT, on: true, background: "nope" }).ok).toBe(false);
  });
});

describe("the pane's type_attach", () => {
  test("it names the short id, never a command; the typed answer may be attach", () => {
    expect(parseShellControl(JSON.stringify({ t: "type_attach", id: ID, command: "rm -rf" }))).toEqual({ ok: true, frame: { t: "type_attach", id: ID } });
    expect(parseShellControl(JSON.stringify({ t: "type_attach", id: "3f9a1c2e;rm" })).ok).toBe(false);
    expect(parseShellControl(JSON.stringify({ t: "type_attach" })).ok).toBe(false);
    expect([...SHELL_TYPED_CASES]).toEqual(["plain", "fork", "none", "busy", "trust", "attach"]);
  });
});

describe("the launches on a tool result", () => {
  const result = (background: unknown) => ({ k: "tool_result" as const, id: "toolu_bg", text: "x".repeat(7000), isError: false, parent: null, report: null, background }) as ChatEvent;
  test("the text is cut, the launches never are", () => {
    const e = capEvent(result([{ id: ID, name: "investigate", idle: false }]));
    expect(e).toMatchObject({ text: "x".repeat(6000), background: [{ id: ID, name: "investigate", idle: false }] });
  });
  test("a bad entry goes; none left is no key; at most 16", () => {
    const e = capEvent(result([{ id: "bad", name: null, idle: false }, { id: ID, name: 7, idle: "yes" }, { id: "0a1b2c3d", name: "n".repeat(500), idle: true }]));
    expect((e as { background?: unknown }).background).toEqual([{ id: "0a1b2c3d", name: "n".repeat(BG_LIMITS.name), idle: true }]);
    expect("background" in capEvent(result([{ id: "bad" }]))).toBe(false);
    expect("background" in capEvent(result("nope"))).toBe(false);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: i.toString(16).padStart(8, "a"), name: null, idle: false }));
    expect(bgLaunchesOf(many)!.length).toBe(16);
    expect(bgLaunchesOf([])).toBeNull();
  });
  test("an event that fits comes back equal", () => {
    const fit = { k: "tool_result" as const, id: "t", text: "ok", isError: false, parent: null, report: null, background: [{ id: ID, name: null, idle: false }] };
    expect(capEvent(fit)).toEqual(fit);
  });
});

describe("the background event and its worker", () => {
  test("the states, the waits and the row's field", () => {
    expect([...BG_STATES]).toEqual(["starting", "working", "needs_input", "idle", "completed", "failed", "stopped"]);
    expect([...BG_WAITS]).toEqual(["permission prompt", "input needed", "sandbox request", "worker request", "dialog open", "goal proposal", "other"]);
    expect([...BG_ROW_STATES]).toEqual(["needs_input", "failed", "done"]);
  });
  test("a worker reads back as itself; null is gone", () => {
    const w = worker({ state: "needs_input", waitingFor: "permission prompt", idleLaunch: true, unseen: true });
    expect(bgWorkerOf(w)).toEqual(w);
    expect(capEvent({ k: "background", id: ID, worker: w })).toEqual({ k: "background", id: ID, worker: w });
    expect(capEvent({ k: "background", id: ID, worker: null })).toEqual({ k: "background", id: ID, worker: null });
  });
  test("a field out of its rule goes or reads as none; a worker with an unknown state is none", () => {
    expect(bgWorkerOf(worker({ waitingFor: "everything" as never }))).toEqual(worker());
    expect(bgWorkerOf(worker({ waitingFor: "input needed", state: "working" }))).toEqual(worker());
    expect(bgWorkerOf(worker({ folder: "relative/path" }))).toEqual(worker({ folder: null }));
    expect(bgWorkerOf(worker({ folder: `/${"a".repeat(BG_LIMITS.folderChars)}` }))).toEqual(worker({ folder: null }));
    expect(bgWorkerOf(worker({ name: "n".repeat(300) }))).toEqual(worker({ name: "n".repeat(BG_LIMITS.name) }));
    expect(bgWorkerOf(worker({ unseen: false as never, idleLaunch: 1 as never }))).toEqual(worker());
    expect(bgWorkerOf(worker({ startedAt: "soon" as never }))).toEqual(worker({ startedAt: null }));
    expect(bgWorkerOf(worker({ view: "yes" as never }))).toEqual(worker({ view: false }));
    expect(bgWorkerOf(worker({ state: "running" as never }))).toBeNull();
    expect(bgWorkerOf("working")).toBeNull();
  });
});

describe("the routes", () => {
  test("/c/<chat>/background/<id> is a view, and its Stop confirm an action that only opens; both name the short id", () => {
    const view = ROUTE_BY_NAME.background!;
    const stop = ROUTE_BY_NAME.backgroundStop!;
    expect(view).toMatchObject({ path: "/c/:chat/background/:id", kind: "view" });
    expect(stop).toMatchObject({ path: "/c/:chat/background/:id/stop", kind: "action" });
    for (const def of [view, stop]) {
      const r = parsePath(def.example);
      expect([r.name, r.params.chat, r.params.id, r.fallbackFrom]).toEqual([def.name, CHAT, ID, undefined]);
    }
    expect(PARAM_RULES.id!(ID)).toBe(true);
    expect(BG_ID.test(ID)).toBe(true);
    // A path or a session id in the link is not read; a bad id falls back to the chat.
    expect(parsePath(`/c/${CHAT}/background/${ID}?path=%2Fetc&session=${RID}`).query).toEqual({});
    expect(parsePath(`/c/${CHAT}/background/${RID}`)).toMatchObject({ name: "chat", fallbackFrom: `/c/${CHAT}/background/${RID}` });
    expect(parsePath(`/c/${CHAT}/background/3F9A1C2E/stop`)).toMatchObject({ name: "chat" });
    expect(href("backgroundStop", { chat: CHAT, id: ID })).toBe(`/c/${CHAT}/background/${ID}/stop`);
  });
  test("the shell route takes type=attach with the short id, and nothing else from the link", () => {
    expect([...SHELL_TYPES]).toEqual(["resume", "trust", "attach"]);
    expect(parsePath(`/c/${CHAT}/shell?type=attach&bg=${ID}&cmd=rm`)).toMatchObject({ name: "shell", query: { type: "attach", bg: ID } });
    expect(parsePath(`/c/${CHAT}/shell?type=attach&bg=nope`)).toMatchObject({ query: { type: "attach" }, dropped: true });
    expect(href("shell", { chat: CHAT }, { type: "attach", bg: ID })).toBe(`/c/${CHAT}/shell?type=attach&bg=${ID}`);
  });
});
