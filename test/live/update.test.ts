// The opt-in live update test (owner row 108; DESIGN.md 4.10). No model turn: a real bin/kitespan in a scratch clone of
// this checkout's HEAD whose origin is another scratch clone with one new commit (made with git commit there; nothing
// is ever pushed), a commit that changes the page's script so the build's hashed names change. Without KITESPAN_LIVE=1
// it is one skipped test. In order:
//
// 1. Update available: welcome.update says so (or the update notice brings it) with the Update action.
// 2. The Update button's request (POST /api/update, 202), and the step line on two pages: each gets the update notices
//    "Updating kitespan: step N of 3, ...", and GET /api/update shows the job's step.
// 3. Restart to apply: the job is done, the build on disk is origin's commit's, the running server still serves the
//    build it started with (/assets/build.json), and the last notice is "Restart to apply the update.".
// 4. Restart now: the successor serves the new HEAD's build, whose page names other scripts, and About's build line is
//    none.
// 5. The refusal: with a local change in the clone, Update gets its one line, "This checkout has local changes.", and
//    nothing changes.
//
// git and Bun in the clones run with no system or global git config of the user's, and so does the clone's server for
// its own git. At the end the server, its successor and the clones' folder are gone.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanStartEnv, headOf, hello, LiveServer, liveSuite, makeTemp, type Page, removeTemp, ROOT, userEnv } from "./live";

const BRANCH = "kitespan-live-update";
const ISOLATED = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const STEP = /^Updating kitespan: step [1-3] of 3, (fetch|install|build)\.$/;

/** git and Bun in the clones: the start script's clean environment, no GIT_ name of the user's, no system or global config. */
const cloneEnv = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(cleanStartEnv(userEnv())).filter(([k]) => !k.startsWith("GIT_"))),
  ...ISOLATED,
});

type Prep = { state: "ready"; tmp: string; app: string; dist: string; head: string; next: string } | { state: "skip" | "error"; tmp: string | null; why: string };

/** The clones and app's locked install and build, made when the file loads (a failed install skips the file's steps). */
function prepare(): Prep {
  let tmp: string | null = null;
  const run = (cmd: string[], cwd: string, ms: number) => Bun.spawnSync(cmd, { cwd, env: cloneEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: ms, killSignal: "SIGKILL" });
  const git = (cwd: string, args: string[]): string => {
    const r = run(["git", "-c", "core.hooksPath=/dev/null", ...args], cwd, 120_000);
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed (exit ${r.exitCode})`);
    return r.stdout.toString().trim();
  };
  try {
    tmp = makeTemp("update");
    const head = headOf(ROOT);
    if (!head) return { state: "error", tmp, why: "this checkout has no HEAD to clone" };
    const app = join(tmp, "app");
    const origin = join(tmp, "origin");
    for (const dir of [origin, app]) {
      git(tmp, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", ROOT, dir]);
      git(dir, ["checkout", "--quiet", "-b", BRANCH, head]);
    }
    const main = join(origin, "web", "main.tsx");
    writeFileSync(main, `${readFileSync(main, "utf8")}document.documentElement.dataset.update = "live";\n`);
    const who = ["-c", "user.name=kitespan live test", "-c", "user.email=kitespan-live@example.invalid", "-c", "commit.gpgsign=false"];
    git(origin, ["add", "web/main.tsx"]);
    git(origin, [...who, "commit", "--quiet", "--no-verify", "-m", "A new page for the live update test"]);
    const next = git(origin, ["rev-parse", "HEAD"]);
    git(app, ["remote", "set-url", "origin", origin]);
    git(app, ["config", `branch.${BRANCH}.remote`, "origin"]);
    git(app, ["config", `branch.${BRANCH}.merge`, `refs/heads/${BRANCH}`]);
    const install = run([process.execPath, "install", "--frozen-lockfile", "--omit=optional"], app, 300_000);
    if (install.exitCode !== 0) {
      const why = `bun install --frozen-lockfile --omit=optional failed in the scratch clone (exit ${install.exitCode})`;
      if (/lockfile/i.test(install.stderr.toString())) return { state: "error", tmp, why };
      return { state: "skip", tmp, why: `${why}; most likely Bun's install cache lacks a package and there is no network to fetch it` };
    }
    const build = run([process.execPath, "run", "build"], app, 300_000);
    if (build.exitCode !== 0) return { state: "error", tmp, why: `the clone's build failed (exit ${build.exitCode})` };
    return { state: "ready", tmp, app, dist: join(app, "dist", "web"), head, next };
  } catch (e) {
    return { state: "error", tmp, why: e instanceof Error ? e.message : String(e) };
  }
}

/** The commit of the build that the server serves from memory. */
async function servedHead(s: LiveServer): Promise<string | null> {
  const r = await s.get("/assets/build.json");
  if (!r.ok) return null;
  const head = ((await r.json()) as { head?: unknown }).head;
  return typeof head === "string" ? head : null;
}

