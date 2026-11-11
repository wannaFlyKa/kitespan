// The wire protocol's validators and helpers (DESIGN.md 4.3, 4.2; D48, D49, D50, D52; 9.3 the mention chips).
import { describe, expect, test } from "bun:test";
import { CHAT_ID, EPOCH, ID_ALPHABET, PROJECT_ID, UPLOAD_ID, newChatId, newEpoch, newId, newProjectId, newUploadId } from "../../shared/ids";
import {
  CLIENT_FRAME_TYPES,
  ERROR_CODES,
  ERROR_MESSAGES,
  HOLD_KINDS,
  LIMITS,
  NOTICE_ACTIONS,
  PROTOCOL_VERSION,
  REQUEST_TYPES,
  SHELL_LIMITS,
  UNSEEN_KINDS,
  UPDATE_KINDS,
  WIRE,
  ackFail,
  ackIsStored,
  ackOk,
  applyChatsFrame,
  capAnswer,
  capEvent,
  capInput,
  capText,
  draftAfterSend,
  emptyDraft,
  isRequestFrame,
  isSafeRelativePath,
  mentionsOf,
  messageRef,
  messageRefForms,
  nextDraft,
  parseCardAnswer,
  parseClientFrame,
  parseShellControl,
  refAt,
  refsIn,
  shellQuote,
  splitBlock,
  toolCutOf,
  toolOutputPath,
  uploadRef,
  userMentions,
  withUploadRefs,
  type ChatEvent,
  type ChatRow,
  type ClientFrame,
  type DraftState,
  type ErrorCode,
  type ServerFrame,
  type SessionOpen,
} from "../../shared/protocol";

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const PROJECT = "k3m7q2x4ab";
const RID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const RID2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const UP1 = "abcdefghijklmnop";
const UP2 = "qrstuvwxyz234567";
const AT = "2026-10-31T12:00:00.000Z";

const ok = (raw: unknown): ClientFrame => {
  const r = parseClientFrame(typeof raw === "string" ? raw : JSON.stringify(raw));
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.frame;
};
const bad = (raw: unknown) => {
  const r = parseClientFrame(typeof raw === "string" ? raw : JSON.stringify(raw));
  expect(r.ok).toBe(false);
  return r as Extract<typeof r, { ok: false }>;
};

/** One valid frame of each client type, as a page would send it, with the frame that the parser must return. */
const SAMPLES: Record<string, { sent: Record<string, unknown>; parsed?: Record<string, unknown> }> = {
  hello: { sent: { t: "hello", v: 1, tab: "tab_1" } },
  ping: { sent: { t: "ping", n: 3 } },
  attach: { sent: { t: "attach", chat: CHAT, since: 12, epoch: "mh0x1abc-abcdefghijkl" } },
  detach: { sent: { t: "detach", chat: CHAT } },
  new_chat: {
    sent: { t: "new_chat", rid: RID, project: PROJECT, uuid: RID2, text: "Plan the upload feature", picks: { model: "claude-haiku-5-5", effort: "high" }, uploads: [UP1] },
    parsed: { t: "new_chat", rid: RID, project: PROJECT, uuid: RID2, text: "Plan the upload feature", picks: { model: "claude-haiku-5-5", effort: "high", mode: null }, uploads: [UP1] },
  },
  send: { sent: { t: "send", rid: RID, chat: CHAT, uuid: RID, text: "hi", draftRev: 4, uploads: [UP1, UP2] } },
  bash: { sent: { t: "bash", rid: RID, chat: CHAT, input: "git status", draftRev: null, uploads: [] } },
  answer: { sent: { t: "answer", rid: RID, chat: CHAT, card: "toolu_01AbC", answer: { kind: "permission", allow: true, scope: "once" } } },
  interrupt: { sent: { t: "interrupt", rid: RID, chat: CHAT, turn: 7 } },
  stop_task: { sent: { t: "stop_task", rid: RID, chat: CHAT, task: "wqxba767d" } },
  background: { sent: { t: "background", rid: RID, chat: CHAT, toolUse: "toolu_01AbC" } },
  take_back: { sent: { t: "take_back", rid: RID, chat: CHAT, uuid: RID2 } },
  set_model: { sent: { t: "set_model", rid: RID, chat: CHAT, value: "claude-haiku-5-5" } },
  set_effort: { sent: { t: "set_effort", rid: RID, chat: CHAT, value: null } },
  set_mode: { sent: { t: "set_mode", rid: RID, chat: CHAT, value: "acceptEdits" } },
  reconnect_mcp: { sent: { t: "reconnect_mcp", rid: RID, chat: CHAT, server: "docs-search" } },
  set_connector: { sent: { t: "set_connector", rid: RID, chat: CHAT, server: "docs-search", alwaysAsk: true } },
  continue_session: { sent: { t: "continue_session", rid: RID, project: PROJECT, session: RID2 } },
  rename: { sent: { t: "rename", rid: RID, chat: CHAT, title: "  Flaky upload test  " }, parsed: { t: "rename", rid: RID, chat: CHAT, title: "Flaky upload test" } },
  archive: { sent: { t: "archive", rid: RID, chat: CHAT, on: true, stop: true } },
  delete: { sent: { t: "delete", rid: RID, chat: CHAT } },
  draft: { sent: { t: "draft", chat: CHAT, text: "keep the test plan", mode: "slash", command: "compact", link: false, uploads: [UP1] } },
  get: { sent: { t: "get", rid: RID, chat: CHAT, what: "history", before: "c:42" } },
  send_queued: { sent: { t: "send_queued", rid: RID, chat: CHAT } },
  end_here: { sent: { t: "end_here", rid: RID, chat: CHAT } },
  worktree: { sent: { t: "worktree", rid: RID, chat: CHAT, act: "again" } },
  send_now: { sent: { t: "send_now", rid: RID, chat: CHAT, uuid: RID2 } },
  on_screen: { sent: { t: "on_screen", chat: CHAT, on: true } },
  side_question: { sent: { t: "side_question", rid: RID, chat: CHAT, id: RID2, text: "  Which file holds the cap?\n" }, parsed: { t: "side_question", rid: RID, chat: CHAT, id: RID2, text: "Which file holds the cap?" } },
  side_stop: { sent: { t: "side_stop", rid: RID, chat: CHAT, id: RID2 } },
  side_clear: { sent: { t: "side_clear", rid: RID, chat: CHAT } },
  trust_folder: { sent: { t: "trust_folder", rid: RID, chat: CHAT, toolUse: "toolu_01AbCdEf", path: "/srv/you/projects/shop/tasks/remove-negative-qty" } },
  background_stop: { sent: { t: "background_stop", rid: RID, chat: CHAT, id: "3f9a1c2e" } },
};

describe("ids", () => {
  test("new ids have their length and alphabet, and match their patterns", () => {
    expect(newChatId()).toMatch(CHAT_ID);
    expect(newProjectId()).toMatch(PROJECT_ID);
    expect(newUploadId()).toMatch(UPLOAD_ID);
    const id = newId(400);
    expect([...id].every((c) => ID_ALPHABET.includes(c))).toBe(true);
    expect(new Set(id).size).toBeGreaterThan(20);
    expect(newChatId()).not.toBe(newChatId());
  });
  test("an epoch holds the boot time and a random part, and two boots never share one", () => {
    const a = newEpoch(1_793_000_000_000);
    expect(a).toMatch(EPOCH);
    expect(a.split("-")[0]).toBe((1_793_000_000_000).toString(36));
    expect(newEpoch(5)).not.toBe(newEpoch(5));
  });
});

describe("the frame catalogue", () => {
  test("every client frame type has a sample, and the samples cover the catalogue", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...CLIENT_FRAME_TYPES].sort());
  });
  test("request types are the client types less hello, ping, attach, detach, draft and on_screen", () => {
    const noRid = ["hello", "ping", "attach", "detach", "draft", "on_screen"];
    const requests: string[] = [...REQUEST_TYPES].sort();
    expect(requests).toEqual(CLIENT_FRAME_TYPES.filter((t) => !noRid.includes(t)).sort());
    for (const t of CLIENT_FRAME_TYPES) expect(isRequestFrame(ok(SAMPLES[t]!.sent))).toBe(!noRid.includes(t));
  });
  test("Send now (row 111) names its chat and the queued message it was pressed on, by uuid", () => {
    expect(ok({ t: "send_now", rid: RID, chat: CHAT, uuid: RID2, extra: 1 })).toEqual({ t: "send_now", rid: RID, chat: CHAT, uuid: RID2 });
    expect(bad({ t: "send_now", rid: RID, chat: CHAT }).rid).toBe(RID);
    expect(bad({ t: "send_now", rid: RID, chat: CHAT, uuid: "m_run_q1" }).rid).toBe(RID);
    expect(bad({ t: "send_now", rid: RID, chat: "nope", uuid: RID2 }).rid).toBe(RID);
    expect(ackOk<"send_now">(RID, { acted: "background" })).toEqual({ t: "ack", rid: RID, ok: true, result: { acted: "background" } });
    expect(ackIsStored("send_now")).toBe(true);
  });
  test("only a get is left out of the ack store", () => {
    for (const t of REQUEST_TYPES) expect(ackIsStored(t)).toBe(t !== "get");
  });
  test("every error code has a fixed message, and acks have their shape", () => {
    for (const c of ERROR_CODES) expect(ERROR_MESSAGES[c].length).toBeGreaterThan(5);
    expect(ackFail(RID, "stale")).toEqual({ t: "ack", rid: RID, ok: false, error: { code: "stale", message: ERROR_MESSAGES.stale } });
    expect(ackOk<"take_back">(RID, { cancelled: false })).toEqual({ t: "ack", rid: RID, ok: true, result: { cancelled: false } });
  });
});

