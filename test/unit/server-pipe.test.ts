// A closed standard output or error never ends the server (DESIGN.md 4.10): the real server (server/main.ts) as its own
// process on a free port of 127.0.0.1, with its standard output and error on one pipe whose reader has already ended
// (as a terminal that closed, or `| head -1`, leaves it), and an adapters.json that is not JSON, so that it writes to
// standard error at start too. Every line it writes then fails with EPIPE. It still answers, and SIGTERM still ends it
// with exit code 0 after its stop line. The same server keeps its built page in memory (L19): with its build folder
// emptied, the page, its script and the Terminal pane's lazy chunk still load. The fake claude is first on PATH (the
// real claude never runs).

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installFakeClaude } from "../fake-claude/install";
import { LINUX_ONLY, PROCFS } from "../linux";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const PORT = freePort();
const OWN = `http://127.0.0.1:${PORT}`;

const fake = installFakeClaude("text-thinking");
const HOME = join(fake.root, "home");
const CONFIG = join(fake.root, "config");
const DIST = join(fake.root, "dist");
const STATUS = join(fake.root, "status");
for (const d of [HOME, join(fake.root, "state"), join(CONFIG, "kitespan"), join(fake.root, "tmp"), DIST]) mkdirSync(d, { recursive: true, mode: 0o700 });
writeFileSync(join(CONFIG, "kitespan", "adapters.json"), "{ not json", { mode: 0o600 });
chmodSync(join(CONFIG, "kitespan", "adapters.json"), 0o600);
const SCRIPT = "import('/assets/chunk-a10jenkc.js');\n".repeat(40);
const CHUNK = "export const terminal = 1;\n".repeat(60);
writeFileSync(join(DIST, "index.html"), `<!doctype html><html><body><script type="module" src="/assets/index-0ba8jk69.js"></script></body></html>`);
writeFileSync(join(DIST, "index-0ba8jk69.js"), SCRIPT);
writeFileSync(join(DIST, "chunk-a10jenkc.js"), CHUNK);

const ENV: Record<string, string> = {
  PATH: `${fake.binDir}:/usr/bin:/bin`,
  HOME,
  CLAUDE_CONFIG_DIR: join(HOME, ".claude"),
  XDG_STATE_HOME: join(fake.root, "state"),
  XDG_CONFIG_HOME: CONFIG,
  TMPDIR: join(fake.root, "tmp"),
  SHELL: "/bin/sh",
};

function cmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  } catch {
    return [];
  }
}
/** This test's server: Bun running server/main.ts on this test's port (the shell around it names the same words). */
const isServer = (pid: number) => {
  const c = cmdline(pid);
  return c[0] === process.execPath && c[1] === "--no-env-file" && c[2] === MAIN && c.includes(String(PORT));
};
function serverPid(): number | null {
  for (const n of readdirSync("/proc")) if (/^\d+$/.test(n) && isServer(Number(n))) return Number(n);
  return null;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until<T>(read: () => T | null | Promise<T | null>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== null) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}
const answer = async (path: string): Promise<Response | null> => {
  try {
    return await fetch(`${OWN}${path}`, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return null;
  }
};

afterAll(() => {
  const pid = PROCFS ? serverPid() : null;
  if (pid !== null && alive(pid) && isServer(pid)) process.kill(pid, "SIGKILL");
  fake.cleanup();
});

test.skipIf(!PROCFS)(
  `with its standard output and error on a pipe that nobody reads, the server answers, then stops cleanly on SIGTERM; its emptied build folder takes nothing away ${LINUX_ONLY}`,
  async () => {
    // `true` ends at once, so the pipe has no reader before the server writes its first line. The braces' shell keeps
    // the server's exit code in a file.
    const quoted = `'${STATUS.replaceAll("'", "'\\''")}'`;
    const sh = Bun.spawn(["/bin/sh", "-c", `{ "$@"; echo $? > ${quoted}; } 2>&1 | true`, "sh", process.execPath, "--no-env-file", MAIN, "--port", String(PORT), "--dist", DIST], {
      env: ENV,
      cwd: fake.root,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const first = await until(async () => {
      const r = await answer("/");
      if (r === null && existsSync(STATUS)) throw new Error(`the server ended with ${readFileSync(STATUS, "utf8").trim()}`);
      return r;
    }, 20_000, "the server's first answer");
    expect(first.status).toBe(200);
    const pid = serverPid();
    expect(pid).not.toBe(null);
    // Its start lines (the access hint, the Claude Code line, the adapters problem) have all failed by now.
    await Bun.sleep(500);
    expect(existsSync(STATUS)).toBe(false);
    expect(alive(pid!)).toBe(true);

    for (const name of readdirSync(DIST)) unlinkSync(join(DIST, name));
    const script = await answer("/assets/index-0ba8jk69.js");
    expect(script?.status).toBe(200);
    expect(await script!.text()).toBe(SCRIPT);
    const chunk = await answer("/assets/chunk-a10jenkc.js");
    expect(chunk?.status).toBe(200);
    expect(await chunk!.text()).toBe(CHUNK);
    expect((await answer("/c/k3m7q2x4abk3m7q2x4ab"))?.status).toBe(200);

    // The stop writes "kitespan is stopping" to the same pipe, and exits 0 all the same.
    if (alive(pid!) && isServer(pid!)) process.kill(pid!, "SIGTERM");
    await until(() => (existsSync(STATUS) && readFileSync(STATUS, "utf8").trim() !== "" ? true : null), 20_000, "the server's exit");
    expect(readFileSync(STATUS, "utf8").trim()).toBe("0");
    await sh.exited;
  },
  60_000,
);
