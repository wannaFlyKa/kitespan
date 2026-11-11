// The fake claude's paced stream (row 79's slow streaming scene): a message that names one gets a long markdown reply
// in that many pieces with that wait after each, through the real Agent SDK and the driver, whatever the fixture.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rig, type Rig } from "./harness";
import { longReply, pacedPrompt } from "./long-reply";

let rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.map((r) => r.cleanup()));
  rigs = [];
});

test("a paced stream sends the long reply in its pieces, a wait after each, thinking first when asked", async () => {
  const r = rig("text-thinking");
  rigs.push(r);
  const { chat, events } = r.open();
  const t0 = Date.now();
  await chat.send({ uuid: randomUUID(), text: pacedPrompt(3000, 30, 20, true) });
  await events.turnEnds(1, 20_000);
  const ms = Date.now() - t0;
  const starts = events.of("block_start");
  expect(starts.map((s) => s.kind)).toEqual(["thinking", "text"]);
  const deltas = events.of("block_delta").filter((d) => d.key === starts[1]!.key);
  expect(deltas.length).toBe(30);
  expect(deltas.map((d) => d.text).join("")).toBe(longReply(3000));
  // 30 thinking pieces and 30 text pieces, 20 ms after each.
  expect(ms).toBeGreaterThanOrEqual(1100);
  expect(events.of("turn_end")[0]).toMatchObject({ ok: true });
});

test("a Stop ends a paced stream where it is", async () => {
  const r = rig("text-thinking");
  rigs.push(r);
  const { chat, events } = r.open();
  await chat.send({ uuid: randomUUID(), text: pacedPrompt(20000, 400, 50) });
  await events.until((ev) => ev.filter((e) => e.k === "block_delta").length >= 3, 10_000);
  await chat.interrupt();
  await events.turnEnds(1, 10_000);
  expect(events.of("block_delta").length).toBeLessThan(400);
});