describe("parseClientFrame: valid frames", () => {
  for (const [t, s] of Object.entries(SAMPLES))
    test(`${t} parses to a clean copy`, () => {
      expect(ok(s.sent)).toEqual((s.parsed ?? s.sent) as ClientFrame);
    });
  test("unknown fields are dropped", () => {
    expect(ok({ t: "ping", n: 1, extra: "x" })).toEqual({ t: "ping", n: 1 });
    expect(ok({ ...SAMPLES.delete!.sent, path: "/etc" })).toEqual(SAMPLES.delete!.sent as ClientFrame);
  });
  test("an already parsed value is read too", () => {
    expect(parseClientFrame({ t: "ping", n: 0 })).toEqual({ ok: true, frame: { t: "ping", n: 0 } });
  });
  test("absent optional fields get their defaults", () => {
    expect(ok({ t: "send", rid: RID, chat: CHAT, uuid: RID, text: "hi" })).toEqual({ t: "send", rid: RID, chat: CHAT, uuid: RID, text: "hi", draftRev: null, uploads: [] });
    expect(ok({ t: "attach", chat: CHAT, since: 0 })).toEqual({ t: "attach", chat: CHAT, since: 0, epoch: null });
    expect(ok({ t: "archive", rid: RID, chat: CHAT, on: false })).toEqual({ t: "archive", rid: RID, chat: CHAT, on: false, stop: false });
    expect(ok({ t: "new_chat", rid: RID, project: PROJECT, uuid: RID2, text: "go" })).toMatchObject({ picks: { model: null, effort: null, mode: null }, uploads: [] });
    expect(ok({ t: "get", rid: RID, chat: CHAT, what: "history" })).toEqual({ t: "get", rid: RID, chat: CHAT, what: "history", before: null });
  });
  test("a get other than history carries no cursor", () => {
    expect(ok({ t: "get", rid: RID, chat: CHAT, what: "context", before: "x" })).toEqual({ t: "get", rid: RID, chat: CHAT, what: "context" });
  });
  test("set_connector takes exactly one switch", () => {
    expect(ok({ t: "set_connector", rid: RID, chat: CHAT, server: "a", enabled: false })).toEqual({ t: "set_connector", rid: RID, chat: CHAT, server: "a", enabled: false });
    bad({ t: "set_connector", rid: RID, chat: CHAT, server: "a" });
    bad({ t: "set_connector", rid: RID, chat: CHAT, server: "a", enabled: true, alwaysAsk: true });
  });
  test("repeated upload ids are dropped, the order kept", () => {
    expect((ok({ t: "send", rid: RID, chat: CHAT, uuid: RID, text: "x", uploads: [UP2, UP1, UP2] }) as { uploads: string[] }).uploads).toEqual([UP2, UP1]);
  });
  test("a send may hold only upload chips (D50), but never nothing", () => {
    expect(ok({ t: "send", rid: RID, chat: CHAT, uuid: RID, text: "", uploads: [UP1] })).toMatchObject({ text: "", uploads: [UP1] });
    bad({ t: "send", rid: RID, chat: CHAT, uuid: RID, text: "  \n ", uploads: [] });
    bad({ t: "new_chat", rid: RID, project: PROJECT, uuid: RID2, text: " " });
  });
  test("user text is not cut on the way in: Claude Code gets what was typed", () => {
    const long = "a".repeat(LIMITS.userText + 5);
    expect((ok({ t: "send", rid: RID, chat: CHAT, uuid: RID, text: long }) as { text: string }).text.length).toBe(long.length);
  });
});

describe("parseClientFrame: refusals", () => {
  test("not JSON, not an object, binary, too large, an unknown type", () => {
    expect(bad("{nope").reason).toBe("frame: not JSON");
    expect(bad("[1,2]").reason).toBe("frame: not an object");
    expect(bad("null").reason).toBe("frame: not an object");
    expect(parseClientFrame(new Uint8Array([123, 125]))).toMatchObject({ ok: false, reason: "frame: binary" });
    expect(parseClientFrame(new ArrayBuffer(2))).toMatchObject({ ok: false, reason: "frame: binary" });
    expect(parseClientFrame("x".repeat(WIRE.maxPayloadBytes + 1))).toMatchObject({ ok: false, reason: "frame: too large" });
    expect(bad({ t: "user", text: "hi" }).reason).toBe("t: not a client frame");
    expect(bad({ n: 1 }).reason).toBe("t: not a client frame");
  });
  test("a refusal names the frame's rid when it had a valid one, so the server can ack it", () => {
    expect(bad({ t: "send", rid: RID, chat: "nope", uuid: RID, text: "x" }).rid).toBe(RID);
    expect(bad({ t: "send", rid: "not-a-uuid", chat: CHAT, uuid: RID, text: "x" }).rid).toBeNull();
  });
  test("a reason names the field, never its value", () => {
    const r = bad({ t: "send", rid: RID, chat: "secret-value", uuid: RID, text: "x" });
    expect(r.reason).toBe("chat: bad id");
    expect(r.reason).not.toContain("secret");
  });
  test("ids must match their patterns", () => {
    bad({ t: "detach", chat: "c_demo01" });
    bad({ t: "detach", chat: CHAT.toUpperCase() });
    bad({ t: "detach", chat: `${CHAT}a` });
    bad({ t: "continue_session", rid: RID, project: "p_kitespan", session: RID2 });
    bad({ t: "continue_session", rid: RID, project: PROJECT, session: RID2.toUpperCase() });
    bad({ t: "stop_task", rid: RID, chat: CHAT, task: "../x" });
    bad({ t: "answer", rid: RID, chat: CHAT, card: "a b", answer: { kind: "plan", approve: true, mode: "auto" } });
    bad({ t: "hello", v: 1, tab: "x".repeat(65) });
    bad({ t: "attach", chat: CHAT, since: 0, epoch: "today" });
    bad({ t: "send", rid: RID, chat: CHAT, uuid: RID, text: "x", uploads: ["u-abc123"] });
  });
  test("a send's uuid equals its rid", () => {
    expect(bad({ t: "send", rid: RID, chat: CHAT, uuid: RID2, text: "x" }).reason).toBe("uuid: differs from rid");
  });
  test("numbers must be whole and in range", () => {
    bad({ t: "ping", n: -1 });
    bad({ t: "ping", n: 1.5 });
    bad({ t: "ping", n: "1" });
    bad({ t: "attach", chat: CHAT, since: -1 });
    bad({ t: "interrupt", rid: RID, chat: CHAT, turn: Number.NaN });
    bad({ t: "send", rid: RID, chat: CHAT, uuid: RID, text: "x", draftRev: -2 });
    bad({ t: "hello", v: 0, tab: "t" });
  });
  test("a ! command holds 1 to 10,000 characters (D20)", () => {
    expect(ok({ t: "bash", rid: RID, chat: CHAT, input: "x".repeat(LIMITS.bashInput) })).toMatchObject({ t: "bash" });
    bad({ t: "bash", rid: RID, chat: CHAT, input: "x".repeat(LIMITS.bashInput + 1) });
    bad({ t: "bash", rid: RID, chat: CHAT, input: "   " });
  });
  test("a title is trimmed and holds 1 to 120 characters with no control character", () => {
    expect(ok({ t: "rename", rid: RID, chat: CHAT, title: "t".repeat(120) })).toMatchObject({ title: "t".repeat(120) });
    bad({ t: "rename", rid: RID, chat: CHAT, title: "t".repeat(121) });
    bad({ t: "rename", rid: RID, chat: CHAT, title: "   " });
    bad({ t: "rename", rid: RID, chat: CHAT, title: "two\nlines" });
    bad({ t: "rename", rid: RID, chat: CHAT, title: "Release notes \u202etxt.exe" });
  });
  test("picker values: a model row value or null, an effort level, one of Desktop's five modes", () => {
    bad({ t: "set_model", rid: RID, chat: CHAT, value: "" });
    bad({ t: "set_model", rid: RID, chat: CHAT, value: "x".repeat(LIMITS.name + 1) });
    bad({ t: "set_effort", rid: RID, chat: CHAT, value: "extreme" });
    bad({ t: "set_mode", rid: RID, chat: CHAT, value: "dontAsk" });
    bad({ t: "set_mode", rid: RID, chat: CHAT });
    bad({ t: "new_chat", rid: RID, project: PROJECT, uuid: RID2, text: "go", picks: { mode: "yolo" } });
  });
  test("archive: stop only with on (Stop and archive)", () => {
    expect(bad({ t: "archive", rid: RID, chat: CHAT, on: false, stop: true }).reason).toBe("stop: only with on");
    bad({ t: "archive", rid: RID, chat: CHAT, on: "yes" });
  });
  test("draft: the chip in slash mode only, at most 100 uploads, a boolean link mark", () => {
    const base = { t: "draft", chat: CHAT, text: "x", mode: "chat", command: null, link: false, uploads: [] };
    expect(ok(base)).toEqual(base as ClientFrame);
    expect(bad({ ...base, command: "compact" }).reason).toBe("command: only in slash mode");
    bad({ ...base, mode: "shell" });
    bad({ ...base, link: 1 });
    bad({ ...base, mode: "slash", command: "c".repeat(LIMITS.draftCommand + 1) });
    const many = Array.from({ length: LIMITS.draftUploads + 1 }, () => newUploadId());
    bad({ ...base, uploads: many });
    expect(ok({ ...base, uploads: many.slice(0, LIMITS.draftUploads) })).toMatchObject({ t: "draft" });
  });
  test("the history cursor is a short label", () => {
    bad({ t: "get", rid: RID, chat: CHAT, what: "history", before: "x".repeat(LIMITS.cursor + 1) });
    bad({ t: "get", rid: RID, chat: CHAT, what: "transcript" });
  });
  test("random input never throws", () => {
    const pieces: unknown[] = [null, 0, -1, 1e300, "", "x", true, [], {}, [1], { t: "send" }, RID, CHAT, "\u0000", "\ud800"];
    const types = [...CLIENT_FRAME_TYPES, "nope"];
    const keys = ["t", "rid", "chat", "uuid", "text", "input", "answer", "uploads", "draftRev", "mode", "command", "value", "on", "stop", "what", "before", "picks", "since", "epoch", "v", "tab", "n"];
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    for (let i = 0; i < 5000; i++) {
      const o: Record<string, unknown> = { t: types[rnd(types.length)] };
      for (let j = rnd(6); j > 0; j--) o[keys[rnd(keys.length)]!] = pieces[rnd(pieces.length)];
      expect(() => parseClientFrame(JSON.stringify(o))).not.toThrow();
      expect(() => parseClientFrame(o)).not.toThrow();
    }
  });
});

