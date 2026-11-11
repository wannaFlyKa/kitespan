// U1 (DESIGN-U1 5, D49): the `changes` event in the page's store. Live and in history it leaves one note per summary
// beside the rows (Chat.changes: at most 5 files, never diff text), with where it came among the rows; the same summary
// again replaces its note; a note that does not read is none; a snapshot starts the notes again and an older page's
// notes go before the chat's own. Every page draws the same cards from them (one chat on every device).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatEvent } from "../../shared/protocol";
import { applyEvent, applyHistory, markAt, type ChatPart } from "../../web/state/reduce";
import { CHANGES_EVENT_FILES, mergeChanges, readChangesEvent, type ChangesNote } from "../../web/changes/model";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

const blank = (): ChatPart => ({
  items: [],
  pending: [],
  title: "",
  titleSource: "first-prompt",
  model: "default",
  effort: "default",
  mode: "default",
  picks: { model: null, effort: null, mode: null },
  sessionId: "",
  bypassFlag: false,
  lostRequests: [],
  turn: null,
  liveModel: null,
  version: null,
  commands: null,
  tasks: [],
  suggestion: null,
  outputs: [],
});

const T = "k3m7q2x4ab";
const changes = (over: Record<string, unknown> = {}): ChatEvent =>
  ({ k: "changes", id: T, at: ["u1"], how: "git", total: 2, added: 14, removed: 3, files: [{ path: "src/a.ts", added: 12, removed: 3, status: "M" }, { path: "docs/b.md", added: 2, removed: 0, status: "A" }], ...over }) as unknown as ChatEvent;

const turn: ChatEvent[] = [
  { k: "turn_start", by: "user" },
  { k: "user", uuid: "u1", text: "Fix it", queued: false },
  { k: "tool_call", id: "t1", name: "Edit", input: { file_path: "/w/src/a.ts", old_string: "a", new_string: "b" }, parent: null },
  { k: "tool_result", id: "t1", text: "ok", isError: false, parent: null, report: null },
  { k: "block", key: "msg_1:0", kind: "text", text: "Done.", parent: null },
  { k: "turn_end", ok: true, subtype: "success", durationMs: 1000, error: null, uuids: ["u1"] },
];

describe("the changes event (DESIGN-U1 5)", () => {
  test("live: one note, with where it came among the rows; the transcript gets no row", () => {
    let c = blank();
    turn.forEach((e, i) => (c = applyEvent(c, e, { seq: i + 1, replay: false, cwd: "/w", now: 1000 })));
    const items = c.items;
    c = applyEvent(c, changes(), { seq: 9, replay: false, cwd: "/w", now: 2000 });
    expect(c.items).toBe(items);
    expect(c.changes?.length).toBe(1);
    const note = c.changes![0]!;
    expect([note.id, note.at, note.how, note.total, note.added, note.removed, note.files.length]).toEqual([T, ["u1"], "git", 2, 14, 3, 2]);
    expect(note.near).toEqual(markAt(items));
  });

  test("in history (a reload, another device, after a restart): the same note", () => {
    const c = applyHistory(blank(), [...turn, changes()], { cwd: "/w", now: 1000, ended: true });
    expect(c.changes?.map((n) => n.id)).toEqual([T]);
    expect(c.changes?.[0]?.near?.[0]).toBe(c.items[c.items.length - 1]!.id);
  });

  test("the same summary again replaces its note; another one adds its own", () => {
    let c = applyEvent(blank(), changes(), { seq: 1, replay: false, cwd: null, now: 0 });
    c = applyEvent(c, changes({ added: 15 }), { seq: 2, replay: true, cwd: null, now: 0 });
    c = applyEvent(c, changes({ id: "bbbbbbbbbb", at: ["u2"] }), { seq: 3, replay: false, cwd: null, now: 0 });
    expect(c.changes?.map((n) => [n.id, n.added])).toEqual([
      [T, 15],
      ["bbbbbbbbbb", 14],
    ]);
  });

  test("read by the protocol's own check: a bad id, a bad file, a bad count, more than 5 files is no card", () => {
    expect(readChangesEvent({ id: "BAD", at: ["u1"], how: "git", total: 1, added: 1, removed: 0, files: [] })).toBeNull();
    expect(readChangesEvent({ id: T, at: "u1", how: "git", total: 1, added: 1, removed: 0, files: [] })).toBeNull();
    expect(readChangesEvent({ id: T, at: [], how: "git", total: 1, added: 1, removed: 0, files: [] })).toBeNull();
    expect(readChangesEvent({ id: T, at: ["u1"], how: "git", total: -1, added: 1, removed: 0, files: [] })).toBeNull();
    const many = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.ts`, added: 1, removed: 0, status: "M" }));
    expect(readChangesEvent({ id: T, at: ["u1"], how: "git", total: 9, added: 9, removed: 0, files: many })).toBeNull();
    expect(readChangesEvent({ id: T, at: ["u1"], how: "git", total: 9, added: 9, removed: 0, files: many.slice(0, 5) })?.files.length).toBe(CHANGES_EVENT_FILES);
    expect(CHANGES_EVENT_FILES).toBe(5);
    // A file whose path is not a safe relative path never goes into a URL: the card does not read.
    expect(readChangesEvent({ id: T, at: ["u1"], how: "git", total: 2, added: 2, removed: 0, files: [{ path: "/etc/passwd", added: 1, removed: 0, status: "M" }, { path: "a.ts", added: 1, removed: 0, status: "M" }] })).toBeNull();
    // No diff text ever reaches the card.
    const e = readChangesEvent({ id: T, at: ["u1"], how: "edits", total: 1, added: 1, removed: 0, files: [{ path: "a.ts", added: 1, removed: 0, status: "M", lines: ["+secret"] }] });
    expect(e?.how).toBe("edits");
    expect(JSON.stringify(e)).not.toContain("secret");
    let c = applyEvent(blank(), changes({ id: "BAD" }), { seq: 1, replay: false, cwd: null, now: 0 });
    expect(c.changes ?? []).toEqual([]);
    c = applyEvent(c, changes({ files: "nope" }), { seq: 2, replay: false, cwd: null, now: 0 });
    expect(c.changes ?? []).toEqual([]);
  });

  test("an older page's notes go before the chat's own, and a note in both is kept once (the newer)", () => {
    const a: ChangesNote = { id: "aaaaaaaaaa", at: ["u1"], how: "git", total: 1, added: 1, removed: 0, files: [] };
    const b: ChangesNote = { ...a, id: "bbbbbbbbbb" };
    expect(mergeChanges([a, b], [{ ...b, added: 9 }]).map((n) => [n.id, n.added])).toEqual([
      ["aaaaaaaaaa", 1],
      ["bbbbbbbbbb", 9],
    ]);
    expect(mergeChanges(undefined, undefined)).toEqual([]);
  });

  test("a snapshot starts the notes again; an older page merges its own (store.ts)", () => {
    const store = src("state", "store.ts");
    expect(store).toMatch(/const base = \{[^}]*changes: \[\][^}]*\}/);
    expect(store).toContain("changes: mergeChanges(older.changes, c.changes)");
  });
});
