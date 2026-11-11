// The click-through seed for v0.3 search (DESIGN.md 9.3; build checklist B6): the search scene's gate folders list
// exactly 100,000 and 20,000 paths through the git builder (an index with no files on disk), each a project with one
// chat; every scene's example folder holds the overflow rows (a 300-character path, CJK and emoji names), committed,
// so its git status is the one the other checks expect; and the gate corpus takes the page path on a laptop and the
// server path on touch (L5).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORPUS_LIMITS, fitsPage, pageLimit } from "../../shared/corpus";
import { listCorpus } from "../../server/search/build";
import { CorpusCache } from "../../server/search/cache";
import { GATE_IDS } from "../click/seed/ids";
import { SCENES, SEARCH_SCENES, sceneOf } from "../click/seed/scenes";
import { GATE, LONG_PATH, SEARCH_FILES, gatePaths, gitBinary } from "../click/seed/search";
import { writeSeed } from "../click/seed/write";

const GIT = gitBinary();
const ROOT = mkdtempSync(join(tmpdir(), "kitespan-corpus-seed-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
/** An empty scratch folder for one seed (the writer takes an existing folder). */
function fresh(name: string): string {
  const d = join(ROOT, name);
  mkdirSync(d);
  return d;
}
const ENV = { PATH: "/usr/bin:/bin", HOME: ROOT };
const ISOLATED = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

describe("the search parts of the seed", () => {
  test("the long path is 300 characters; the gate paths are distinct, safe and fixed from run to run", () => {
    expect(LONG_PATH.length).toBe(300);
    const a = gatePaths(GATE.phone.rows);
    expect(new Set(a).size).toBe(a.length);
    expect(a.slice(0, Object.keys(SEARCH_FILES).length).sort()).toEqual(Object.keys(SEARCH_FILES).sort());
    expect(gatePaths(1_000)).toEqual(a.slice(0, 1_000));
    expect(SEARCH_SCENES.some((s) => (SCENES as readonly string[]).includes(s))).toBe(false);
    expect(sceneOf("search").gate).toEqual(["big", "phone"]);
    expect(sceneOf("main").gate).toBeUndefined();
  });
});

describe.skipIf(!GIT)("the seed on disk", () => {
  const main = writeSeed(fresh("main"), "main");

  test("every scene's example folder holds the overflow rows, committed, and the main scene has no gate folders", async () => {
    const corpus = await listCorpus(main.folders.kitespan, { env: ENV, extraEnv: ISOLATED });
    expect(corpus.source).toBe("git");
    for (const rel of Object.keys(SEARCH_FILES)) expect(corpus.paths).toContain(rel);
    expect(corpus.paths).toContain("src/upload.ts");
    const status = spawnSync(GIT!, ["-C", main.folders.kitespan, "status", "--porcelain"], { env: { ...ENV, ...ISOLATED }, encoding: "utf8" }).stdout;
    expect(status.split("\n").filter(Boolean).sort()).toEqual([" M src/upload.ts", " M test/upload.test.ts", "?? docs/"]);
    expect(existsSync(main.gate.big)).toBe(false);
    expect(readdirSync(join(main.state, "chats"))).not.toContain(`${GATE_IDS.chats.big}.json`);
  });

  test(
    "the search scene: the gate folders list exactly 100,000 and 20,000 paths through git, with no file on disk",
    async () => {
      const seed = writeSeed(fresh("search"), "search");
      for (const key of ["big", "phone"] as const) {
        const got = await listCorpus(seed.gate[key], { env: ENV, extraEnv: ISOLATED });
        expect([got.source, got.paths.length, got.complete, got.capped, got.timeout, got.code]).toEqual(["git", GATE[key].rows, true, false, false, 0]);
        expect(got.paths).toContain(LONG_PATH);
        expect(readdirSync(seed.gate[key])).toEqual([".git"]);
      }
      const projects = (JSON.parse(readFileSync(join(seed.state, "projects.json"), "utf8")) as { projects: { id: string; cwd: string }[] }).projects;
      expect(projects.filter((p) => p.cwd === seed.gate.big || p.cwd === seed.gate.phone).map((p) => p.id)).toEqual([GATE_IDS.projects.big, GATE_IDS.projects.phone]);
      for (const key of ["big", "phone"] as const) {
        const ledger = JSON.parse(readFileSync(join(seed.state, "chats", `${GATE_IDS.chats[key]}.json`), "utf8")) as { cwd: string; project: string; title: { text: string } };
        expect([ledger.cwd, ledger.project, ledger.title.text]).toEqual([seed.gate[key], GATE_IDS.projects[key], GATE[key].title]);
      }

      // One more than the cap: the builder stops at 100,000 and says so.
      const over = await listCorpus(seed.gate.phone, { env: ENV, extraEnv: ISOLATED, max: GATE.phone.rows - 1 });
      expect([over.paths.length, over.capped, over.complete]).toEqual([GATE.phone.rows - 1, true, false]);

      // The 100,000-row corpus fits the laptop's page path (under 16 MiB of JSON) and takes the server path on touch.
      const cache = new CorpusCache({ list: (root) => listCorpus(root, { env: ENV, extraEnv: ISOLATED }), timer: false });
      const build = await cache.read(seed.gate.big, GATE_IDS.chats.big);
      const { jsonBytes } = await build.listBody();
      expect(jsonBytes).toBeLessThan(CORPUS_LIMITS.jsonBytes);
      expect(fitsPage({ total: build.total, chars: build.chars, jsonBytes }, pageLimit(false))).toBe(true);
      expect(fitsPage({ total: build.total, chars: build.chars, jsonBytes }, pageLimit(true))).toBe(false);
      const phone = await cache.read(seed.gate.phone, GATE_IDS.chats.phone);
      expect(fitsPage({ total: phone.total, chars: phone.chars, jsonBytes: (await phone.listBody()).jsonBytes }, pageLimit(true))).toBe(true);
      const r = (await cache.search(seed.gate.big, GATE_IDS.chats.big, "upload comp"))!;
      expect(r.total).toBe(100_000);
      expect(r.rows.length).toBeLessThanOrEqual(120);
      cache.close();
    },
    30_000,
  );
});