describe("card answers", () => {
  test("each answer kind of 4.2 parses", () => {
    const answers = [
      { kind: "permission", allow: true, scope: "session" },
      { kind: "permission", allow: false, message: "" },
      { kind: "question", answers: { "Which tests?": "Unit tests, Click-through" } },
      { kind: "plan", approve: true, mode: "acceptEdits" },
      { kind: "plan", approve: false, feedback: "Split step 2" },
      { kind: "elicitation", action: "accept", content: { name: "x", count: 2, ok: true, tags: ["a"] } },
      { kind: "elicitation", action: "accept" },
      { kind: "elicitation", action: "decline" },
      { kind: "dialog", behavior: "completed", result: { choice: "retry" } },
      { kind: "dialog", behavior: "cancelled" },
    ];
    for (const a of answers) expect(parseCardAnswer(a)).toEqual(a as never);
  });
  test("malformed answers are refused", () => {
    const refused = [
      null,
      { kind: "permission" },
      { kind: "permission", allow: true },
      { kind: "permission", allow: true, scope: "always" },
      { kind: "permission", allow: false },
      { kind: "question", answers: {} },
      { kind: "question", answers: { q: 1 } },
      { kind: "plan", approve: true, mode: "plan" },
      { kind: "elicitation", action: "accept", content: { a: { nested: 1 } } },
      { kind: "elicitation", action: "maybe" },
      { kind: "dialog", behavior: "completed" },
      { kind: "card" },
    ];
    for (const a of refused) expect(() => parseCardAnswer(a)).toThrow();
    expect(bad({ t: "answer", rid: RID, chat: CHAT, card: "x1", answer: { kind: "permission", allow: "yes" } }).rid).toBe(RID);
  });
  test("a question keyed __proto__ stays an own key", () => {
    const a = parseCardAnswer(JSON.parse('{"kind":"question","answers":{"__proto__":"x","q":"y"}}')) as { answers: Record<string, string> };
    expect(Object.keys(a.answers)).toEqual(["__proto__", "q"]);
    expect(Object.getPrototypeOf(a.answers)).toBe(Object.prototype);
  });
  test("free text in an answer is cut at 2,000 characters (A10)", () => {
    const long = "w".repeat(LIMITS.answerText + 50);
    expect(capAnswer({ kind: "permission", allow: false, message: long })).toEqual({ kind: "permission", allow: false, message: long.slice(0, LIMITS.answerText) });
    expect(capAnswer({ kind: "plan", approve: false, feedback: long })).toMatchObject({ feedback: long.slice(0, LIMITS.answerText) });
    expect(capAnswer({ kind: "question", answers: { q: long } })).toEqual({ kind: "question", answers: { q: long.slice(0, LIMITS.answerText) } });
    const allow = { kind: "permission", allow: true, scope: "once" } as const;
    expect(capAnswer(allow)).toBe(allow);
  });
});

describe("the Terminal pane's control frames (D52)", () => {
  test("open, resize and type_resume parse", () => {
    expect(parseShellControl(JSON.stringify({ t: "open", chat: CHAT, cols: 80, rows: 24 }))).toEqual({ ok: true, frame: { t: "open", chat: CHAT, cols: 80, rows: 24 } });
    expect(parseShellControl(JSON.stringify({ t: "resize", cols: 120, rows: 40, x: 1 }))).toEqual({ ok: true, frame: { t: "resize", cols: 120, rows: 40 } });
    expect(parseShellControl(JSON.stringify({ t: "type_resume" }))).toEqual({ ok: true, frame: { t: "type_resume" } });
  });
  test("bad sizes, ids and types are refused; keys never come as text", () => {
    for (const f of [
      { t: "open", chat: "nope", cols: 80, rows: 24 },
      { t: "resize", cols: 0, rows: 24 },
      { t: "resize", cols: SHELL_LIMITS.maxCols + 1, rows: 24 },
      { t: "resize", cols: 80, rows: SHELL_LIMITS.maxRows + 1 },
      { t: "type", text: "rm -rf /" },
      { t: "keys", data: "ls\r" },
    ])
      expect(parseShellControl(JSON.stringify(f)).ok).toBe(false);
    expect(parseShellControl(new Uint8Array([3])).ok).toBe(false);
    expect(parseShellControl("{").ok).toBe(false);
  });
});

