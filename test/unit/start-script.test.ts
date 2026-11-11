// bin/kitespan, the clean start (DESIGN.md 4.7 and 4.8), run against a fake `bun` that records its arguments and the
// names of its variables (never their values, except one made-up test variable). No server starts.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLEAN_ENV } from "../../server/agents/types";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "bin", "kitespan");
const MAIN = join(ROOT, "server", "main.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const FAKE_BUN = `#!/bin/sh
printf '%s\\n' "$@" > "$OUT_DIR/args"
awk 'BEGIN { for (k in ENVIRON) print k }' | sort > "$OUT_DIR/names"
printf '%s' "\${KITESPAN_TEST_VALUE-}" > "$OUT_DIR/value"
printf '%s' "$PATH" > "$OUT_DIR/path"
`;

interface Run {
  code: number;
  stderr: string;
  ran: boolean;
  args: string[];
  names: string[];
  value: string;
  path: string;
  dir: string;
}

function setup(): { dir: string; bin: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), "kitespan-start-"));
  scratch.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), FAKE_BUN, { mode: 0o755 });
  mkdirSync(join(dir, "home"));
  const config = join(dir, "config");
  mkdirSync(join(config, "kitespan"), { recursive: true });
  return { dir, bin, config };
}

function run(
  args: string[],
  env: Record<string, string> = {},
  opts: { startEnv?: string; startEnvMode?: number; path?: (bin: string, dir: string) => string; prepare?: (dir: string) => void } = {},
): Run {
  const { dir, bin, config } = setup();
  if (opts.startEnv !== undefined) {
    const f = join(config, "kitespan", "start-env");
    writeFileSync(f, opts.startEnv, { mode: 0o600 });
    if (opts.startEnvMode !== undefined) chmodSync(f, opts.startEnvMode);
  }
  opts.prepare?.(dir);
  const base = { PATH: opts.path ? opts.path(bin, dir) : `${bin}:/usr/bin:/bin`, HOME: join(dir, "home"), XDG_CONFIG_HOME: config, OUT_DIR: dir };
  const r = Bun.spawnSync(["sh", SCRIPT, ...args], { cwd: dir, env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
  const read = (n: string) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), "utf8") : "");
  const ran = existsSync(join(dir, "args"));
  return {
    code: r.exitCode ?? -1,
    stderr: r.stderr.toString(),
    ran,
    args: read("args").split("\n").filter(Boolean),
    names: read("names").split("\n").filter(Boolean),
    value: read("value"),
    path: read("path"),
    dir,
  };
}

describe("the command line", () => {
  test("bun runs the server from the repository root with --no-env-file, and the server's options follow", () => {
    const r = run(["--port", "7941"]);
    expect(r.code).toBe(0);
    expect(r.args).toEqual([`--cwd=${ROOT}`, "--no-env-file", MAIN, "--port", "7941"]);
  });
  test("a relative --dist is the caller's folder's, made absolute before Bun runs in the repository root", () => {
    const r = run(["--dist", "build/web", "--port", "7941", "--dist", "/abs/web"]);
    expect(r.args).toEqual([`--cwd=${ROOT}`, "--no-env-file", MAIN, "--dist", `${realpathSync(r.dir)}/build/web`, "--port", "7941", "--dist", "/abs/web"]);
  });
  test("dev adds hot reload from the repository root", () => {
    const r = run(["dev", "--port", "7942"]);
    expect(r.args).toEqual([`--cwd=${ROOT}`, "--hot", "--no-env-file", MAIN, "--dev", "--port", "7942"]);
  });
  test("an unknown command does not start", () => {
    const r = run(["bogus"]);
    expect(r.code).toBe(1);
    expect(r.ran).toBe(false);
    expect(r.stderr).toContain("unknown command");
  });
  test("with no bun on PATH it says so", () => {
    const r = run([], {}, { path: () => "/usr/bin:/bin" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("bun is not on PATH");
  });
  test("an argument with spaces and quotes reaches the server whole", () => {
    expect(run(["--note", "a b 'c' $(d)"]).args.slice(3)).toEqual(["--note", "a b 'c' $(d)"]);
  });
});

// The folder the command is typed in is never Bun's: a bunfig.toml there (a preload, for one) would run inside the
// server. The real Bun runs the server's --check (it binds nothing and writes nothing), from a folder whose bunfig.toml
// preloads a file that leaves a mark.
describe("the caller's folder", () => {
  function caller() {
    const { dir, config } = setup();
    const folder = join(dir, "caller");
    mkdirSync(folder);
    const mark = join(dir, "preload-ran");
    writeFileSync(join(folder, "bunfig.toml"), 'preload = ["./mark.ts"]\n');
    writeFileSync(join(folder, "mark.ts"), `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\n`);
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "<!doctype html><html><body>kitespan page</body></html>");
    const env = { PATH: `${resolve(process.execPath, "..")}:/usr/bin:/bin`, HOME: join(dir, "home"), XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(dir, "state") };
    return { dir, folder, mark, dist, env };
  }
  test("the control: Bun run plainly in that folder runs the preload", () => {
    const c = caller();
    writeFileSync(join(c.dir, "noop.ts"), "\n");
    expect(Bun.spawnSync([process.execPath, "--no-env-file", join(c.dir, "noop.ts")], { cwd: c.folder, env: c.env }).exitCode).toBe(0);
    expect(existsSync(c.mark)).toBe(true);
  });
  for (const word of [[], ["dev"]])
    test(`${word.length ? "bin/kitespan dev" : "bin/kitespan"}: the caller's bunfig.toml never runs`, () => {
      const c = caller();
      const r = Bun.spawnSync(["sh", SCRIPT, ...word, "--check", "--dist", c.dist], { cwd: c.folder, env: c.env, stdout: "pipe", stderr: "pipe" });
      expect(r.stderr.toString()).toBe("");
      expect(r.exitCode).toBe(0);
      expect(existsSync(c.mark)).toBe(false);
    }, 30_000);
});

