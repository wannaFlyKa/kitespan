// The click-through harness's own parts that the reconnect and restart flows need (scripts/ui-check.ts resume-slow
// and restart): an origin to allow beside the server's own (the slow-network proxy's, through the access adapter's
// adapters.json, DESIGN.md 4.8), and stop() ending a restart's successor (bin/kitespan with this boot's options and
// --bind-wait, which runs in the repository root, so only its command line names it), and names added to the server's
// environment (ui-check --server-env: a dead HTTP proxy for the restart flow), never one the seed sets. Part 2's flows
// need two more: restart() (a SIGTERM and a new start on the same seed, so every chat sleeps before its next start) and
// the seed's own data folder (XDG_DATA_HOME), where kitespan's worktree records go. A stub page stands in for the built
// one; the successor is a stand-in process with a successor's command line, ended by its pid.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINUX_ONLY, PROCFS } from "../linux";
import { boot, pickTestPort, ROOT, type Booted } from "./harness";

const PORT = pickTestPort(7942);
const DIST = mkdtempSync(join(tmpdir(), "kitespan-click-stub-"));
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>stub page</body></html>");
const strays: number[] = [];
afterAll(() => {
  for (const pid of strays) {
    try {
      if (readCmd(pid).includes(DIST)) process.kill(pid, "SIGKILL");
    } catch {}
  }
  rmSync(DIST, { recursive: true, force: true });
});

function readCmd(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return "";
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.skipIf(!PROCFS)(`an origin to allow: a page and a socket from it pass the Host and Origin guards ${LINUX_ONLY}`, async () => {
  const other = "http://127.0.0.1:61234";
  const h = await boot({ scene: "archived", port: PORT, dist: DIST, origins: [other] });
  try {
    const page = await fetch(`${h.base}/`, { headers: { host: "127.0.0.1:61234" } });
    expect(page.status).toBe(200);
    const refused = await fetch(`${h.base}/`, { headers: { host: "127.0.0.1:61235" } });
    expect(refused.status).not.toBe(200);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: other, host: "127.0.0.1:61234" } });
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 5000);
    });
    ws.close();
    expect(opened).toBe(true);
  } finally {
    await h.stop();
  }
}, 30_000);

