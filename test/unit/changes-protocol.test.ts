// U1 (DESIGN-U1 4.4, 5 and 8): the pieces around a turn's summary. The file tools' own patches from the SDK's
// `tool_use_result` (an Edit's structuredPatch, a Write that created a file, an edit held for review, an error); the
// card's check as a page reads it; the URL form (both routes, the summary id's pattern, the reserved whole-chat forms
// that fall back to the chat, the pair values); the store's summaries (their caps, a fallback's hunks, a bad file set
// aside); the boot's tree check, which leaves the marks' git objects alone; and the log's `changes` line.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventMapper, editPatchOf } from "../../server/agents/claude/events";
import { ChangesStore, type TurnRecord } from "../../server/changes/store";
import { logLine } from "../../server/log";
import { createStore } from "../../server/store/store";
import { ownUid } from "../../server/store/files";
import { CHANGES_LIMITS, changeFileApiPath, changesApiPath, changesCardOf } from "../../shared/changes";
import { CHANGES_ID, newChangesId } from "../../shared/ids";
import type { ChatEvent } from "../../shared/protocol";
import { href, paneRouteOf, parsePath } from "../../shared/route";

const C = "k3m7q2x4abk3m7q2x4ab";
const T = "q7m2x4k3ab";
const S = "11111111-2222-4333-8444-555555555555";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = () => {
  const r = mkdtempSync(join(tmpdir(), "kitespan-changes-"));
  roots.push(r);
  return r;
};

describe("the file tools' own patches (edit_patch, the server's alone)", () => {
  const map = (m: Record<string, unknown>, mapper: EventMapper): ChatEvent[] => mapper.map({ session_id: S, uuid: "u-1", ...m } as unknown as SDKMessage);
  test("an Edit's result: its file, its counts, its hunks, after the tool result", () => {
    const m = new EventMapper({ bypass: false });
    map({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "tool_use", id: "toolu_e", name: "Edit", input: { file_path: "/srv/app/a.ts" } }] } }, m);
    const side = { filePath: "/srv/app/a.ts", oldString: "b", newString: "B", originalFile: "a\nb\n", structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+B"] }], userModified: false, replaceAll: false };
    const ev = map({ type: "user", parent_tool_use_id: null, tool_use_result: side, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e", content: "ok" }] } }, m);
    expect(ev).toEqual([
      { k: "tool_result", id: "toolu_e", text: "ok", isError: false, parent: null, report: null },
      { k: "edit_patch", id: "toolu_e", path: "/srv/app/a.ts", create: false, added: 1, removed: 1, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+B"] }], cut: false, parent: null },
    ]);
    // An error result has none.
    const err = map({ type: "user", parent_tool_use_id: null, tool_use_result: side, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e", content: "no", is_error: true }] } }, m);
    expect(err.map((e) => e.k)).toEqual(["tool_result"]);
  });
  test("a Write that created a file with no hunks: one hunk of its content; an update; held for review: none; another tool: none", () => {
    expect(editPatchOf("Write", "w1", { type: "create", filePath: "/srv/app/n.md", content: "one\ntwo\n", structuredPatch: [], originalFile: null }, null)).toEqual({
      k: "edit_patch",
      id: "w1",
      path: "/srv/app/n.md",
      create: true,
      added: 2,
      removed: 0,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+one", "+two"] }],
      cut: false,
      parent: null,
    });
    expect(editPatchOf("Write", "w2", { type: "update", filePath: "/srv/app/n.md", content: "x", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-one", "+x"] }], originalFile: "one" }, "agent_1")).toMatchObject({
      create: false,
      added: 1,
      removed: 1,
      parent: "agent_1",
    });
    expect(editPatchOf("Edit", "e1", { filePath: "/srv/app/a.ts", structuredPatch: [], staged: true }, null)).toBeNull();
    expect(editPatchOf("Bash", "b1", { filePath: "/srv/app/a.ts", structuredPatch: [] }, null)).toBeNull();
    expect(editPatchOf("Edit", "e2", { structuredPatch: [] }, null)).toBeNull();
  });
  test("a huge patch: the counts are whole, the hunks cut to fit, `cut`", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `+${"x".repeat(40)}${i}`);
    const p = editPatchOf("Write", "w1", { type: "create", filePath: "/srv/app/big.txt", content: "", structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 20_000, lines }] }, null)!;
    expect(p.added).toBe(20_000);
    expect(p.cut).toBe(true);
    expect(JSON.stringify(p.hunks).length).toBeLessThanOrEqual(128 * 1024);
  });
});