describe("the removal list (4.7)", () => {
  test("a Claude Code session's variables never reach Bun, and the user's own do", () => {
    const planted: Record<string, string> = { KEEP_ME: "1", CLAUDE_CODE_MESSAGING_A: "1", CLAUDE_CODE_MESSAGING_B: "1", TRACEPARENT: "t", TRACESTATE: "s" };
    for (const n of CLEAN_ENV.always) planted[n] = "1";
    const r = run([], planted);
    expect(r.code).toBe(0);
    for (const n of [...CLEAN_ENV.always, "CLAUDE_CODE_MESSAGING_A", "CLAUDE_CODE_MESSAGING_B", "TRACEPARENT", "TRACESTATE"]) expect(r.names).not.toContain(n);
    expect(r.names).toContain("KEEP_ME");
  });
  test("the trace context stays when no Claude Code session started the script", () => {
    const r = run([], { TRACEPARENT: "t", TRACESTATE: "s" });
    expect(r.names).toContain("TRACEPARENT");
    expect(r.names).toContain("TRACESTATE");
  });
  for (const marker of CLEAN_ENV.desktopMarkers)
    test(`a Desktop host's variables go when ${marker} marks it`, () => {
      const planted: Record<string, string> = { [marker]: "1", KEEP_ME: "1" };
      for (const n of CLEAN_ENV.desktop) planted[n] = "x";
      const r = run([], planted);
      for (const n of CLEAN_ENV.desktop) expect(r.names).not.toContain(n);
      expect(r.names).toContain("KEEP_ME");
    });
  test("without a Desktop marker, the user's own provider settings stay", () => {
    const r = run([], { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "x", ANTHROPIC_BASE_URL: "x", AWS_PROFILE: "x" });
    for (const n of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_BASE_URL", "AWS_PROFILE"]) expect(r.names).toContain(n);
  });
  const runner = { npm_lifecycle_event: "start", npm_lifecycle_script: "bin/kitespan", npm_package_name: "kitespan", npm_package_version: "0", npm_config_user_agent: "bun", npm_execpath: "/x", npm_node_execpath: "/x", npm_command: "run-script", npm_config_local_prefix: "/x", npm_package_json: "/x", NODE: "/x", npm_config_registry: "kept" };
  test("a package runner's additions go: its variables and its node_modules/.bin entries at the front of PATH", () => {
    const r = run([], runner, { path: (bin) => `${ROOT}/node_modules/.bin:/srv/node_modules/.bin:${bin}:/opt/node_modules/.bin:/usr/bin:/bin` });
    expect(r.code).toBe(0);
    for (const n of Object.keys(runner).filter((n) => n !== "npm_config_registry")) expect(r.names).not.toContain(n);
    expect(r.names).toContain("npm_config_registry");
    expect(r.path).toBe(`${join(r.dir, "bin")}:/opt/node_modules/.bin:/usr/bin:/bin`);
  });
  // With no node on PATH (or with --bun), `bun run` puts its own folder first: <tmp>/bun-node-<build>, which holds a
  // `node` and a `bun` that are links to Bun. The planted links here are fake buns that also leave a mark.
  const plantBunNode = (name: string) => (dir: string) => {
    mkdirSync(join(dir, name));
    for (const n of ["bun", "node"]) writeFileSync(join(dir, name, n), `${FAKE_BUN}: > "$OUT_DIR/runner-bun"\n`, { mode: 0o755 });
  };
  for (const [label, name, order] of [
    ["at the front", "bun-node-0d9b296af", (b: string, nm: string) => `${b}:${nm}`],
    ["among the node_modules/.bin entries", "bun-node-0d9b296af", (b: string, nm: string) => `${nm}:${b}:/node_modules/.bin`],
    ["with no build in its name", "bun-node", (b: string, nm: string) => `${b}:${nm}`],
  ] as const)
    test(`Bun's bun-node entry ${label} goes too, and the user's own bun runs the server`, () => {
      const r = run([], runner, { prepare: plantBunNode(name), path: (bin, dir) => `${order(join(dir, name), `${ROOT}/node_modules/.bin`)}:/node_modules/.bin:${bin}:/usr/bin:/bin` });
      expect(r.code).toBe(0);
      expect(r.path).toBe(`${join(r.dir, "bin")}:/usr/bin:/bin`);
      expect(existsSync(join(r.dir, "runner-bun"))).toBe(false);
    });
  // Every bun-node folder in these tests is a planted one, or one that does not exist: a real one links to the real bun.
  test("a folder that only looks like Bun's, or one after the runner's entries, stays on PATH", () => {
    const r = run([], runner, { path: (bin, dir) => `${ROOT}/node_modules/.bin:${dir}/bun-node-tools/bin:${bin}:${dir}/later/bun-node-0d9b296af:/usr/bin:/bin` });
    expect(r.path).toBe(`${r.dir}/bun-node-tools/bin:${join(r.dir, "bin")}:${r.dir}/later/bun-node-0d9b296af:/usr/bin:/bin`);
    const named = run([], runner, { path: (bin, dir) => `${dir}/bun-node-tools:${bin}:/usr/bin:/bin` });
    expect(named.path).toBe(`${named.dir}/bun-node-tools:${join(named.dir, "bin")}:/usr/bin:/bin`);
    const below = run([], runner, { path: (bin, dir) => `${dir}/bun-node-cache/bun-node-0d9b296af:${bin}:/usr/bin:/bin` });
    expect(below.path).toBe(`${join(below.dir, "bin")}:/usr/bin:/bin`);
  });
  test("when the user's own PATH has no bun, the runner's bun starts the server, still with the user's PATH", () => {
    const r = run([], runner, { prepare: plantBunNode("bun-node-0d9b296af"), path: (_bin, dir) => `${join(dir, "bun-node-0d9b296af")}:${ROOT}/node_modules/.bin:/usr/bin:/bin` });
    expect(r.code).toBe(0);
    expect(r.path).toBe("/usr/bin:/bin");
    expect(existsSync(join(r.dir, "runner-bun"))).toBe(true);
  });
  test("without a package runner PATH is left as it is", () => {
    const r = run([], {}, { prepare: plantBunNode("bun-node-0d9b296af"), path: (bin, dir) => `${dir}/bun-node-0d9b296af:/srv/node_modules/.bin:${bin}:/usr/bin:/bin` });
    expect(r.path).toBe(`${r.dir}/bun-node-0d9b296af:/srv/node_modules/.bin:${join(r.dir, "bin")}:/usr/bin:/bin`);
  });
  test("the script's lists are CLEAN_ENV's (server/agents/types.ts)", () => {
    const text = readFileSync(SCRIPT, "utf8");
    const list = (name: string) => (new RegExp(`^${name}="([^"]*)"$`, "m").exec(text)?.[1] ?? "").split(" ").filter(Boolean);
    expect(list("always")).toEqual([...CLEAN_ENV.always]);
    expect(list("always_prefixes")).toEqual([...CLEAN_ENV.alwaysPrefixes]);
    expect(list("desktop_markers")).toEqual([...CLEAN_ENV.desktopMarkers]);
    expect(list("desktop")).toEqual([...CLEAN_ENV.desktop]);
    expect(list("trace")).toEqual([...CLEAN_ENV.traceAfterSession]);
  });
});

describe("the start-env file (4.8)", () => {
  test("its lines remove and set variables; a value is never run as shell code", () => {
    const r = run([], { KEEP_ME: "1", LOCALAPP_ONE: "1", LOCALAPP_TWO: "1", OTHER: "1" }, {
      startEnv: "# local values\n\n   \nunset KEEP_ME\nunset-prefix LOCALAPP_\nset KITESPAN_TEST_VALUE=a b 'c' $(touch made-by-shell) ;x\n",
    });
    expect(r.code).toBe(0);
    for (const n of ["KEEP_ME", "LOCALAPP_ONE", "LOCALAPP_TWO"]) expect(r.names).not.toContain(n);
    expect(r.names).toContain("OTHER");
    expect(r.value).toBe("a b 'c' $(touch made-by-shell) ;x");
    expect(existsSync(join(r.dir, "made-by-shell"))).toBe(false);
  });
  test("a last line with no newline counts", () => {
    expect(run([], {}, { startEnv: "set KITESPAN_TEST_VALUE=last" }).value).toBe("last");
  });
  test("a bad line stops the start and names the line, never a value", () => {
    const r = run([], {}, { startEnv: "set KITESPAN_TEST_VALUE=hunter2-secret\n# ok\nexport FOO=bar-secret\n" });
    expect(r.code).toBe(1);
    expect(r.ran).toBe(false);
    expect(r.stderr).toContain("line 3");
    expect(r.stderr).not.toContain("secret");
  });
  test("each bad shape is refused", () => {
    for (const line of ["unset 1BAD", "unset A B", "set =x", "set A-B=x", "unset-prefix", "UNSET A", "set A", "unset A\r"]) {
      const r = run([], {}, { startEnv: `${line}\n` });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("line 1");
    }
  });
  test("a set line may not name a variable that kitespan removes", () => {
    for (const name of ["CLAUDECODE", "AI_AGENT", "CLAUDE_CODE_MESSAGING_X", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"]) {
      const r = run([], {}, { startEnv: `set ${name}=1\n` });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("line 1");
    }
  });
  test("a file that others can write, or a link, is refused", () => {
    const wide = run([], {}, { startEnv: "set KITESPAN_TEST_VALUE=x\n", startEnvMode: 0o620 });
    expect(wide.code).toBe(1);
    expect(wide.stderr).toContain("writable by others");
    const other = run([], {}, { startEnv: "set KITESPAN_TEST_VALUE=x\n", startEnvMode: 0o602 });
    expect(other.code).toBe(1);
    expect(run([], {}, { startEnv: "set KITESPAN_TEST_VALUE=x\n", startEnvMode: 0o644 }).code).toBe(0);
  });
  test("a symbolic link in its place is refused", () => {
    const { dir, bin, config } = setup();
    const real = join(dir, "real-start-env");
    writeFileSync(real, "set KITESPAN_TEST_VALUE=x\n", { mode: 0o600 });
    symlinkSync(real, join(config, "kitespan", "start-env"));
    const r = Bun.spawnSync(["sh", SCRIPT], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(dir, "home"), XDG_CONFIG_HOME: config, OUT_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("not a link");
    expect(existsSync(join(dir, "args"))).toBe(false);
  });
  test("a relative XDG_CONFIG_HOME falls back to ~/.config", () => {
    const { dir, bin } = setup();
    mkdirSync(join(dir, "home", ".config", "kitespan"), { recursive: true });
    writeFileSync(join(dir, "home", ".config", "kitespan", "start-env"), "set KITESPAN_TEST_VALUE=from-home\n", { mode: 0o600 });
    Bun.spawnSync(["sh", SCRIPT], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(dir, "home"), XDG_CONFIG_HOME: "relative/config", OUT_DIR: dir } });
    expect(readFileSync(join(dir, "value"), "utf8")).toBe("from-home");
  });
});

// bin/kitespan restart (4.10 step 1; build checklist S7): the request that Settings > About > Restart sends, to a
// scratch server in this process that records it. The real Bun runs the script's client.
describe("bin/kitespan restart (S7)", () => {
  interface Seen {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }
  async function restart(args: string[], answer: (seen: Seen) => Response, opts: { startEnv?: string } = {}): Promise<{ code: number; out: string; err: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const s = { method: req.method, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() };
        seen.push(s);
        return answer(s);
      },
    });
    try {
      const { dir, config } = setup();
      if (opts.startEnv !== undefined) writeFileSync(join(config, "kitespan", "start-env"), opts.startEnv, { mode: 0o600 });
      const bunDir = resolve(process.execPath, "..");
      const port = String(server.port);
      const p = Bun.spawn(["sh", SCRIPT, "restart", ...args.map((a) => (a === "PORT" ? port : a))], {
        cwd: dir,
        env: { PATH: `${bunDir}:/usr/bin:/bin`, HOME: join(dir, "home"), XDG_CONFIG_HOME: config },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, out, err, seen };
    } finally {
      void server.stop(true);
    }
  }
  const accepted = (s: Seen) => Response.json({ when: JSON.parse(s.body).when }, { status: 202 });

  test("POST /api/restart with the sender gate's headers: x-kitespan, a JSON body, kitespan's own Origin and Host", async () => {
    const r = await restart(["--port", "PORT"], accepted);
    expect(r.code).toBe(0);
    expect(r.seen.length).toBe(1);
    const s = r.seen[0]!;
    const port = s.headers.host!.split(":")[1];
    expect([s.method, s.path]).toEqual(["POST", "/api/restart"]);
    expect(s.headers["x-kitespan"]).toBe("1");
    expect(s.headers["content-type"]).toBe("application/json");
    expect(s.headers.origin).toBe(`http://127.0.0.1:${port}`);
    expect(s.headers.host).toBe(`127.0.0.1:${port}`);
    expect(JSON.parse(s.body)).toEqual({ when: "finish" });
    expect(r.out).toBe("kitespan restarts when the running turns end.\n");
  }, 20_000);

  test("--now asks for Restart now", async () => {
    const r = await restart(["--now", "--port", "PORT"], accepted);
    expect(JSON.parse(r.seen[0]!.body)).toEqual({ when: "now" });
    expect(r.out).toBe("kitespan is restarting.\n");
  }, 20_000);

  test("a refusal prints the server's own sentence and exits 1", async () => {
    const line = "The update did not finish. Update again first.";
    const r = await restart(["--port", "PORT"], () => Response.json({ error: { code: "preflight", message: line } }, { status: 409 }));
    expect(r.code).toBe(1);
    expect(r.err).toBe(`kitespan: ${line}\n`);
  }, 20_000);

  test("a sentence with a control character (a terminal escape from whatever listens there) or a long one is never printed", async () => {
    const said = (message: string) => restart(["--port", "PORT"], () => Response.json({ error: { code: "restarting", message } }, { status: 409 }));
    for (const message of ["\u001b]0;owned\u0007kitespan is restarting.", "line one\nline two", "\u009b31m red", `${"a".repeat(201)}.`]) {
      const r = await said(message);
      expect(r.code).toBe(1);
      expect(r.err).toBe("kitespan: That did not work.\n");
    }
    expect((await said(`${"a".repeat(199)}.`)).err).toBe(`kitespan: ${"a".repeat(199)}.\n`);
  }, 30_000);

  test("it reads no start-env file (a bad line there is the next start's problem), and refuses a word it does not know", async () => {
    expect((await restart(["--port", "PORT"], accepted, { startEnv: "this is not a line\n" })).code).toBe(0);
    const bad = await restart(["--later"], accepted);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("unknown option --later");
    expect(bad.seen).toEqual([]);
  }, 20_000);

  test("--help and -h print its usage on stdout and exit 0; nothing is sent", async () => {
    for (const args of [["--help"], ["-h"], ["--now", "--port", "PORT", "--help"]]) {
      const r = await restart(args, accepted);
      expect({ args, code: r.code, out: r.out, err: r.err, seen: r.seen.length }).toEqual({ args, code: 0, out: "Usage: bin/kitespan restart [--now] [--port <port>]\n", err: "", seen: 0 });
    }
  }, 30_000);

  test("nothing listening on the port: one line, exit 1", async () => {
    const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = String(free.port);
    await free.stop(true);
    const { dir, config } = setup();
    const p = Bun.spawnSync(["sh", SCRIPT, "restart", "--port", port], { cwd: dir, env: { PATH: `${resolve(process.execPath, "..")}:/usr/bin:/bin`, HOME: join(dir, "home"), XDG_CONFIG_HOME: config }, stderr: "pipe" });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toBe(`kitespan: no kitespan answers on port ${port}.\n`);
  }, 20_000);
});
