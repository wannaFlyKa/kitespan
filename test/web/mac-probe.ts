// Run only by test/web/mac-keys.test.ts, with the preload test/web/as-mac.ts: it proves that the preload holds in that
// nested `bun test` run, so the key tests there check the page's Mac branch and not its Ctrl one. Its name has no
// ".test." in it, so a plain `bun test` does not pick it up (without the preload it fails, as it should).
import { expect, test } from "bun:test";
import { IS_MAC, keyLabel } from "../../web/ui/shortcuts";

test("the nested run reads macOS (the preload holds)", () => {
  expect(navigator.platform).toBe("MacIntel");
  expect(IS_MAC).toBe(true);
  expect(keyLabel("L")).toBe("Cmd+L");
});