describe("the card as a page reads it", () => {
  const card = { id: T, at: [S, "toolu_w"], how: "git", total: 7, added: 42, removed: 18, files: [{ path: "src/a.ts", status: "M", added: 12, removed: 3 }, { path: "b.bin", status: "A", added: 0, removed: 0, binary: true }, { path: "new.ts", status: "R", added: 0, removed: 0, from: "old.ts" }] };
  test("a good card reads as it is", () => {
    expect(changesCardOf(card)).toEqual(card as never);
  });
  test("a bad id, a bad row id, more than five files, a bad path, a rename's old path on another status: none", () => {
    expect(changesCardOf({ ...card, id: "all" })).toBeNull();
    expect(changesCardOf({ ...card, at: ["a b"] })).toBeNull();
    expect(changesCardOf({ ...card, at: [] })).toBeNull();
    expect(changesCardOf({ ...card, files: Array(6).fill(card.files[0]) })).toBeNull();
    expect(changesCardOf({ ...card, files: [{ path: "../x", status: "M", added: 1, removed: 0 }] })).toBeNull();
    expect(changesCardOf({ ...card, files: [{ path: "a", status: "M", added: 1, removed: 0, from: "b" }] })).toBeNull();
    expect(changesCardOf({ ...card, total: -1 })).toBeNull();
  });
  test("the summary id: 10 symbols of a-z and 2-7, minted fresh", () => {
    const ids = new Set(Array.from({ length: 200 }, newChangesId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(CHANGES_ID.test(id)).toBe(true);
    expect(CHANGES_ID.test("all")).toBe(false);
  });
  test("the reads' paths: the chat's id, the summary's id, the file's path segment by segment", () => {
    expect(changesApiPath(C, T)).toBe(`/api/chats/${C}/changes/${T}`);
    expect(changeFileApiPath(C, T, "src/a b#.ts")).toBe(`/api/chats/${C}/changes/${T}/files/src/a%20b%23.ts`);
  });
});

describe("the URL form", () => {
  test("a turn's list and one file's diff, view routes with the transcript view and the pair", () => {
    const list = parsePath(`/c/${C}/changes/${T}?view=verbose`);
    expect([list.name, list.params, list.query, list.def.kind]).toEqual(["changesTurn", { chat: C, turn: T }, { view: "verbose" }, "view"]);
    const file = parsePath(`/c/${C}/changes/${T}/test/unit/upload.test.ts?below=shell`);
    expect([file.name, file.params.path, file.query]).toEqual(["changesFile", "test/unit/upload.test.ts", { below: "shell" }]);
    expect(href("changesFile", { chat: C, turn: T, path: "src/a.ts" }, { below: "shell" })).toBe(`/c/${C}/changes/${T}/src/a.ts?below=shell`);
    expect(paneRouteOf(C, `changes/${T}/src/a.ts`)?.name).toBe("changesFile");
    expect(parsePath(`/c/${C}/shell?above=changes/${T}`).query).toEqual({ above: `changes/${T}` });
  });
  test("the whole chat's forms are kept for the next round: they open the chat; a bad id or an unsafe path falls back", () => {
    for (const u of [`/c/${C}/changes`, `/c/${C}/changes/all/src/a.ts`, `/c/${C}/changes/all`, `/c/${C}/changes/NOTANID00`]) {
      const r = parsePath(u);
      expect([u, r.name, r.fallbackFrom]).toEqual([u, "chat", u]);
    }
    expect(parsePath(`/c/${C}/changes/${T}/a/%2e%2e/b`).name).not.toBe("chat");
    expect(parsePath(`/c/${C}/changes/${T}/a%00b`).fallbackFrom).toBeDefined();
  });
});

function record(i: number, files = 1): TurnRecord {
  return {
    id: newChangesId(),
    at: [`7c9e6679-7425-40de-944b-${String(i).padStart(12, "0")}`],
    how: "git",
    from: "a".repeat(40),
    to: "b".repeat(40),
    total: files,
    added: files,
    removed: 0,
    others: 0,
    files: Array.from({ length: files }, (_, k) => ({ path: `src/${"p".repeat(900)}-${k}.ts`, status: "M" as const, added: 1, removed: 0 })),
    made: new Date(0).toISOString(),
  };
}

describe("the store of a chat's summaries", () => {
  test("at most 1,000 summaries, the oldest going first; a fallback's hunks with it", async () => {
    const root = join(tmp(), "changes");
    mkdirSync(root, { mode: 0o700 });
    const store = new ChangesStore(root, ownUid());
    const first = { ...record(0), how: "edits" as const, why: "not_git" as const, from: undefined, to: undefined };
    delete first.from;
    delete first.to;
    expect(await store.add(C, first, { "src/a.ts": [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+a"] }] })).toBe(true);
    expect((await store.edits(C, first.id))["src/a.ts"]).toHaveLength(1);
    for (let i = 1; i <= CHANGES_LIMITS.turns; i++) await store.add(C, { ...record(i), files: [] , total: 1 });
    const list = await new ChangesStore(root, ownUid()).read(C);
    expect(list).toHaveLength(CHANGES_LIMITS.turns);
    expect(list.some((t) => t.id === first.id)).toBe(false);
    expect(await store.edits(C, first.id)).toEqual({});
  }, 60_000);
  test("at most 4 MiB of summaries: big ones push the oldest out", async () => {
    const root = join(tmp(), "changes");
    mkdirSync(root, { mode: 0o700 });
    const store = new ChangesStore(root, ownUid());
    for (let i = 0; i < 6; i++) await store.add(C, record(i, 1000));
    const bytes = readFileSync(join(store.dirOf(C), "turns.json")).byteLength;
    expect(bytes).toBeLessThanOrEqual(CHANGES_LIMITS.turnsBytes);
    expect((await store.read(C)).length).toBeLessThan(6);
  });
  test("a file that fails its check reads as none and is set aside", async () => {
    const root = join(tmp(), "changes");
    mkdirSync(join(root, C), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, C, "turns.json"), JSON.stringify({ v: 1, chat: C, turns: [{ id: "bad" }] }), { mode: 0o600 });
    let setAside = 0;
    expect(await new ChangesStore(root, ownUid(), () => setAside++).read(C)).toEqual([]);
    expect(setAside).toBe(1);
  });
});

describe("the boot's tree check", () => {
  test("leaves the marks' git objects (read-only files in folders of git's making) alone, and checks the rest", async () => {
    const root = tmp();
    const s = createStore({ root });
    await s.open();
    await s.flush();
    const objects = join(root, "state", "changes", C, "objects", "ab");
    mkdirSync(objects, { recursive: true, mode: 0o755 });
    chmodSync(join(root, "state", "changes", C), 0o700);
    chmodSync(join(root, "state", "changes", C, "objects"), 0o700);
    writeFileSync(join(objects, "cdef"), "x", { mode: 0o444 });
    await createStore({ root }).open();
    // A wider changes folder of a chat is still refused.
    chmodSync(join(root, "state", "changes", C), 0o755);
    const err = await createStore({ root })
      .open()
      .catch((e) => e);
    expect(err.problems).toEqual([{ path: `changes/${C}`, why: "wider-mode" }]);
  });
});

describe("the log's changes line", () => {
  test("the chat, the time, the count of files and three flags; nothing else", () => {
    const line = logLine("changes", { chat: C, ms: 28.4, count: 3, ok: true, timeout: false, capped: false, path: "/srv/app/a.ts", route: "/c/:chat" } as never, new Date(0), new Set(["/c/:chat"]));
    expect(line).toEqual({ t: new Date(0).toISOString(), ev: "changes", chat: C, route: null, code: null, signal: null, ms: 28, ok: true, timeout: false, capped: false, err: null, count: 3 });
  });
});
