// R127: Trust this folder on the wire (shared/protocol.ts; DESIGN-R127 section 8; version 4, no raise): the
// `trust_folder` request and its ack, the `trust_refused` code with its reason, `trust` on a tool result (never cut),
// the `trust` event, the pane's `type_trust`, and the routes (the confirm names a row, never a path; the shell route's
// `type=trust` with `tool`).
import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  REQUEST_TYPES,
  SHELL_TYPED_CASES,
  TRUST_ANSWERS,
  TRUST_LIMITS,
  TRUST_REFUSALS,
  TRUST_STATES,
  ackError,
  ackFail,
  ackOk,
  ackReason,
  ackTrustReason,
  capEvent,
  parseClientFrame,
  parseShellControl,
  trustRefOf,
} from "../../shared/protocol";
import { ROUTE_BY_NAME, SHELL_TYPES, href, parsePath } from "../../shared/route";

const RID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const DIR = "/srv/you/projects/shop/tasks/remove-negative-qty";
const parse = (o: unknown) => parseClientFrame(JSON.stringify(o));
const frame = (over: Record<string, unknown> = {}) => ({ t: "trust_folder" as const, rid: RID, chat: CHAT, toolUse: "toolu_01AbCdEf", path: DIR, ...over });

describe("trust_folder", () => {
  test("parses to exactly its fields; a request with an ack, stored like every request but get", () => {
    expect(parse({ ...frame(), extra: 1 })).toEqual({ ok: true, frame: frame() });
    expect((REQUEST_TYPES as readonly string[]).includes("trust_folder")).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(4);
  });

  test("a bad tool use, chat or rid is refused; the rid comes back when it was good", () => {
    for (const bad of [{ toolUse: "toolu bad" }, { toolUse: "" }, { toolUse: undefined }, { chat: "nope" }, { path: 7 }, { path: undefined }]) {
      const r = parse(frame(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.rid).toBe(RID);
    }
  });

  test("the path's own rules are the server's: any string up to the outer cap parses (a long one gets its own answer)", () => {
    for (const p of ["relative/path", "", "/a\tb", `/${"a".repeat(TRUST_LIMITS.pathBytes + 10)}`]) expect(parse(frame({ path: p })).ok).toBe(true);
    expect(parse(frame({ path: `/${"a".repeat(TRUST_LIMITS.pathChars)}` })).ok).toBe(false);
  });

  test("the ack: one of the five answers", () => {
    expect([...TRUST_ANSWERS]).toEqual(["trusted", "already", "not_recorded", "failed", "gone"]);
    expect(ackOk<"trust_folder">(RID, { trust: "trusted" })).toEqual({ t: "ack", rid: RID, ok: true, result: { trust: "trusted" } });
    expect([...TRUST_STATES]).toEqual(["trusting", ...TRUST_ANSWERS]);
  });

  test("trust_refused carries its reason; the reader takes only a known one, and only on that code", () => {
    expect([...TRUST_REFUSALS]).toEqual(["link", "not_folder", "home", "holds_home", "too_long"]);
    for (const reason of TRUST_REFUSALS) {
      const a = ackFail(RID, "trust_refused", reason);
      expect(a).toEqual({ t: "ack", rid: RID, ok: false, error: { code: "trust_refused", message: "kitespan did not trust that folder.", reason } });
      expect(ackTrustReason(a.ok ? null : a.error)).toBe(reason);
      expect(ackReason(a.ok ? null : a.error)).toBeNull();
    }
    // A reason on another code, or an unknown one, never goes out.
    expect(ackError("stale", "link")).toEqual({ code: "stale", message: "That request is no longer open." });
    expect(ackError("worktree_failed", "home")).toEqual({ code: "worktree_failed", message: "kitespan could not make a worktree for this chat." });
    expect(ackError("trust_refused", "nested")).toEqual({ code: "trust_refused", message: "kitespan did not trust that folder." });
    expect(ackTrustReason({ code: "trust_refused", reason: "everything" })).toBeNull();
    expect(ackTrustReason({ code: "busy", reason: "link" })).toBeNull();
    // The worktree reasons still go out as before.
    expect(ackError("worktree_failed", "nested")).toMatchObject({ reason: "nested" });
  });
});

describe("trust on a tool result, and the trust event", () => {
  const result = (trust: unknown) => ({ k: "tool_result" as const, id: "toolu_bg", text: "x".repeat(7000), isError: true, parent: null, report: null, trust: trust as { path: string; root: string | null } });

  test("the text is cut, the folder never is", () => {
    const e = capEvent(result({ path: DIR, root: "/srv/you/projects/shop" }));
    expect(e).toMatchObject({ text: "x".repeat(6000), trust: { path: DIR, root: "/srv/you/projects/shop" } });
  });

  test("a folder past the outer cap, or not absolute, is no refusal (the key goes); a bad root reads as none", () => {
    expect("trust" in capEvent(result({ path: `/${"a".repeat(TRUST_LIMITS.pathChars)}`, root: null }))).toBe(false);
    expect("trust" in capEvent(result({ path: "relative", root: null }))).toBe(false);
    expect("trust" in capEvent(result("nope"))).toBe(false);
    expect(trustRefOf({ path: DIR })).toEqual({ path: DIR, root: null });
    expect(trustRefOf({ path: DIR, root: "relative" })).toBeNull();
  });

  test("an event that fits comes back equal, with or without trust", () => {
    const fit = { k: "tool_result" as const, id: "t", text: "ok", isError: false, parent: null, report: null };
    expect(capEvent(fit)).toEqual(fit);
    expect(capEvent({ ...fit, trust: { path: DIR, root: null } })).toEqual({ ...fit, trust: { path: DIR, root: null } });
    expect(capEvent({ k: "trust", path: DIR, state: "trusting" })).toEqual({ k: "trust", path: DIR, state: "trusting" });
  });
});

describe("the pane's type_trust", () => {
  test("it names a tool use, never a folder; the typed answer may be trust", () => {
    expect(parseShellControl(JSON.stringify({ t: "type_trust", toolUse: "toolu_01AbCdEf", path: "/etc" }))).toEqual({ ok: true, frame: { t: "type_trust", toolUse: "toolu_01AbCdEf" } });
    expect(parseShellControl(JSON.stringify({ t: "type_trust", toolUse: "a b" })).ok).toBe(false);
    expect(parseShellControl(JSON.stringify({ t: "type_trust" })).ok).toBe(false);
    expect([...SHELL_TYPED_CASES]).toEqual(["plain", "fork", "none", "busy", "trust", "attach"]);
  });
});

describe("the routes", () => {
  test("/c/<chat>/trust/<toolUse> is an action route that only opens the confirm, and names a row, never a path", () => {
    const def = ROUTE_BY_NAME.trust!;
    expect(def).toMatchObject({ path: "/c/:chat/trust/:toolUse", kind: "action" });
    expect(Object.keys(def.query)).toEqual(["view"]);
    const r = parsePath(def.example);
    expect([r.name, r.params.chat, r.params.toolUse, r.fallbackFrom]).toEqual(["trust", CHAT, "toolu_01AbCdEf", undefined]);
    // A path in the link is not even read.
    expect(parsePath(`/c/${CHAT}/trust/toolu_01AbCdEf?path=%2Fetc`).query).toEqual({});
    // A bad tool use falls back to the chat.
    expect(parsePath(`/c/${CHAT}/trust/a%20b`)).toMatchObject({ name: "chat", fallbackFrom: `/c/${CHAT}/trust/a%20b` });
  });

  test("the shell route takes type=trust with the tool row's id, and nothing else from the link", () => {
    expect([...SHELL_TYPES]).toEqual(["resume", "trust", "attach"]);
    const r = parsePath(`/c/${CHAT}/shell?type=trust&tool=toolu_01AbCdEf&cmd=rm`);
    expect(r).toMatchObject({ name: "shell", query: { type: "trust", tool: "toolu_01AbCdEf" } });
    expect(parsePath(`/c/${CHAT}/shell?type=trust&tool=a%20b`)).toMatchObject({ query: { type: "trust" }, dropped: true });
    expect(href("shell", { chat: CHAT }, { type: "trust", tool: "toolu_01AbCdEf" })).toBe(`/c/${CHAT}/shell?type=trust&tool=toolu_01AbCdEf`);
  });
});
