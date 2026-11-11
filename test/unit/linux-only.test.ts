// The Linux-only tests (test/linux.ts) skip only where /proc cannot be read: on Linux, CI's check job and every
// local run on Linux, they always run.
import { expect, test } from "bun:test";
import { PROCFS } from "../linux";

test.if(process.platform === "linux")("on Linux, /proc can be read, so no Linux-only test skips", () => {
  expect(PROCFS).toBe(true);
});
