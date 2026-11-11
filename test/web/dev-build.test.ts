// The prototype in a React development build, the build that shows React's warnings (and the one Bun's HTML dev
// server makes): every symbol that the JSX transform links a fragment to must be defined. A module that imported
// Fragment by name and also used <> once got its <> linked to a FragmentNN that Bun never defined, and every route
// showed a blank page, while the production build was fine.
import { expect, test } from "bun:test";
import { join } from "node:path";

test("a development build defines every fragment symbol it uses", async () => {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "..", "web", "index.html")], define: { "process.env.NODE_ENV": '"development"' } });
  expect(built.success).toBe(true);
  const js = (await Promise.all(built.outputs.filter((o) => o.path.endsWith(".js")).map((o) => o.text()))).join("\n");
  const used = [...new Set(js.match(/\bFragment\d+\b/g) ?? [])];
  const undefinedSymbols = used.filter((s) => !new RegExp(`(?:var|let|const|function)\\s+${s}\\b|\\b${s}\\s*=(?!=)|\\bas\\s+${s}\\b`).test(js));
  expect(undefinedSymbols).toEqual([]);
}, 30_000);
