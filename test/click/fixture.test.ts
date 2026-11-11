// The resume and send-now flows' turns in the click-through fixture (seed/fixture.ts): each run's message picks its own
// turn, and no two runs share a block, a tool call or a card id, since the runs share one server life.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rig, type Rig } from "../fake-claude/harness";
import { RESUME_A, RESUME_C, RESUME_LONG, RESUME_TAGS, SEND_NOW, SEND_NOW_REPLIES, clickFixture, resumeReply, resumeTurn } from "./seed/fixture";

test("each resume run's text picks its own turn, with ids of its own", () => {
  const f = clickFixture();
  const keys = Object.keys(f.turnsByText ?? {});
  const seen = new Set<string>();
  for (const tag of RESUME_TAGS) {
    const { text, ids } = resumeTurn(tag);
    // The fake claude takes the first key that the text holds (fake-claude.ts runTurn).
    expect(keys.find((k) => text.includes(k))).toBe(text);
    const turn = f.turnsByText![text]!;
    expect(JSON.stringify(turn)).toContain(ids.tool);
    // Reply A is the run's own text: the long one for a tail run.
    expect(JSON.stringify(turn.steps[0])).toContain(JSON.stringify(resumeReply(tag)).slice(1, -1));
    for (const id of Object.values(ids)) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  }
  expect(RESUME_A.length).toBeGreaterThan(200);
  expect(RESUME_C.length).toBeGreaterThan(80);
  expect(RESUME_LONG.startsWith(RESUME_A)).toBe(true);
  expect(RESUME_TAGS.filter((t) => resumeReply(t) === RESUME_LONG)).toEqual(["tail-laptop", "tail-phone"]);
});

// Row 111: the send-now flows' two turns, through the real driver and the fake claude (no transcript is written).
describe("the send-now turns", () => {
  let r: Rig | null = null;
  afterEach(async () => {
    await r?.cleanup();
    r = null;
  });
  const until = async (pred: () => boolean, what: string, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(20);
    }
  };

  test("the long command: each run has a call id of its own; Send now's backgroundTasks returns it at once and the queued message goes into the turn", async () => {
    r = rig({ ...clickFixture(), transcript: false });
    const { chat, events } = r.open();
    const calls: string[] = [];
    for (const n of [1, 2]) {
      const u1 = randomUUID();
      await chat.send({ uuid: u1, text: SEND_NOW.bash });
      await until(() => events.of("task").filter((e) => e.ev === "started").length >= n, "the task's start");
      const call = events.of("tool_call").filter((c) => c.name === "Bash").at(-1)!.id;
      calls.push(call);
      const u2 = randomUUID();
      await chat.send({ uuid: u2, text: "Use the new name." });
      await r.fake.waitFor((l) => l.t === "user" && l.uuid === u2);
      expect(await chat.backgroundAll()).toBe(true);
      await events.turnEnds(n);
      expect(events.of("tool_result").find((e) => e.id === call)?.text).toStartWith("Command was manually backgrounded by user with ID: ");
      expect(events.of("turn_end").at(-1)!.uuids).toEqual([u1, u2]);
      expect(events.of("block_start").length).toBeGreaterThan(0);
    }
    expect(new Set(calls).size).toBe(2);
    const reply = events.of("block_delta").map((d) => d.text).join("");
    expect(reply).toContain(SEND_NOW_REPLIES.bashRead);
  }, 20_000);

  test("the long story: an interrupt stops it with the queued message named, and that message runs next", async () => {
    r = rig({ ...clickFixture(), transcript: false });
    const { chat, events } = r.open();
    const u1 = randomUUID();
    await chat.send({ uuid: u1, text: SEND_NOW.write });
    await until(() => events.of("block_delta").length >= 3, "the story's stream");
    const u2 = randomUUID();
    await chat.send({ uuid: u2, text: "Stop and do this." });
    await r.fake.waitFor((l) => l.t === "user" && l.uuid === u2);
    expect(await chat.interrupt()).toEqual({ stillQueued: [u2] });
    await events.turnEnds(2);
    expect(events.of("turn_end").map((e) => [e.ok, e.uuids])).toEqual([
      [false, [u1]],
      [true, [u2]],
    ]);
  }, 20_000);
});