describe("text caps", () => {
  test("capText never cuts inside a surrogate pair", () => {
    expect(capText("abc", 5)).toBe("abc");
    expect(capText("abcdef", 3)).toBe("abc");
    const s = `ab\u{1f600}cd`; // a, b, then a pair at 2 and 3
    expect(capText(s, 3)).toBe("ab");
    expect(capText(s, 4)).toBe("ab\u{1f600}");
    expect(capText("", 0)).toBe("");
  });
  test("capInput holds each string to 8,000 and the whole input to its budget", () => {
    const big = { content: "x".repeat(50_000), edits: Array.from({ length: 50 }, () => ({ old: "o".repeat(9000), new: "n".repeat(9000) })) };
    const out = capInput(big) as { content: string; edits: { old: string; new: string }[] };
    expect(out.content.length).toBe(LIMITS.inputString);
    expect(JSON.stringify(out).length).toBeLessThan(LIMITS.inputBudget + 10_000);
    expect(capInput({ a: [1, true, null, "s"] })).toEqual({ a: [1, true, null, "s"] });
  });
  test("capEvent applies 4.3's caps and keeps an event that fits as it is", () => {
    const ev = (e: ChatEvent) => capEvent(e);
    expect(ev({ k: "tool_result", id: "t", text: "r".repeat(7000), isError: false, parent: null, report: "p".repeat(4000) })).toMatchObject({ text: "r".repeat(LIMITS.toolResult), report: "p".repeat(LIMITS.report) });
    expect((ev({ k: "user", uuid: RID, text: "u".repeat(25_000), queued: false }) as { text: string }).text.length).toBe(LIMITS.userText);
    expect((ev({ k: "local_output", stream: "stdout", text: "l".repeat(9000) }) as { text: string }).text.length).toBe(LIMITS.localOutput);
    const bash = ev({ k: "bash", uuid: RID, input: "ls", state: "done", stdout: "o".repeat(40_000), stderr: "", code: 0, ms: 5, timedOut: false, capped: true }) as { stdout: string };
    expect(bash.stdout.length).toBe(LIMITS.bashOutput);
    expect(ev({ k: "exit", code: 1, signal: null, stderr: ["1", "2", "3", "4", "5", "x".repeat(900)] })).toEqual({ k: "exit", code: 1, signal: null, stderr: ["3", "4", "5", "x".repeat(LIMITS.stderrLine)] });
    const small: ChatEvent = { k: "tool_call", id: "t", name: "Read", input: { file_path: "src/a.ts" }, parent: null };
    expect(ev(small)).toEqual(small);
    expect(ev(ev(small))).toEqual(small);
  });
  test("capEvent cuts a card record's note and answers, and the session's loaded lists and names", () => {
    const close = capEvent({ k: "card_close", id: "t", why: "answered", answer: "denied", note: "n".repeat(3_000), answers: { q: "a".repeat(3_000) } }) as Extract<ChatEvent, { k: "card_close" }>;
    expect(close.note!.length).toBe(LIMITS.answerText);
    expect(close.answers!.q!.length).toBe(LIMITS.answerText);
    const plain: ChatEvent = { k: "card_close", id: "t", why: "cancelled", answer: "cancelled" };
    expect(capEvent(plain)).toEqual(plain);
    const session = capEvent({
      k: "session",
      sessionId: RID,
      model: null,
      mode: null,
      version: null,
      bypass: false,
      fastMode: { state: "off", reason: "r".repeat(500) },
      skills: Array.from({ length: LIMITS.loaded + 10 }, () => "s".repeat(500)),
      plugins: [{ name: "p".repeat(500), version: "v".repeat(100) }],
      outputStyle: "o".repeat(500),
    }) as Extract<ChatEvent, { k: "session" }>;
    expect(session.skills!.length).toBe(LIMITS.loaded);
    expect(session.skills![0]!.length).toBe(LIMITS.name);
    expect(session.plugins).toEqual([{ name: "p".repeat(LIMITS.name), version: "v".repeat(LIMITS.pluginVersion) }]);
    expect(session.outputStyle!.length).toBe(LIMITS.name);
    expect(session.fastMode).toEqual({ state: "off", reason: "r".repeat(LIMITS.name) });
    const older: ChatEvent = { k: "session", sessionId: RID, model: null, mode: null, version: null, bypass: false };
    expect(capEvent(older)).toEqual(older);
  });
});

describe("a long block goes out as a stream", () => {
  test("splitBlock keeps every character, in pieces that fit a frame, never cut inside a surrogate pair", () => {
    const short: ChatEvent = { k: "block", key: "m:0", kind: "text", text: "hi", parent: null };
    expect(splitBlock(short as Extract<ChatEvent, { k: "block" }>)).toEqual([short]);
    const text = `${"a".repeat(9)}\u{1f600}${"b".repeat(15)}`;
    const parts = splitBlock({ k: "block", key: "m:1", kind: "thinking", text, parent: "toolu_1" }, 10);
    expect(parts[0]).toEqual({ k: "block_start", key: "m:1", kind: "thinking", parent: "toolu_1" });
    expect(parts.at(-1)).toEqual({ k: "block_end", key: "m:1" });
    const deltas = parts.slice(1, -1) as { k: string; text: string }[];
    expect(deltas.every((d) => d.k === "block_delta" && d.text.length <= 10)).toBe(true);
    expect(deltas.map((d) => d.text).join("")).toBe(text);
    expect(deltas[0]!.text).toBe("a".repeat(9));
    const big = splitBlock({ k: "block", key: "m:2", kind: "text", text: "\u0001".repeat(100_000), parent: null });
    for (const p of big) expect(JSON.stringify({ t: "ev", chat: CHAT, seq: 1, e: p }).length).toBeLessThan(WIRE.pageBytes);
  });
});