/** The module scripts that the server's page names. */
async function scripts(s: LiveServer): Promise<string[]> {
  return [...(await (await s.get("/")).text()).matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]!).sort();
}

const updateNotices = (P: Page) => P.frames.filter((f) => f.t === "notice" && f.id === "update").map((f) => String(f.text));

liveSuite("test/live/update.test.ts", {}, (env) => {
  if (env.port === 7940) {
    test("test/live/update.test.ts: the live environment", () => {
      throw new Error("KITESPAN_LIVE_PORT is 7940, the demo run's port: this test restarts its server, so give a test port from 7941 to 7949");
    });
    return;
  }
  const prep = prepare();
  let server: LiveServer | null = null;
  const pages: Page[] = [];
  afterAll(async () => {
    for (const p of pages) p.close();
    if (server) await server.stop();
    if (prep.tmp) removeTemp(prep.tmp);
  }, 120_000);

  describe("the live update test (row 108)", () => {
    test.skipIf(prep.state === "skip")(
      prep.state === "skip" ? `skipped: ${prep.why}` : "Update available; Update and the step line on two pages; Restart to apply; Restart now and the successor serves the new HEAD; the refusal of a local change",
      async () => {
        if (prep.state !== "ready") throw new Error(`the scratch clones: ${prep.why}`);
        server = await LiveServer.boot(env, { root: prep.tmp, checkout: { root: prep.app, dist: prep.dist }, env: ISOLATED });
        const s = server;
        const a = await hello(s, "update-a");
        const b = await hello(s, "update-b");
        pages.push(a.page, b.page);
        const epoch0 = a.welcome.epoch as string;
        // 1. The check at start (Daily, never checked) runs in the background: the welcome has it, or the notice.
        if (a.welcome.update?.kind !== "available") {
          const n = await a.page.waitFor((f) => f.t === "notice" && f.id === "update", 30_000, 0, "the Update available notice");
          expect(n, "the Update available notice").toMatchObject({ text: "Update available.", actions: ["update"] });
        }
        expect(await (await s.get("/api/update")).json()).toMatchObject({ update: "available", build: "none", job: { state: "idle" }, can: true });
        const scripts0 = await scripts(s);

        // 2. The Update button's request; the step line on both pages.
        const r = await s.post("/api/update", {});
        expect({ status: r.status, body: await r.json() }, "Update was not taken").toEqual({ status: 202, body: { job: { state: "running", step: "fetch" } } });
        await a.page.waitFor((f) => f.t === "notice" && f.id === "update" && f.text === "Restart to apply the update.", 600_000, 0, "Restart to apply");
        await b.page.waitFor((f) => f.t === "notice" && f.id === "update" && f.text === "Restart to apply the update.", 10_000, 0, "Restart to apply on the second page");
        for (const P of [a.page, b.page]) {
          const lines = updateNotices(P);
          expect(lines.filter((l) => STEP.test(l)).length, `a page's update notices: ${lines.join(" | ")}`).toBeGreaterThan(0);
        }

        // 3. Restart to apply; the running server still serves its own build.
        expect(await (await s.get("/api/update")).json()).toMatchObject({ update: "none", build: "apply", job: { state: "done" } });
        expect(headOf(prep.app), "the update did not fast-forward to origin's commit").toBe(prep.next);
        expect(JSON.parse(readFileSync(join(prep.dist, "build.json"), "utf8")).head, "the build on disk is not origin's commit's").toBe(prep.next);
        expect(await servedHead(s), "the running server does not serve the build it started with").toBe(prep.head);

        // 4. Restart now: the successor serves the new HEAD's build.
        const rr = await s.restart("now");
        expect({ status: rr.status, body: await rr.json().catch(() => null) }).toEqual({ status: 202, body: { when: "now" } });
        await s.successor(epoch0);
        expect(await servedHead(s), "the successor does not serve the new HEAD's build").toBe(prep.next);
        expect(await scripts(s), "the successor's page names the same scripts").not.toEqual(scripts0);
        expect(await (await s.get("/api/update")).json()).toMatchObject({ build: "none", job: { state: "idle" } });

        // 5. A local change: Update gets its one line, and nothing changes.
        writeFileSync(join(prep.app, "README.md"), `${readFileSync(join(prep.app, "README.md"), "utf8")}\nA local change.\n`);
        const no = await s.post("/api/update", {});
        expect({ status: no.status, body: await no.json() }).toEqual({ status: 409, body: { error: { code: "update_refused", message: "This checkout has local changes." } } });
        expect(headOf(prep.app)).toBe(prep.next);
        expect(await (await s.get("/api/update")).json()).toMatchObject({ job: { state: "idle" } });
      },
      900_000,
    );
  });
});