test.skipIf(!PROCFS)(`stop() ends a restart's successor of this boot, by its pid ${LINUX_ONLY}`, async () => {
  const h = await boot({ scene: "archived", port: PORT, dist: DIST });
  const keep = ["-e", "setInterval(() => {}, 1 << 30)", join(ROOT, "server", "main.ts")];
  const spawn = (port: number) => {
    const p = Bun.spawn([process.execPath, ...keep, "--port", String(port), "--dist", DIST, "--bind-wait", "10"], { cwd: ROOT, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    strays.push(p.pid);
    return p;
  };
  try {
    // What a restart leaves: bin/kitespan's server with this boot's port and page and the port wait, in the repository
    // root. Another port's is never this boot's.
    const successor = spawn(PORT);
    const otherPort = spawn(7949);
    await Bun.sleep(200);
    expect(h.successors()).toEqual([successor.pid]);
    const r = await h.stop();
    expect(r.successors).toEqual([successor.pid]);
    expect(alive(successor.pid)).toBe(false);
    expect(alive(otherPort.pid)).toBe(true);
    otherPort.kill("SIGKILL");
    await otherPort.exited;
  } finally {
    await h.stop();
  }
}, 40_000);

test.skipIf(!PROCFS)(`crash() ends the server with SIGKILL and starts it again on the same seed and port, with no warm-up ${LINUX_ONLY}`, async () => {
  const h = await boot({ scene: "archived", port: PORT, dist: DIST, fixture: { finishTurnOnStdinEnd: true } });
  try {
    // The fixture option reaches the fake claude's fixture file.
    expect(JSON.parse(readFileSync(h.fake.fixturePath, "utf8")).finishTurnOnStdinEnd).toBe(true);
    const epoch = async () => ((await (await fetch(`${h.base}/api/health`)).json()) as { epoch: string }).epoch;
    const before = { pid: h.pid, epoch: await epoch() };
    const r = await h.crash();
    expect(r.bootMs).toBeGreaterThan(0);
    expect(alive(before.pid)).toBe(false);
    expect(h.pid).not.toBe(before.pid);
    expect(alive(h.pid)).toBe(true);
    expect(readCmd(h.pid)).toContain(join(ROOT, "server", "main.ts"));
    // A new server, on the same state folder: the same chat list.
    expect(await epoch()).not.toBe(before.epoch);
    expect(h.output().out).toContain(`kitespan listens on ${h.base}`);
    const s = await h.stop();
    expect(s.code).toBe(0);
    expect(alive(h.pid)).toBe(false);
  } finally {
    await h.stop();
  }
}, 40_000);

test.skipIf(!PROCFS)(`restart() stops the server with SIGTERM (exit 0) and starts it again on the same seed and port ${LINUX_ONLY}`, async () => {
  const h = await boot({ scene: "archived", port: PORT, dist: DIST });
  try {
    const epoch = async () => ((await (await fetch(`${h.base}/api/health`)).json()) as { epoch: string }).epoch;
    const before = { pid: h.pid, epoch: await epoch() };
    const r = await h.restart();
    expect(r.code).toBe(0);
    expect(r.bootMs).toBeGreaterThan(0);
    expect(alive(before.pid)).toBe(false);
    expect(h.pid).not.toBe(before.pid);
    expect(readCmd(h.pid)).toContain(join(ROOT, "server", "main.ts"));
    expect(await epoch()).not.toBe(before.epoch);
    const s = await h.stop();
    expect(s.code).toBe(0);
    expect(alive(h.pid)).toBe(false);
  } finally {
    await h.stop();
  }
}, 40_000);

test.skipIf(!PROCFS)(`the server's data folder (XDG_DATA_HOME, where the worktree records go) is the seed's own ${LINUX_ONLY}`, async () => {
  const h = await boot({ scene: "archived", port: PORT, dist: DIST });
  try {
    const env = readFileSync(`/proc/${h.pid}/environ`, "utf8").split("\0").filter(Boolean);
    expect(env).toContain(`XDG_DATA_HOME=${h.seed.data}`);
    expect(h.seed.data.startsWith(`${h.seed.root}/`)).toBe(true);
  } finally {
    await h.stop();
  }
  const refused = await boot({ scene: "archived", port: PORT, dist: DIST, env: { XDG_DATA_HOME: "/tmp" } }).then(
    async (b) => {
      await b.stop();
      return "booted";
    },
    (e: Error) => e.message,
  );
  expect(refused).toContain("XDG_DATA_HOME");
}, 40_000);

test.skipIf(!PROCFS)(`env: names added to the server's environment (a dead HTTP proxy) reach the server; a name of the seed's own is refused ${LINUX_ONLY}`, async () => {
  // A refused boot starts nothing; one that starts anyway is stopped here, by its own handle, before the test fails.
  const refused = async (env: Record<string, string>): Promise<string> => {
    let h: Booted;
    try {
      h = await boot({ scene: "archived", port: PORT, dist: DIST, env });
    } catch (e) {
      return (e as Error).message;
    }
    await h.stop();
    return "booted";
  };
  expect(await refused({ PATH: "/nowhere" })).toContain("PATH");
  expect(await refused({ "NOT A NAME": "x" })).toContain("NOT A NAME");
  const proxy = "http://127.0.0.1:9";
  const h = await boot({ scene: "archived", port: PORT, dist: DIST, env: { HTTP_PROXY: proxy, http_proxy: proxy } });
  try {
    // The server's own environment, by name (never a value printed).
    const env = readFileSync(`/proc/${h.pid}/environ`, "utf8").split("\0").filter(Boolean);
    expect(env).toContain(`HTTP_PROXY=${proxy}`);
    expect(env).toContain(`http_proxy=${proxy}`);
    expect(env.some((kv) => kv === "PATH=/nowhere")).toBe(false);
  } finally {
    await h.stop();
  }
}, 40_000);
