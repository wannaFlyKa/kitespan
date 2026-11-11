// A running server keeps its own page through an update (owner row 108; DESIGN.md 4.10; L19): the server reads its
// page and every built file once, at its start (server/http/static.ts), and the Update button's build goes into a
// folder beside the build folder, which takes the folder's place only when it finished (server/update/steps.ts). In a
// scratch checkout whose origin has a commit that changes the build's hashed names: while and after the update, the
// running server's page and each of its files answer byte for byte as before and the new build's file is not served;
// a build that fails leaves the build folder whole, so a fresh start (the restart's successor, or a reboot) still has a
// page; after one that finished, a fresh start serves the new page and its new file.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSite, type Site } from "../../server/http/static";
import { gitOptions } from "../../server/update/git";
import { gitCheckoutSource } from "../../server/update/source";

const GIT = ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g)) ?? null;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-update-serving-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const HOME = join(ROOT, "home");
mkdirSync(HOME);
const ISOLATED = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const ENV = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME, ...ISOLATED };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(GIT!, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A build like scripts/build-web.ts's: it empties its folder, then writes the page, which names a script whose hashed
 * name comes from page.txt (a commit that changes page.txt changes the name), the script, and the stamp. With FAIL in
 * page.txt it fails after the emptying.
 */
const BUILD = `const out = process.argv[process.argv.indexOf("--out") + 1];
const fs = await import("node:fs");
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) fs.unlinkSync(out + "/" + f);
const words = fs.readFileSync("page.txt", "utf8");
if (words.includes("FAIL")) process.exit(1);
const hash = new Bun.CryptoHasher("sha256").update(words).digest("hex").slice(0, 8);
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
fs.writeFileSync(out + "/index.html", '<script type="module" src="/assets/chunk-' + hash + '.js"></script>');
fs.writeFileSync(out + "/chunk-" + hash + ".js", "document.title = " + JSON.stringify(words) + ";");
fs.writeFileSync(out + "/build.json", JSON.stringify({ v: 1, head }) + "\\n");
`;

let n = 0;
/** A checkout built at its first commit, whose origin has a second commit with new page words. */
function setup(next: string) {
  const id = ++n;
  const bare = join(ROOT, `origin-${id}.git`);
  git(ROOT, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(ROOT, `seed-${id}`);
  git(ROOT, "clone", "-q", bare, seed);
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "scratch", private: true, scripts: { build: "bun build.ts" } }));
  writeFileSync(join(seed, "build.ts"), BUILD);
  writeFileSync(join(seed, "page.txt"), "the first page");
  writeFileSync(join(seed, ".gitignore"), "node_modules/\ndist/\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "one");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const app = join(ROOT, `app-${id}`);
  git(ROOT, "clone", "-q", bare, app);
  const dist = join(app, "dist", "web");
  const b = spawnSync(process.execPath, ["run", "build", "--out", dist], { cwd: app, env: ENV, encoding: "utf8" });
  if (b.status !== 0) throw new Error(`the first build failed: ${b.stderr}`);
  writeFileSync(join(seed, "page.txt"), next);
  git(seed, "add", "page.txt");
  git(seed, "commit", "-q", "-m", "two");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { app, dist, head: git(seed, "rev-parse", "HEAD") };
}

const chunkOf = (page: string) => /chunk-[0-9a-f]{8}\.js/.exec(page)![0];
const req = (path: string) => new Request(`http://127.0.0.1:7942${path}`);

/** What a page of this server gets: the page and each file of the build it read at start. */
async function served(site: Site, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = { "index.html": await site.shell(req("/settings/about")).text() };
  for (const name of names) {
    const res = site.asset(req(`/assets/${name}`), name);
    out[name] = res ? `${res.status} ${await res.text()}` : "not served";
  }
  return out;
}

const update = (app: string, dist: string) =>
  gitCheckoutSource({ root: app, dist, dev: false, git: gitOptions({ PATH: "/usr/bin:/bin", HOME, ...ISOLATED }), env: ENV, bun: process.execPath }).apply({ onStep: () => {}, output: { line: () => {} } });

describe.skipIf(!GIT)("the running server's page through an update (row 108)", () => {
  test("a finished update: the running server serves its own page and files byte for byte, never the new build's; a fresh start serves the new one", async () => {
    const s = setup("the second page");
    const names = readdirSync(s.dist).filter((f) => f !== "index.html").sort();
    const site = loadSite(s.dist, []);
    const before = await served(site, names);
    const oldChunk = chunkOf(before["index.html"]!);
    expect(before[oldChunk]).toStartWith("200 ");
    expect((await update(s.app, s.dist)).ok).toBe(true);
    // On disk: the new build, whole, with a new hashed name.
    const page = readFileSync(join(s.dist, "index.html"), "utf8");
    const newChunk = chunkOf(page);
    expect(newChunk).not.toBe(oldChunk);
    expect(existsSync(join(s.dist, oldChunk))).toBe(false);
    // The running server: as before, and the new name is not its.
    expect(await served(site, names)).toEqual(before);
    expect(site.asset(req(`/assets/${newChunk}`), newChunk)).toBeNull();
    // The successor reads the new build at its start.
    const next = loadSite(s.dist, []);
    expect(await next.shell(req("/")).text()).toBe(page);
    expect(await next.asset(req(`/assets/${newChunk}`), newChunk)!.text()).toContain("the second page");
    expect(JSON.parse(await next.asset(req("/assets/build.json"), "build.json")!.text()).head).toBe(s.head);
  }, 60_000);

  test("a build that fails: the running server is as it was, and the build folder stays whole for a fresh start", async () => {
    const s = setup("FAIL");
    const names = readdirSync(s.dist).filter((f) => f !== "index.html").sort();
    const onDisk = Object.fromEntries(readdirSync(s.dist).map((f) => [f, readFileSync(join(s.dist, f), "utf8")]));
    const site = loadSite(s.dist, []);
    const before = await served(site, names);
    expect(await update(s.app, s.dist)).toEqual({ ok: false, step: "build" });
    expect(await served(site, names)).toEqual(before);
    expect(Object.fromEntries(readdirSync(s.dist).map((f) => [f, readFileSync(join(s.dist, f), "utf8")]))).toEqual(onDisk);
    expect(existsSync(`${s.dist}.next`)).toBe(false);
    const fresh = loadSite(s.dist, []);
    expect(fresh.built).toBe(true);
    expect(await fresh.shell(req("/")).text()).toBe(before["index.html"]!);
  }, 60_000);
});