describe("file references (D50, D45; the reference probe of 2026-11-01 on Claude Code 2.1.311)", () => {
  test("a message reference: @ and the path with no white space, @ and the quoted path with it, backticks with a double quote too", () => {
    // Plain: as before.
    expect(messageRef("/tmp/u-1/plan.md")).toBe("@/tmp/u-1/plan.md");
    // A space: Claude Code reads a bare @ path only up to the space, so the path goes in double quotes.
    expect(messageRef("/tmp/u-1/my notes file.txt")).toBe('@"/tmp/u-1/my notes file.txt"');
    expect(messageRef("/tmp/u-1/a\tb.md")).toBe('@"/tmp/u-1/a\tb.md"');
    expect(messageRef("/tmp/u-1/a b.md")).toBe('@"/tmp/u-1/a b.md"');
    // An apostrophe and a space: quoted (the probe attached it).
    expect(messageRef("/tmp/u-1/it's here.md")).toBe(`@"/tmp/u-1/it's here.md"`);
    expect(messageRef("/tmp/u-1/it's.md")).toBe("@/tmp/u-1/it's.md");
    // A double quote and no white space: bare (the probe attached it).
    expect(messageRef('/tmp/u-1/say"hi.md')).toBe('@/tmp/u-1/say"hi.md');
    // Both: no @ form (a double quote ends a quoted reference, a backslash does not escape it), so the path is text.
    expect(messageRef('/tmp/u-1/say "hi" now.md')).toBe('`/tmp/u-1/say "hi" now.md`');
    expect(messageRef('/tmp/u-1/say "hi" now.md')).not.toContain("@");
    // A backtick in such a path: a longer fence, and a space inside it where the path ends with a backtick.
    expect(messageRef('/tmp/u-1/a `b` "c d.md')).toBe('``/tmp/u-1/a `b` "c d.md``');
    expect(messageRef('/tmp/u-1/x "y z`')).toBe('`` /tmp/u-1/x "y z` ``');
    expect(messageRef('/tmp/u-1/x "y ``z.md')).toBe('```/tmp/u-1/x "y ``z.md```');
  });
  test("bare only where the path ends in an ASCII letter, a digit or an underscore: Claude Code drops any other last characters", () => {
    expect(messageRef("/tmp/u-1/notes_")).toBe("@/tmp/u-1/notes_");
    expect(messageRef("/tmp/u-1/v2")).toBe("@/tmp/u-1/v2");
    expect(messageRef("/tmp/u-1/file_(1)")).toBe('@"/tmp/u-1/file_(1)"');
    expect(messageRef("/tmp/u-1/notes.md~")).toBe('@"/tmp/u-1/notes.md~"');
    expect(messageRef("/tmp/u-1/a.c++")).toBe('@"/tmp/u-1/a.c++"');
    expect(messageRef("/tmp/u-1/report.")).toBe('@"/tmp/u-1/report."');
    expect(messageRef("/tmp/u-1/it's'")).toBe(`@"/tmp/u-1/it's'"`);
    expect(messageRef("/tmp/u-1/café")).toBe('@"/tmp/u-1/café"');
    expect(messageRef("/tmp/u-1/笔记")).toBe('@"/tmp/u-1/笔记"');
    // A double quote at the end: neither @ form keeps it, so the path is text.
    expect(messageRef('/tmp/u-1/say"hi"')).toBe('`/tmp/u-1/say"hi"`');
  });
  test("a path that Claude Code cuts at a # (one # part, read as a line range or a heading): the path as text", () => {
    expect(messageRef("/tmp/u-1/C#notes.md")).toBe("`/tmp/u-1/C#notes.md`");
    expect(messageRef("/tmp/u-1/issue #42.md")).toBe("`/tmp/u-1/issue #42.md`");
    expect(messageRef("/tmp/u-1/x#L5.md")).toBe("`/tmp/u-1/x#L5.md`");
    expect(messageRef("/tmp/u-1/x#L5-9#top")).toBe("`/tmp/u-1/x#L5-9#top`");
    expect(messageRef("/tmp/u-1/a#")).toBe("`/tmp/u-1/a#`");
    // A chat folder with one #: each of its files too.
    expect(messageRef("/src/C#-tools/a.ts")).toBe("`/src/C#-tools/a.ts`");
    // Two # parts or more: Claude Code keeps the path whole, so the @ forms hold.
    expect(messageRef("/tmp/u-1/a#b#c.md")).toBe("@/tmp/u-1/a#b#c.md");
    expect(messageRef("/src/C#-tools/a#b c.md")).toBe('@"/src/C#-tools/a#b c.md"');
  });
  test("a quoted path that ends with \" (agent)\" names an agent for Claude Code: the path as text", () => {
    expect(messageRef("/tmp/u-1/notes (agent)")).toBe("`/tmp/u-1/notes (agent)`");
    expect(messageRef("/tmp/u-1/notes (agent).md")).toBe('@"/tmp/u-1/notes (agent).md"');
  });
  test("an upload's reference: the message rule in a message; one quoted shell word in a ! command, whatever the path", () => {
    for (const p of ["/tmp/u-1/plan.md", "/tmp/u-1/my notes file.txt", "/tmp/u-1/it's here.md", '/tmp/u-1/say"hi.md', '/tmp/u-1/say "hi" now.md']) {
      expect(uploadRef(p, "message")).toBe(messageRef(p));
    }
    expect(uploadRef("/tmp/u-abc123/a.txt", "bash")).toBe("'/tmp/u-abc123/a.txt'");
    expect(uploadRef("/tmp/u-1/my notes file.txt", "bash")).toBe("'/tmp/u-1/my notes file.txt'");
    expect(uploadRef('/tmp/u-1/say "hi" it\'s.md', "bash")).toBe(`'/tmp/u-1/say "hi" it'\\''s.md'`);
    expect(shellQuote("$(touch x);y.txt")).toBe("'$(touch x);y.txt'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  test("the server adds the references at the end of the text, separated by spaces", () => {
    expect(withUploadRefs("Read these", ["/tmp/u-1/a.txt", "/tmp/u-2/b c.png"], "message")).toBe('Read these @/tmp/u-1/a.txt @"/tmp/u-2/b c.png"');
    expect(withUploadRefs("Read these", ['/tmp/u-1/say "hi" now.md', "/tmp/u-2/b.png"], "message")).toBe('Read these `/tmp/u-1/say "hi" now.md` @/tmp/u-2/b.png');
    expect(withUploadRefs("Read these\n", ["/tmp/u-1/a.txt"], "message")).toBe("Read these\n@/tmp/u-1/a.txt");
    expect(withUploadRefs("", ["/tmp/u-1/a.txt"], "message")).toBe("@/tmp/u-1/a.txt");
    expect(withUploadRefs("wc -l", ["/tmp/u-1/it's.txt"], "bash")).toBe("wc -l '/tmp/u-1/it'\\''s.txt'");
    expect(withUploadRefs("wc -l", ["/tmp/u-1/b c.txt"], "bash")).toBe("wc -l '/tmp/u-1/b c.txt'");
    expect(withUploadRefs("no chips", [], "message")).toBe("no chips");
  });
  test("the forms a message may hold for a known path: today's, and the bare one iteration 2 sent for a path with white space", () => {
    expect(messageRefForms("/tmp/u-1/plan.md")).toEqual(["@/tmp/u-1/plan.md"]);
    expect(messageRefForms('/tmp/u-1/say"hi.md')).toEqual(['@/tmp/u-1/say"hi.md']);
    expect(messageRefForms("/tmp/u-1/a b.md")).toEqual(['@"/tmp/u-1/a b.md"', "@/tmp/u-1/a b.md"]);
    expect(messageRefForms('/tmp/u-1/say "hi" now.md')).toEqual(['`/tmp/u-1/say "hi" now.md`', '@/tmp/u-1/say "hi" now.md']);
    // A path that iteration 2 sent bare and that is now quoted or text: the old bare form still reads.
    expect(messageRefForms("/tmp/u-1/file_(1)")).toEqual(['@"/tmp/u-1/file_(1)"', "@/tmp/u-1/file_(1)"]);
    expect(messageRefForms("/tmp/u-1/C#notes.md")).toEqual(["`/tmp/u-1/C#notes.md`", "@/tmp/u-1/C#notes.md"]);
  });
  test("refAt reads each form that messageRef writes, at the start or after white space, up to white space or the end", () => {
    for (const p of ["/tmp/u-1/plan.md", "/tmp/u-1/a b.md", "/tmp/u-1/it's here.md", '/tmp/u-1/say"hi.md', '/tmp/u-1/say "hi" now.md', '/tmp/u-1/x "y z`', "~/notes/a b.md", "/tmp/u-1/file_(1)", "/tmp/u-1/café", '/tmp/u-1/say"hi"', "/tmp/u-1/C#notes.md", "/tmp/u-1/issue #42.md", "/tmp/u-1/notes (agent)"]) {
      const ref = messageRef(p);
      expect(refAt(ref, 0)).toEqual({ path: p, end: ref.length });
      expect(refAt(`see ${ref} now`, 4)).toEqual({ path: p, end: 4 + ref.length });
      expect(refAt(`see\n${ref}`, 4)).toEqual({ path: p, end: 4 + ref.length });
    }
    // A bare reference runs to the next white space: an old one to a path with a space reads only up to it.
    expect(refAt("@/tmp/u-1/a b.md", 0)).toEqual({ path: "/tmp/u-1/a", end: 11 });
    expect(refsIn('Read @/tmp/a.md and @"/tmp/b c.md" then `/tmp/"d e.md`')).toEqual([
      { at: 5, end: 15, path: "/tmp/a.md" },
      { at: 20, end: 34, path: "/tmp/b c.md" },
      { at: 40, end: 54, path: '/tmp/"d e.md' },
    ]);
  });
  test("refAt reads nothing from text that only looks like a reference", () => {
    expect(refAt("mail@/tmp/a.md", 4)).toBeNull(); // inside a word
    expect(refAt("me@example.com", 2)).toBeNull();
    expect(refAt('x@"/tmp/a b.md"', 1)).toBeNull();
    expect(refAt('@"/tmp/a b.md"x', 0)).toBeNull(); // runs on into a word
    expect(refAt('@"/tmp/a b.md', 0)).toBeNull(); // no closing quote
    expect(refAt('@""', 0)).toBeNull();
    expect(refAt("@ x", 0)).toBeNull();
    expect(refAt("@", 0)).toBeNull();
    expect(refAt("plain", 0)).toBeNull();
    // Backticks hold a reference only when messageRef would write them: a path with white space and a double quote.
    expect(refAt("`/usr/bin/env`", 0)).toBeNull();
    expect(refAt("`/tmp/a b.md`", 0)).toBeNull();
    // refAt knows no paths: a quoted phrase in backticks reads as one, and its callers keep only an absolute path or
    // a path in the chat's folder, which such a phrase is not.
    expect(refAt('`"a b"`', 0)).toEqual({ path: '"a b"', end: 7 });
    expect(refAt('``/tmp/"a b.md``', 0)).toBeNull(); // a longer fence than messageRef writes
    expect(refAt('`/tmp/"a b.md', 0)).toBeNull(); // no closing fence
    expect(refsIn('he said "a b" to @alice at me@example.com, see `code`')).toEqual([{ at: 17, end: 23, path: "alice" }]);
  });
});

describe("draft rules (D49)", () => {
  const edit = (text: string, more: Partial<{ mode: "chat" | "slash" | "bash"; command: string | null; link: boolean; uploads: string[] }> = {}) => ({
    text,
    mode: more.mode ?? "chat",
    command: more.command ?? null,
    link: more.link ?? false,
    uploads: more.uploads ?? [],
  });
  const d0 = emptyDraft(AT);
  test("a change makes a new rev; the same content makes none", () => {
    const d1 = nextDraft(d0, edit("hello"), "tabA", AT);
    expect(d1).toEqual({ rev: 1, text: "hello", mode: "chat", command: null, link: false, uploads: [], by: "tabA", at: AT });
    expect(nextDraft(d1, edit("hello"), "tabB", "later")).toBe(d1);
    expect(nextDraft(d1, edit("hello", { link: true }), "tabB", AT).rev).toBe(2);
  });
  test("the text is cut at 20,000 units, never inside a surrogate pair", () => {
    expect(nextDraft(d0, edit("a".repeat(LIMITS.draftText)), "t", AT).text.length).toBe(LIMITS.draftText);
    expect(nextDraft(d0, edit("a".repeat(LIMITS.draftText + 1)), "t", AT).text.length).toBe(LIMITS.draftText);
    const pairAtCut = `${"a".repeat(LIMITS.draftText - 1)}\u{1f600}`;
    expect(nextDraft(d0, edit(pairAtCut), "t", AT).text).toBe("a".repeat(LIMITS.draftText - 1));
  });
  test("the chip stays in slash mode only", () => {
    expect(nextDraft(d0, edit("x", { mode: "slash", command: "compact" }), "t", AT).command).toBe("compact");
    expect(nextDraft(d0, edit("x", { mode: "bash", command: "compact" }), "t", AT).command).toBeNull();
  });
  test("a send clears the draft when the sender changed it last, or when its rev is the one the sender saw", () => {
    const mine = nextDraft(d0, edit("typed here"), "tabA", AT);
    expect(draftAfterSend(mine, "tabA", null, "t2")).toEqual({ ...emptyDraft("t2"), rev: 2, by: "tabA" });
    expect(draftAfterSend(mine, "tabB", 1, "t2")).toEqual({ ...emptyDraft("t2"), rev: 2, by: "tabB" });
  });
  test("a send keeps another page's newer draft", () => {
    const other = nextDraft(d0, edit("typed on the phone"), "tabB", AT);
    expect(draftAfterSend(other, "tabA", 0, "t2")).toBeNull();
    expect(draftAfterSend(other, "tabA", null, "t2")).toBeNull();
  });
  test("a send onto an empty draft still moves its rev, so a reload can tell that the send arrived", () => {
    // The press came before the box's save (250 ms), so the server's draft is still empty at the rev the page saw.
    expect(draftAfterSend(d0, "tabA", 0, "t2")).toEqual({ ...emptyDraft("t2"), rev: 1, by: "tabA" });
    const cleared = draftAfterSend(nextDraft(d0, edit("typed here"), "tabA", AT), "tabA", null, "t2")!;
    expect(draftAfterSend(cleared, "tabA", null, "t3")).toEqual({ ...emptyDraft("t3"), rev: 3, by: "tabA" });
    // Another page's text that came after the rev the sender saw still stays.
    expect(draftAfterSend(nextDraft(d0, edit("typed on the phone"), "tabB", AT), "tabA", 0, "t2")).toBeNull();
  });
});

describe("the chat list on the page", () => {
  const row = (chat: string, more: Partial<ChatRow> = {}): ChatRow => ({ chat, title: "T", project: PROJECT, state: "sleeping", needsYou: false, lastActivity: AT, archived: false, ...more });
  const A = newChatId();
  const B = newChatId();
  test("a list replaces, a delta changes one row, a new chat joins, a gone chat leaves", () => {
    let list = applyChatsFrame([], { t: "chats", list: [row(A), row(B)] });
    expect(list.map((r) => r.chat)).toEqual([A, B]);
    list = applyChatsFrame(list, { t: "chats", delta: { chat: A, archived: true, state: "ending" } });
    expect(list[0]).toEqual(row(A, { archived: true, state: "ending" }));
    const C = newChatId();
    list = applyChatsFrame(list, { t: "chats", delta: { chat: C, title: "New", project: PROJECT, state: "starting", needsYou: false, lastActivity: AT, archived: false } });
    expect(list.map((r) => r.chat)).toEqual([A, B, C]);
    // A row that a delta makes reads as not busy until the server says it is (D48: Stop and archive).
    expect(list[2]!.busy).toBe(false);
    list = applyChatsFrame(list, { t: "chats", delta: { chat: C, busy: true } });
    expect(list[2]!.busy).toBe(true);
    list = applyChatsFrame(list, { t: "chats", delta: { chat: B, gone: true } });
    expect(list.map((r) => r.chat)).toEqual([A, C]);
  });
});

describe("the draft frame and attached carry the same draft", () => {
  test("DraftState round-trips through a draft edit", () => {
    const d: DraftState = nextDraft(emptyDraft(AT), { text: "x", mode: "chat", command: null, link: false, uploads: [UP1] }, "tab", AT);
    const f = ok({ t: "draft", chat: CHAT, text: d.text, mode: d.mode, command: d.command, link: d.link, uploads: d.uploads });
    expect(f).toEqual({ t: "draft", chat: CHAT, text: "x", mode: "chat", command: null, link: false, uploads: [UP1] });
  });
});

describe("the mention chips (9.3, owner row 54)", () => {
  const send = { t: "send", rid: RID, chat: CHAT, uuid: RID, text: "Read this", draftRev: 2, uploads: [] };
  const bash = { t: "bash", rid: RID, chat: CHAT, input: "wc -l", draftRev: null, uploads: [] };
  const draft = { t: "draft", chat: CHAT, text: "", mode: "chat", command: null, link: false, uploads: [] };
  test("send, bash and draft carry mentions: paths relative to the chat's folder, in chip order", () => {
    const m = ["web/composer/Composer.tsx", "docs/Écran.md", "my notes/a b.txt", "家族/\u{1f600}.png"];
    for (const f of [send, bash, draft]) expect(ok({ ...f, mentions: m })).toEqual({ ...f, mentions: m } as ClientFrame);
  });
  test("absent or empty is none, and the key is left out", () => {
    for (const f of [send, bash, draft]) {
      expect(ok(f)).toEqual(f as ClientFrame);
      expect("mentions" in ok({ ...f, mentions: [] })).toBe(false);
    }
  });
  test("repeats are dropped, the order kept", () => {
    expect(ok({ ...send, mentions: ["b.ts", "a.ts", "b.ts", "a.ts"] })).toMatchObject({ mentions: ["b.ts", "a.ts"] });
  });
  test("a path that is not relative to the chat's folder refuses the frame, and the reason names no path", () => {
    const refused = ["/etc/passwd", "../secret", "a/../b", "./a", "a//b", "a/", "", "two\nlines.txt", "tab\there", "docs/\u202egpj.exe", "a\u0085b", "x".repeat(1025)];
    for (const f of [send, bash, draft])
      for (const p of refused) {
        const r = bad({ ...f, mentions: ["ok.ts", p] });
        expect(r.reason).toBe("mentions: not a list of at most 100 paths relative to the chat's folder");
        if (p) expect(r.reason).not.toContain(p);
      }
    expect(isSafeRelativePath("x".repeat(1024))).toBe(true);
    expect(ok({ ...send, mentions: ["x".repeat(1024)] })).toMatchObject({ t: "send" });
  });
  test("not a list, an item that is not a string, and over 100 items are refused", () => {
    for (const v of ["a.ts", null, {}, 3, [1], [null], [["a.ts"]]]) bad({ ...send, mentions: v });
    const many = Array.from({ length: LIMITS.sendMentions + 1 }, (_, i) => `f${i}.ts`);
    bad({ ...send, mentions: many });
    bad({ ...draft, mentions: Array.from({ length: LIMITS.draftMentions + 1 }, (_, i) => `f${i}.ts`) });
    expect((ok({ ...send, mentions: many.slice(0, LIMITS.sendMentions) }) as { mentions: string[] }).mentions.length).toBe(100);
    // The cap counts the list as sent, before the repeats are dropped.
    bad({ ...send, mentions: Array.from({ length: LIMITS.sendMentions + 1 }, () => "same.ts") });
  });
  test("a send may hold only mention chips, but never nothing", () => {
    expect(ok({ ...send, text: "", mentions: ["a.ts"] })).toMatchObject({ text: "", mentions: ["a.ts"] });
    expect(bad({ ...send, text: " ", mentions: [] }).reason).toBe("text: empty");
    expect(bad({ ...bash, input: " ", mentions: ["a.ts"] }).reason).toBe("input: empty");
  });
  test("the new-chat form's mentions (D59): read as a send's, the key only when some; chips alone are a first message", () => {
    const nc = { t: "new_chat", rid: RID, project: PROJECT, uuid: RID2, text: "go" };
    expect(ok({ ...nc, mentions: ["a.ts", "b/c.ts", "a.ts"] })).toMatchObject({ t: "new_chat", mentions: ["a.ts", "b/c.ts"] });
    expect("mentions" in ok({ ...nc, mentions: [] })).toBe(false);
    expect("mentions" in ok(nc)).toBe(false);
    expect(ok({ ...nc, text: "", mentions: ["a.ts"] })).toMatchObject({ text: "", mentions: ["a.ts"] });
    expect(bad({ ...nc, text: " ", mentions: [] }).reason).toBe("text: empty");
    for (const v of ["a.ts", null, [1], ["/etc/passwd"], ["../x"], ["a/./b"], ["a\u0000b"]]) bad({ ...nc, mentions: v });
    bad({ ...nc, mentions: Array.from({ length: LIMITS.sendMentions + 1 }, (_, i) => `f${i}.ts`) });
  });
  test("mentionsOf, for the draft record: absent is none; a bad list is null", () => {
    expect(mentionsOf(undefined)).toEqual([]);
    expect(mentionsOf([])).toEqual([]);
    expect(mentionsOf(["a.ts", "b/c.ts", "a.ts"])).toEqual(["a.ts", "b/c.ts"]);
    for (const v of [null, "a.ts", ["/abs"], ["../x"], [1], Array.from({ length: 101 }, (_, i) => `f${i}`)]) expect(mentionsOf(v)).toBeNull();
    expect(mentionsOf(["a", "b", "c"], 2)).toBeNull();
  });
  test("the refusal's ack line fits a chat's box and the new-chat form's, where no chat exists yet (W19d)", () => {
    const line = "A file in the message box is not in this folder any more. Remove it and try again.";
    expect(ERROR_CODES).toContain("mention_gone");
    expect(ERROR_MESSAGES.mention_gone).toBe(line);
    expect(ERROR_MESSAGES.mention_gone).not.toContain("chat");
    expect(ackFail(RID, "mention_gone")).toEqual({ t: "ack", rid: RID, ok: false, error: { code: "mention_gone", message: line } });
  });
  test("D58: Continue here of a session that another app has open now is refused with session_open", () => {
    expect(ERROR_CODES).toContain("session_open");
    expect(ERROR_MESSAGES.session_open).toBe("That session is open in another app now. Continue it in a copy.");
  });
  test("a draft with mentions: a change makes a new rev, the same list none, at most 100, the key only when some", () => {
    const edit = (mentions?: string[]) => ({ text: "x", mode: "chat" as const, command: null, link: false, uploads: [], ...(mentions ? { mentions } : {}) });
    const d0 = nextDraft(emptyDraft(AT), edit(), "tabA", AT);
    expect("mentions" in d0).toBe(false);
    const d1 = nextDraft(d0, edit(["a.ts"]), "tabA", AT);
    expect(d1).toMatchObject({ rev: d0.rev + 1, mentions: ["a.ts"] });
    expect(nextDraft(d1, edit(["a.ts"]), "tabB", "later")).toBe(d1);
    const d2 = nextDraft(d1, edit(["b.ts", "a.ts"]), "tabA", AT);
    expect(d2).toMatchObject({ rev: d1.rev + 1, mentions: ["b.ts", "a.ts"] });
    // Remove takes a chip out of the draft only; the last one gone leaves no key.
    const d3 = nextDraft(d2, edit([]), "tabA", AT);
    expect(d3.rev).toBe(d2.rev + 1);
    expect("mentions" in d3).toBe(false);
    // No list and an empty list are the same content.
    expect(nextDraft(d0, edit([]), "tabA", AT)).toBe(d0);
    const many = Array.from({ length: 150 }, (_, i) => `f${i}.ts`);
    expect(nextDraft(d0, edit(many), "tabA", AT).mentions).toEqual(many.slice(0, LIMITS.draftMentions));
  });
  test("a send clears the mention chips with the rest of the draft", () => {
    const d = nextDraft(emptyDraft(AT), { text: "x", mode: "chat", command: null, link: false, uploads: [], mentions: ["a.ts"] }, "tabA", AT);
    const after = draftAfterSend(d, "tabA", null, "t2")!;
    expect(after).toEqual({ ...emptyDraft("t2"), rev: d.rev + 1, by: "tabA" });
    expect("mentions" in after).toBe(false);
  });
  test("DraftState with mentions round-trips through a draft edit", () => {
    const d = nextDraft(emptyDraft(AT), { text: "", mode: "chat", command: null, link: false, uploads: [UP1], mentions: ["src/a.ts"] }, "tab", AT);
    const f = ok({ t: "draft", chat: CHAT, text: d.text, mode: d.mode, command: d.command, link: d.link, uploads: d.uploads, mentions: d.mentions });
    expect(f).toEqual({ t: "draft", chat: CHAT, text: "", mode: "chat", command: null, link: false, uploads: [UP1], mentions: ["src/a.ts"] });
  });
});

describe("the user event's mentions (9.3: a sent mention shows as a tile)", () => {
  const user = (over: Record<string, unknown> = {}) => ({ k: "user", uuid: RID, text: "Read these", queued: false, ...over }) as ChatEvent;
  const M = ["notes/会議メモ 2026.md", "assets/\u{1f680} launch plan.md", "src/upload.ts"];
  test("the paths the message was sent with, in chip order: an event that holds them comes back equal", () => {
    expect(capEvent(user({ mentions: M }))).toEqual(user({ mentions: M }));
    expect(capEvent(capEvent(user({ mentions: M })))).toEqual(user({ mentions: M }));
    expect(userMentions(M)).toEqual({ mentions: M });
    // The text's cap leaves the list whole: the page still shows a tile for a reference the cap cut off.
    const long = capEvent(user({ text: "u".repeat(25_000), mentions: M })) as Extract<ChatEvent, { k: "user" }>;
    expect([long.text.length, long.mentions]).toEqual([LIMITS.userText, M]);
  });
  test("absent is no record, and the key is left out: the message reads as before (from before v0.3, or the terminal)", () => {
    expect(capEvent(user())).toEqual(user());
    expect(userMentions(undefined)).toEqual({});
  });
  test("an empty list is kept: a message this server sent with no mention chips, so no reference of its text is a tile", () => {
    expect(capEvent(user({ mentions: [] }))).toEqual(user({ mentions: [] }));
    expect(userMentions([])).toEqual({ mentions: [] });
  });
  test("a list that is not one of paths relative to the chat's folder is dropped whole; repeats go, the order kept", () => {
    for (const v of [null, "a.ts", {}, [1], ["a.ts", "/etc/passwd"], ["../x"], ["a//b"], ["a\nb"], Array.from({ length: LIMITS.sendMentions + 1 }, (_, i) => `f${i}.ts`)]) {
      expect(userMentions(v)).toEqual({});
      expect("mentions" in capEvent(user({ mentions: v }))).toBe(false);
    }
    expect(capEvent(user({ mentions: ["b.ts", "a.ts", "b.ts"] }))).toEqual(user({ mentions: ["b.ts", "a.ts"] }));
    expect(userMentions(Array.from({ length: LIMITS.sendMentions }, (_, i) => `f${i}.ts`)).mentions!.length).toBe(LIMITS.sendMentions);
  });
});

describe("version 3: v0.4 resume, restart, worktrees and environment variables (iteration 4)", () => {
  test("the version went to 3 once for the whole iteration (and to 4 in iteration 5, below): a page of an older version reloads", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(3);
  });

  test("send_queued (RD-8 Send again) and end_here (End it here and copy) name one chat, get one ack and are stored by rid", () => {
    for (const t of ["send_queued", "end_here"] as const) {
      expect(ok({ t, rid: RID, chat: CHAT, uuid: RID2 })).toEqual({ t, rid: RID, chat: CHAT });
      expect(isRequestFrame(ok({ t, rid: RID, chat: CHAT }))).toBe(true);
      expect(ackIsStored(t)).toBe(true);
      expect(bad({ t, rid: RID, chat: "nope" })).toMatchObject({ rid: RID, reason: "chat: bad id" });
      expect(bad({ t, chat: CHAT }).rid).toBeNull();
    }
    expect(ackOk<"send_queued">(RID, { started: true })).toEqual({ t: "ack", rid: RID, ok: true, result: { started: true } });
    expect(ackOk<"end_here">(RID, { ending: true })).toEqual({ t: "ack", rid: RID, ok: true, result: { ending: true } });
    expect(ackOk<"end_here">(RID, { ended: true })).toEqual({ t: "ack", rid: RID, ok: true, result: { ended: true } });
  });

  test("the new codes have their fixed lines, which name no path and no value", () => {
    const lines: Partial<Record<ErrorCode, string>> = {
      queue_full: "Too many messages wait in this chat. Take one back, or wait for Claude.",
      env_unreadable: "kitespan could not read this environment's variables, so its chats do not start. Enter them again, or remove the unreadable file.",
      worktree_gone: "This chat's worktree is not there any more.",
      worktree_unverified: "Claude Code could not check this chat's worktree just now. Try again.",
      worktree_resume_refused: "Claude Code would not continue this chat in its worktree.",
      cwd_unavailable: "This chat's folder was deleted or moved, or it cannot be read.",
    };
    for (const [code, line] of Object.entries(lines) as [ErrorCode, string][]) {
      expect(ERROR_CODES).toContain(code);
      expect(ERROR_MESSAGES[code]).toBe(line);
      expect(ackFail(RID, code)).toEqual({ t: "ack", rid: RID, ok: false, error: { code, message: line } });
    }
    // The codes that the restart, the held chats and the mentions already had stay.
    for (const code of ["restarting", "session_held", "mention_gone"] as const) expect(ERROR_CODES).toContain(code);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  test("a restored message's user event keeps notSent, a stop line its id and a refused start's line its code: the caps change none", () => {
    const restored: ChatEvent = { k: "user", uuid: RID, text: "Run the tests", queued: true, mentions: [], notSent: true };
    expect(capEvent(restored)).toEqual(restored);
    const stop: ChatEvent = { k: "notice", text: "kitespan stopped while this chat was running. Send a message to continue.", id: "stop-1" };
    expect(capEvent(stop)).toEqual(stop);
    const refused: ChatEvent = { k: "notice", text: ERROR_MESSAGES.worktree_unverified, code: "worktree_unverified" };
    expect(capEvent(refused)).toEqual(refused);
  });

  test("the server's new fields: the snapshot's tail, the replay's cursor, the update's kind, a notice that goes, a hold's kind", () => {
    const draft: DraftState = emptyDraft(AT);
    const frames: ServerFrame[] = [
      { t: "snapshot", chat: CHAT, seq: 2, tail: 1, history: [], more: null },
      { t: "attached", chat: CHAT, epoch: "mh0x1abc-abcdefghijkl", state: "idle", seq: 5, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft, archived: false, replay: "events", cursor: 3 },
      { t: "welcome", epoch: "mh0x1abc-abcdefghijkl", version: "0.4.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false, kind: "apply" }, auth: "none" },
      { t: "notice", text: "kitespan restarts when the running turns end.", id: "restart", actions: ["cancel_restart", "restart_now"] },
      { t: "notice", text: "", id: "restart", gone: true },
      { t: "notice", text: "Update available.", id: "update", actions: ["update"] },
      { t: "chats", delta: { chat: CHAT, held: { app: "other", session: RID2, kind: "finishing" } } },
    ];
    for (const f of frames) expect(JSON.parse(JSON.stringify(f))).toEqual(f);
    expect(UPDATE_KINDS).toEqual(["none", "available", "apply", "unfinished", "diverged"]);
    // Row 108: the Update action on the notice of an update that origin has.
    expect(NOTICE_ACTIONS).toEqual(["cancel_restart", "restart_now", "update"]);
    expect(HOLD_KINDS).toEqual(["finishing", "handed"]);
  });

  test("a hold's kind comes and goes with the row's held delta; a session that waits for an answer is busy too", () => {
    const row: ChatRow = { chat: CHAT, title: null, project: PROJECT, state: "sleeping", needsYou: false, lastActivity: AT, archived: false };
    const held = applyChatsFrame([row], { t: "chats", delta: { chat: CHAT, held: { app: "terminal", session: RID2, kind: "handed" } } });
    expect(held[0]!.held).toEqual({ app: "terminal", session: RID2, kind: "handed" });
    expect(applyChatsFrame(held, { t: "chats", delta: { chat: CHAT, held: null } })[0]!.held).toBeNull();
    const waiting: SessionOpen = { app: "terminal", busy: true, waiting: true };
    expect(waiting.busy).toBe(true);
  });
});

describe("row 116 (R116): the seen flag on the row and the page's on_screen report", () => {
  test("on_screen names one attached chat and says on or off: no rid, no ack, never a request; anything else is refused", () => {
    expect(ok({ t: "on_screen", chat: CHAT, on: false, rid: RID, extra: 1 })).toEqual({ t: "on_screen", chat: CHAT, on: false });
    expect(isRequestFrame(ok({ t: "on_screen", chat: CHAT, on: true }))).toBe(false);
    expect((REQUEST_TYPES as readonly string[]).includes("on_screen")).toBe(false);
    for (const f of [{ t: "on_screen", chat: CHAT }, { t: "on_screen", chat: CHAT, on: 1 }, { t: "on_screen", chat: CHAT, on: "true" }, { t: "on_screen", chat: "nope", on: true }, { t: "on_screen", on: true }]) bad(f);
  });

  test("a row says unseen only while a turn's end waits to be seen; a delta sets it and takes it away with null", () => {
    expect(UNSEEN_KINDS).toEqual(["done", "failed"]);
    const row: ChatRow = { chat: CHAT, title: null, project: PROJECT, state: "idle", needsYou: false, lastActivity: AT, archived: false };
    const done = applyChatsFrame([row], { t: "chats", delta: { chat: CHAT, unseen: "done" } });
    expect(done[0]!.unseen).toBe("done");
    const failed = applyChatsFrame(done, { t: "chats", delta: { chat: CHAT, unseen: "failed" } });
    expect(failed[0]!.unseen).toBe("failed");
    expect(applyChatsFrame(failed, { t: "chats", delta: { chat: CHAT, unseen: null } })[0]!.unseen ?? null).toBeNull();
    // A row that a delta makes is seen until the server says it is not.
    const made = applyChatsFrame([], { t: "chats", delta: { chat: CHAT, title: "New", project: PROJECT, state: "starting", needsYou: false, lastActivity: AT, archived: false } });
    expect(made[0]!.unseen ?? null).toBeNull();
  });

  test("the version is 4 or more since iteration 5: a page of version 3 never says on_screen and ignores unseen, so it reloads at welcome", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(4);
  });

  test("the version is 5 since iteration 7: a page from before the browser pane reloads at welcome", () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });

  test("a page's on counts while its socket was heard from in the last 20 s: a visible page pings every 15 s", () => {
    expect(WIRE.onScreenFreshMs).toBe(20_000);
    expect(WIRE.onScreenFreshMs).toBeGreaterThan(WIRE.pingEveryMs);
  });
});

describe("a cut tool result says so (v0.6 touch, T-26)", () => {
  const result = (text: string, more: Partial<Extract<ChatEvent, { k: "tool_result" }>> = {}): ChatEvent => ({ k: "tool_result", id: "toolu_01Long", text, isError: false, parent: null, report: null, ...more });
  const cutOf = (e: ChatEvent) => (e as Extract<ChatEvent, { k: "tool_result" }>).cut;
  const textOf = (e: ChatEvent) => (e as Extract<ChatEvent, { k: "tool_result" }>).text;

  test("a result over the cap keeps its first 6,000 characters and gets cut: the whole text's length", () => {
    const e = capEvent(result("r".repeat(7_000)));
    expect(textOf(e).length).toBe(6_000);
    expect(cutOf(e)).toBe(7_000);
    // Cut before a surrogate pair, the text is 5,999 long and cut still names the whole length.
    const pair = capEvent(result(`${"a".repeat(5_999)}\u{1f600}${"b".repeat(100)}`));
    expect(textOf(pair).length).toBe(5_999);
    expect(cutOf(pair)).toBe(6_101);
  });

  test("a result that fits gets no cut, and an event that fits comes back equal", () => {
    for (const n of [0, 1, 5_999, 6_000]) {
      const e = result("r".repeat(n));
      expect(capEvent(e)).toEqual(e);
      expect("cut" in capEvent(e)).toBe(false);
    }
  });

  test("capEvent is idempotent: a second cap keeps cut", () => {
    const once = capEvent(result("r".repeat(7_000)));
    const twice = capEvent(once);
    expect(twice).toEqual(once);
    expect(cutOf(twice)).toBe(7_000);
    expect(capEvent(capEvent(capEvent(result("x".repeat(250_000)))))).toEqual(capEvent(result("x".repeat(250_000))));
  });

  test("the reader of cut takes a whole length above the text it came with, and nothing else", () => {
    const text = "r".repeat(6_000);
    expect(toolCutOf(7_000, text)).toBe(7_000);
    expect(toolCutOf(6_001, text)).toBe(6_001);
    for (const v of [6_000, 5_000, 0, -1, -7_000, 7_000.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "7000", null, undefined, true, {}, [7_000]]) expect([v, toolCutOf(v, text)]).toEqual([v, null]);
    // A cut that a frame carries on a text it does not exceed is no cut: capEvent drops it.
    const forged = capEvent(result("short", { cut: 3 }));
    expect("cut" in forged).toBe(false);
    for (const bad of [-1, 1.5, "9000", null]) expect("cut" in capEvent(result("short", { cut: bad as unknown as number }))).toBe(false);
    // A valid one stays, with the trust and background keys beside it.
    const kept = capEvent(result("r".repeat(6_000), { cut: 9_000 }));
    expect(cutOf(kept)).toBe(9_000);
  });

  test("the version stays 5 for cut (DESIGN 4.3's version rule)", () => {
    // test/web/reduce.test.ts feeds a tool_result with cut and an unknown key through the page's receive path and its
    // reducer, and the row is drawn: a page of this version refuses neither, so no raise.
    expect(PROTOCOL_VERSION).toBe(5);
  });

  test("the whole output's path: the chat and the tool use, each encoded", () => {
    expect(toolOutputPath(CHAT, "toolu_01Long")).toBe(`/api/chats/${CHAT}/tools/toolu_01Long/output`);
    expect(toolOutputPath(CHAT, "a/b")).toBe(`/api/chats/${CHAT}/tools/a%2Fb/output`);
  });
});
