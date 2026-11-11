// readInto (read-into.ts): a line that comes after a pause longer than the old loop's 500 ms sleep is still seen.

import { describe, expect, test } from "bun:test";
import { readInto } from "./read-into";

describe("readInto", () => {
  test("a first line after 0.8 s, then more: every byte arrives, and until() sees it", async () => {
    const proc = Bun.spawn(["/bin/sh", "-c", "sleep 0.8; echo first; sleep 0.3; echo second"], { stdout: "pipe", stderr: "ignore" });
    let out = "";
    const r = readInto(proc.stdout as ReadableStream<Uint8Array>, (s) => (out += s));
    expect(await r.until(() => out.includes("first"), 5_000)).toBe(true);
    await r.ended;
    expect(out).toBe("first\nsecond\n");
  });

  test("the old race loses that first line (why the helper exists)", async () => {
    const proc = Bun.spawn(["/bin/sh", "-c", "sleep 0.8; echo first; sleep 2"], { stdout: "pipe", stderr: "ignore" });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let out = "";
    const deadline = Date.now() + 2_000;
    while (!out.includes("first") && Date.now() < deadline) {
      const r = await Promise.race([reader.read(), Bun.sleep(500).then(() => null)]);
      if (r && !r.done) out += new TextDecoder().decode(r.value);
      if (r?.done) break;
    }
    expect(out).toBe("");
    proc.kill();
    await proc.exited;
  });

  test("a stream that ends before the condition: until() returns false at once", async () => {
    const proc = Bun.spawn(["/bin/sh", "-c", "echo only"], { stdout: "pipe", stderr: "ignore" });
    let out = "";
    const r = readInto(proc.stdout as ReadableStream<Uint8Array>, (s) => (out += s));
    const t0 = Date.now();
    expect(await r.until(() => out.includes("never"), 5_000)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(out).toBe("only\n");
  });
});
