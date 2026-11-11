// The page's key words on macOS, checked on every system: the tests that draw a key's words or check a key run again
// in a Bun of their own whose navigator.platform is macOS's (test/web/as-mac.ts), so their Cmd branch runs on Linux too
// (CI's macos job runs them as they are). The runs use no port and start no server.
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
// The probe (test/web/mac-probe.ts) goes last: it fails unless the page's module still reads macOS in that same run, so a
// preload that stops taking hold (a DOM setup that replaces navigator, say) cannot leave the run green on the Ctrl words.
const FILES = [...["browser-pane", "search-model", "send-now", "split-shell"].map((n) => `./test/web/${n}.test.ts`), "./test/web/mac-probe.ts"];

describe("the page's Mac words and keys (navigator.platform MacIntel)", () => {
  test("the page reads macOS from the preload", () => {
    const r = Bun.spawnSync([process.execPath, "--preload", join(ROOT, "test", "web", "as-mac.ts"), "-e", 'const m = await import("./web/ui/shortcuts.ts"); console.log(m.IS_MAC)'], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.stdout.toString().trim()).toBe("true");
  });

  test("the key tests pass with macOS's words", () => {
    const r = Bun.spawnSync([process.execPath, "test", "--preload", "./test/web/as-mac.ts", ...FILES], { cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    const out = r.stdout.toString() + r.stderr.toString();
    expect(out).not.toContain("(fail)");
    expect(r.exitCode).toBe(0);
    expect(out).toMatch(/\n\s*0 fail/);
    expect(out).toContain(`across ${FILES.length} files`);
  }, 130_000);
});
