// A /rename typed in the chat, through the real Agent SDK and the fake CLI (fixtures/rename.json, in the live probe's
// order): Claude Code's session_title_changed is the user's own rename, the command's output stays as its quiet output
// row, and the turn ends on the user's message. No model, no real claude.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rig, type Rig } from "../fake-claude/harness";
import { loadFixture, type Fixture } from "../fake-claude/install";

let rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.map((r) => r.cleanup()));
  rigs = [];
});
const use = (r: Rig) => (rigs.push(r), r);

describe("/rename through the driver", () => {
  test("the name is a rename, before the turn's init; the output row stays, never a reply", async () => {
    const r = use(rig(loadFixture("rename")));
    const { chat, events } = r.open();
    const uuid = randomUUID();
    await chat.send({ uuid, text: "/rename Probe title 42" });
    await events.turnEnds(1);
    expect(events.of("title")).toEqual([{ k: "title", title: "Probe title 42", from: "renamed" }]);
    const kinds = events.events.map((e) => e.k);
    expect(kinds.indexOf("title")).toBeLessThan(kinds.indexOf("session"));
    expect(events.of("local_output")).toEqual([{ k: "local_output", stream: "stdout", text: "Session renamed to: Probe title 42" }]);
    expect([...events.of("block"), ...events.of("block_start")]).toEqual([]);
    expect(events.of("turn_end")[0]).toMatchObject({ ok: true, subtype: "success", uuids: [uuid] });
  });

  test("a start of a session that has a name sends the name again: the same rename", async () => {
    const fixture: Fixture = { ...loadFixture("rename"), onStart: [{ emit: { type: "system", subtype: "session_title_changed", title: "Probe title 42" } }] };
    const r = use(rig(fixture));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hello" });
    await events.turnEnds(1);
    expect(events.of("title")).toEqual([{ k: "title", title: "Probe title 42", from: "renamed" }]);
  });
});

describe("kitespan's own Rename, told to the running Claude Code", () => {
  test("rename sends rename_session with the title, source host and the session id, as Claude Code's own rename path takes it", async () => {
    const r = use(rig("text-thinking"));
    const { chat, events, sessionId } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hello" });
    await events.turnEnds(1);
    expect(await chat.rename("  Flaky   upload test ", sessionId)).toBe(true);
    const req = r.fake.trace().find((l) => l.t === "control" && l.subtype === "rename_session")!.request as Record<string, unknown>;
    expect(req).toEqual({ subtype: "rename_session", title: "Flaky upload test", source: "host", session_id: sessionId });
  });

  test("a refused rename_session is a failure; a Claude Code without the method, or a closed chat, takes none", async () => {
    const r = use(rig({ ...loadFixture("text-thinking"), refuse: ["rename_session"] }));
    const { chat, events, sessionId } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hello" });
    await events.turnEnds(1);
    await expect(chat.rename("Mine", sessionId)).rejects.toMatchObject({ code: "failed" });
    await expect(chat.rename("x", "not-a-uuid")).rejects.toMatchObject({ code: "bad_request" });
    await expect(chat.rename("   ", sessionId)).rejects.toMatchObject({ code: "bad_request" });
    // Feature detection: an SDK whose query object has no renameSession.
    const q = (chat as unknown as { q: Record<string, unknown> }).q;
    const own = q.renameSession;
    q.renameSession = undefined;
    expect(await chat.rename("Mine", sessionId)).toBe(false);
    q.renameSession = own;
    await chat.close();
    expect(await chat.rename("Mine", sessionId)).toBe(false);
    expect(r.fake.trace().filter((l) => l.t === "control" && l.subtype === "rename_session")).toHaveLength(1);
  });
});
