// The ack store (DESIGN.md 4.3 "Request ids and acks"): keyed by `rid`, 10 minutes, at most 1,000; a resend gets the
// same ack and is not applied again, also while the first is still running.
import { describe, expect, test } from "bun:test";
import { WIRE, ackOk, type AckFrame } from "../../shared/protocol";
import { AckStore } from "../../server/ws/acks";

const ack = (rid: string): AckFrame => ackOk<"rename">(rid, null);

describe("AckStore", () => {
  test("the defaults are 10 minutes and 1,000 acks", () => {
    expect(WIRE.ackKeepMs).toBe(600_000);
    expect(WIRE.ackKeepMax).toBe(1_000);
  });

  test("a request is applied once; a resend gets the stored ack", async () => {
    const s = new AckStore();
    let applied = 0;
    const run = () => s.once("r1", async () => (applied++, ack("r1")));
    expect(await run()).toEqual({ ack: ack("r1"), fresh: true });
    expect(await run()).toEqual({ ack: ack("r1"), fresh: false });
    expect(applied).toBe(1);
  });

  test("a resend while the first is still running waits for the same ack", async () => {
    const s = new AckStore();
    let applied = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = s.once("r1", async () => {
      applied++;
      await gate;
      return ack("r1");
    });
    const second = s.once("r1", async () => (applied++, ack("r1")));
    release();
    expect(await first).toEqual({ ack: ack("r1"), fresh: true });
    expect(await second).toEqual({ ack: ack("r1"), fresh: false });
    expect(applied).toBe(1);
  });

  test("an ack older than the window is forgotten, so a very late resend runs again", async () => {
    let now = 0;
    const s = new AckStore({ keepMs: 1_000, now: () => now });
    await s.once("r1", async () => ack("r1"));
    now = 999;
    expect(s.get("r1")).toEqual(ack("r1"));
    now = 1_001;
    expect(s.get("r1")).toBeUndefined();
    expect((await s.once("r1", async () => ack("r1"))).fresh).toBe(true);
  });

  test("past the limit the oldest acks go first", async () => {
    const s = new AckStore({ max: 3 });
    for (const r of ["a", "b", "c", "d", "e"]) await s.once(r, async () => ack(r));
    expect(s.size).toBe(3);
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")).toBeUndefined();
    expect(s.get("e")).toEqual(ack("e"));
  });

  test("a failed apply keeps nothing; forget() drops a kept ack", async () => {
    const s = new AckStore();
    await expect(s.once("r1", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(s.get("r1")).toBeUndefined();
    await s.once("r2", async () => ack("r2"));
    s.forget("r2");
    expect(s.get("r2")).toBeUndefined();
  });
});
