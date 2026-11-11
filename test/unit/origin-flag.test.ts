// `bin/kitespan --origin <origin>` (owner row 104's lead note; DESIGN.md 4.8 and 4.9): a forward's exact origin allowed
// until kitespan stops (a restart keeps it) without an edit of adapters.json, checked by the access adapter's own rule
// (isExactOrigin), at most 20, never written anywhere (restart-e2e.test.ts checks the successor's file). The start output lists every origin beyond kitespan's own with where it came from, then the
// remote-access disclaimer once (row 104); with none, the public hint. The guards do not change: the Origin check before
// the upgrade, the sender header with an allowed Origin on every mutating route, the Host allowlist on reads. And
// --help. The server runs on the test port with a scratch HOME and XDG folders and the fake claude first on PATH; the
// test stops only the process it spawned, through its own handle.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { accessHint, allowedOrigins, NO_SIGN_IN, originFlagProblem } from "../../server/adapters/adapters";
import { createGate } from "../../server/gate/guards";
import { successorArgv } from "../../server/update/successor";
import { installFakeClaude } from "../fake-claude/install";
import { pickTestPort } from "../click/ports";
import { readInto } from "./read-into";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const P = 7940;
const BOX = "https://box.example.com";
const FILE = "https://kitespan.example.com";
const USAGE = "Usage: bin/kitespan [dev] [--port <port>] [--origin <origin>]... [--dist <build folder>] (bin/kitespan --help)";
const HELP = [
  "Usage: bin/kitespan [dev] [options]",
  "       bin/kitespan restart [--now] [--port <port>]",
  "",
  "  --port <port>        listen on 127.0.0.1:<port> (default 7940)",
  "  --origin <origin>    also allow pages from this exact origin until kitespan stops (a restart",
  "                       keeps it); repeatable, for example https://box.tail1234.ts.net",
  "  --dist <folder>      serve the page from this build folder",
  "  --version            print kitespan's version",
  "  --help               print this help",
  "",
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "kitespan-origin-flag-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fake = installFakeClaude({});
afterAll(() => fake.cleanup());

/** A clean environment of the scratch folder's own, as bin/kitespan would leave it, with a built page. */
function cleanEnv(name: string, extra: Record<string, string> = {}): { env: Record<string, string>; dist: string; config: string } {
  const base = join(dir, name);
  for (const d of ["home", "state", "config", "data", "tmp", "dist"]) mkdirSync(join(base, d), { recursive: true });
  writeFileSync(join(base, "dist", "index.html"), "<!doctype html><html><body>kitespan page</body></html>");
  return {
    env: {
      PATH: `${fake.binDir}:/usr/bin:/bin`,
      HOME: join(base, "home"),
      XDG_STATE_HOME: join(base, "state"),
      XDG_CONFIG_HOME: join(base, "config"),
      XDG_DATA_HOME: join(base, "data"),
      TMPDIR: join(base, "tmp"),
      SHELL: "/bin/sh",
      ...extra,
    },
    dist: join(base, "dist"),
    config: join(base, "config"),
  };
}

function run(args: string[], env: Record<string, string>) {
  const r = Bun.spawnSync([process.execPath, "--no-env-file", MAIN, ...args], { env, cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("the parse: the access adapter's own rule", () => {
  test("an exact origin passes: https and a host name with an optional port, or http on loopback", () => {
    for (const v of [BOX, "https://box.example.com:8443", "https://box.tail1234.ts.net", "http://localhost:8080", "http://127.0.0.1:9000", "http://[::1]:8080"]) expect(originFlagProblem(v)).toBeNull();
  });

  test("each refusal, in its own words; the value is printed back only when it is safe to print", () => {
    expect(originFlagProblem("")).toBe("--origin needs a value");
    expect(originFlagProblem("https://Box.example.com/")).toBe("--origin https://Box.example.com/: give the origin only, https://box.example.com");
    expect(originFlagProblem("https://box.example.com/app")).toBe("--origin https://box.example.com/app: give the origin only, https://box.example.com");
    expect(originFlagProblem("https://box.example.com:443")).toBe("--origin https://box.example.com:443: give the origin only, https://box.example.com");
    expect(originFlagProblem("http://localhost:8080/")).toBe("--origin http://localhost:8080/: give the origin only, http://localhost:8080");
    expect(originFlagProblem("https://user@box.example.com")).toBe("--origin https://user@box.example.com: give the origin only, https://box.example.com");
    expect(originFlagProblem("http://box.example.com")).toBe("--origin http://box.example.com: http:// is only for 127.0.0.1, localhost or [::1]; use https://");
    expect(originFlagProblem("http://box.example.com/")).toBe("--origin http://box.example.com/: http:// is only for 127.0.0.1, localhost or [::1]; use https://");
    for (const v of ["https://*.example.com", "box.example.com", "ftp://box.example.com", "https://.example.com", "*"]) {
      expect(originFlagProblem(v)).toBe(`--origin ${v}: not an exact origin (https://, a full host name and an optional port)`);
    }
    const quiet = "--origin takes an exact origin of at most 255 characters";
    expect(originFlagProblem(`https://${"a".repeat(250)}.example.com`)).toBe(quiet);
    expect(originFlagProblem("https://box.example.com\u001b[2J")).toBe(quiet);
    expect(originFlagProblem("https://box.example.com\n")).toBe(quiet);
  });

  test("through the server: exit 2, the line, the usage line; nothing started, nothing moved", () => {
    const { env, dist } = cleanEnv("parse");
    const cases: [string[], string][] = [
      [["--origin"], "--origin needs a value"],
      [["--origin", "http://box.example.com"], "--origin http://box.example.com: http:// is only for 127.0.0.1, localhost or [::1]; use https://"],
      [["--origin", BOX, "--origin", "https://*.example.com"], "--origin https://*.example.com: not an exact origin (https://, a full host name and an optional port)"],
      [Array.from({ length: 21 }, (_, i) => ["--origin", `https://b${i}.example.com`]).flat(), "--origin is given more than 20 times"],
    ];
    for (const [args, line] of cases) {
      const r = run(["--check", "--dist", dist, ...args], env);
      expect([args.slice(-1)[0], r.code]).toEqual([args.slice(-1)[0], 2]);
      expect(r.err).toBe(`kitespan: ${line}\nkitespan: ${USAGE}\n`);
    }
    // A value given twice counts once: 20 different ones and a repeat pass.
    const twenty = Array.from({ length: 20 }, (_, i) => ["--origin", `https://b${i}.example.com`]).flat();
    expect(run(["--check", "--dist", dist, ...twenty, "--origin", "https://b0.example.com"], env).code).toBe(0);
    expect(run(["--check", "--dist", dist, "--origin", BOX], env)).toEqual({ code: 0, out: "", err: "" });
  }, 60_000);

  test("--help and -h print the usage on stdout and exit 0, before the start environment check", () => {
    const { env } = cleanEnv("help");
    for (const args of [["--help"], ["-h"], ["--port", "7999", "--help"], ["--origin", BOX, "-h"]]) {
      expect(run(args, env)).toEqual({ code: 0, out: HELP, err: "" });
    }
    // A start environment that bin/kitespan did not clean still gets the help: it starts nothing.
    expect(run(["--help"], { ...env, CLAUDECODE: "1" })).toEqual({ code: 0, out: HELP, err: "" });
    // As an option's value it is that value, not a help request.
    expect(run(["--origin", "--help"], env).err).toContain("--origin --help: not an exact origin");
  }, 60_000);
});

describe("the merge: the flag's first, each origin once with where it came from", () => {
  test("flag only, file only, both, one origin in both", () => {
    expect(allowedOrigins(P, [BOX], [])).toEqual([{ origin: BOX, from: ["--origin"] }]);
    expect(allowedOrigins(P, [], [FILE])).toEqual([{ origin: FILE, from: ["adapters.json"] }]);
    expect(allowedOrigins(P, [BOX], [FILE])).toEqual([
      { origin: BOX, from: ["--origin"] },
      { origin: FILE, from: ["adapters.json"] },
    ]);
    expect(allowedOrigins(P, [BOX, FILE, BOX], [FILE, "https://other.example.com"])).toEqual([
      { origin: BOX, from: ["--origin"] },
      { origin: FILE, from: ["--origin", "adapters.json"] },
      { origin: "https://other.example.com", from: ["adapters.json"] },
    ]);
    expect(allowedOrigins(P, [], [])).toEqual([]);
  });

  test("kitespan's own three loopback origins are the machine's own: left out; a loopback origin on another port is not", () => {
    expect(allowedOrigins(P, [`http://127.0.0.1:${P}`, `http://localhost:${P}`, `http://[::1]:${P}`], [`http://localhost:${P}`])).toEqual([]);
    expect(allowedOrigins(P, ["http://localhost:8080"], [])).toEqual([{ origin: "http://localhost:8080", from: ["--origin"] }]);
  });

  test("the gate takes them as it takes the file's", () => {
    const gate = createGate(P, allowedOrigins(P, [BOX], [FILE]).map((a) => a.origin));
    expect(gate.originAllowed(BOX)).toBe(true);
    expect(gate.originAllowed(FILE)).toBe(true);
    expect(gate.originAllowed("https://other.example.com")).toBe(false);
    expect(gate.hostAllowed("box.example.com")).toBe(true);
  });
});

describe("the start lines", () => {
  const own = `kitespan listens on http://127.0.0.1:${P}`;
  const pub = [
    own,
    `From another device: ssh -L ${P}:127.0.0.1:${P} <this host>, then open http://127.0.0.1:${P} there. Other ways in: Tailscale Serve, Cloudflare Tunnel with Access, a reverse proxy.`,
    `The browser must open kitespan on port ${P} of 127.0.0.1, localhost or [::1]; any other origin gets 403 unless --origin or access.origins in adapters.json allows it.`,
  ];

  test("the disclaimer, word for word", () => {
    expect(NO_SIGN_IN).toBe("kitespan has no sign-in in this release: anyone who can open its page can run Claude Code as you, and you are responsible for how you connect it from another device.");
  });

  test("nothing beyond the machine's own: the public hint, with the public ways in only", () => {
    expect(accessHint(P, { hint: null, origins: [] }, [])).toEqual(pub);
    expect(accessHint(P, { hint: null, origins: [] })).toEqual(pub);
    expect(pub.join("\n")).not.toContain(NO_SIGN_IN);
  });

  test("origins beyond it: one line that lists each with its source, then the disclaimer once; no public hint", () => {
    expect(accessHint(P, { hint: null, origins: [FILE] }, allowedOrigins(P, ["https://box.tail1234.ts.net"], [FILE]))).toEqual([
      own,
      `Also allowed: https://box.tail1234.ts.net (--origin), ${FILE} (adapters.json)`,
      NO_SIGN_IN,
    ]);
    expect(accessHint(P, { hint: null, origins: [BOX] }, allowedOrigins(P, [BOX], [BOX]))).toEqual([own, `Also allowed: ${BOX} (--origin, adapters.json)`, NO_SIGN_IN]);
    // Without the third argument, the file's origins are the ones in force.
    expect(accessHint(P, { hint: null, origins: [FILE] })).toEqual([own, `Also allowed: ${FILE} (adapters.json)`, NO_SIGN_IN]);
    expect(accessHint(P, { hint: null, origins: [] }, allowedOrigins(P, ["http://localhost:8080"], []))).toEqual([own, "Also allowed: http://localhost:8080 (--origin)", NO_SIGN_IN]);
  });

  test("a restart's successor prints into logs/server-out.log, a file: the flag's own origins are counted there, never named", () => {
    const TS = "https://box.tail1234.ts.net";
    expect(accessHint(P, { hint: null, origins: [FILE] }, allowedOrigins(P, [BOX, TS, FILE], [FILE]), { toFile: true })).toEqual([
      own,
      `Also allowed: 2 origins from --origin, ${FILE} (--origin, adapters.json)`,
      NO_SIGN_IN,
    ]);
    expect(accessHint(P, { hint: null, origins: [] }, allowedOrigins(P, [BOX], []), { toFile: true })).toEqual([own, "Also allowed: 1 origin from --origin", NO_SIGN_IN]);
    // The file's own origins are in the user's file already: named, as in a terminal.
    expect(accessHint(P, { hint: null, origins: [FILE] }, undefined, { toFile: true })).toEqual([own, `Also allowed: ${FILE} (adapters.json)`, NO_SIGN_IN]);
    expect(accessHint(P, { hint: null, origins: [] }, [], { toFile: true })).toEqual(pub);
  });

  test("the owner's own hint replaces the public hint, after the origins' two lines", () => {
    expect(accessHint(P, { hint: "Use my forward.\nOr the other.", origins: [] }, [])).toEqual([own, "Use my forward.", "Or the other."]);
    expect(accessHint(P, { hint: "Use my forward.", origins: [FILE] }, allowedOrigins(P, [BOX], [FILE]))).toEqual([
      own,
      `Also allowed: ${BOX} (--origin), ${FILE} (adapters.json)`,
      NO_SIGN_IN,
      "Use my forward.",
    ]);
  });
});

test("a restart's successor keeps every --origin (server/update/successor.ts ownOptions)", () => {
  const argv = ["--port", "7945", "--origin", BOX, "--origin", FILE, "--dist", "/srv/page"];
  expect(successorArgv("/opt/kitespan", argv, "/srv/work")).toEqual(["/opt/kitespan/bin/kitespan", "--port", "7945", "--origin", BOX, "--origin", FILE, "--dist", "/srv/page", "--bind-wait", "10"]);
});

// End to end on the test port: one origin from the flag, one from adapters.json, one in both.
describe("a start with --origin", () => {
  const PORT = pickTestPort();
  const OWN = `http://127.0.0.1:${PORT}`;
  const BOTH = "https://both.example.com";
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let out = "";

  afterAll(async () => {
    // Only the process this test spawned, through its own handle, while it has not exited.
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });

  async function upgrade(origin: string, host = `127.0.0.1:${PORT}`): Promise<number> {
    return await new Promise<number>((done) => {
      let text = "";
      Bun.connect({
        hostname: "127.0.0.1",
        port: PORT,
        socket: {
          open(s) {
            s.write(`GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
          },
          data(s, d) {
            text += Buffer.from(d).toString("latin1");
            if (text.includes("\r\n\r\n")) s.end();
          },
          close: () => done(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0)),
          error: () => done(0),
        },
      });
    });
  }

  test("the start lines, the origins in force and the guards", async () => {
    const { env, dist, config } = cleanEnv("e2e");
    mkdirSync(join(config, "kitespan"), { recursive: true, mode: 0o700 });
    const file = join(config, "kitespan", "adapters.json");
    writeFileSync(file, JSON.stringify({ v: 1, access: { origins: [BOTH, FILE] } }));
    chmodSync(file, 0o600);
    proc = Bun.spawn([process.execPath, "--no-env-file", MAIN, "--port", String(PORT), "--dist", dist, "--origin", BOX, "--origin", BOTH], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
    // Read from the first byte to the end by one reader (test/unit/read-into.ts), so no chunk is lost.
    await readInto(proc.stdout as ReadableStream<Uint8Array>, (s) => (out += s)).until(() => out.includes("Claude Code 2.1.322"), 20_000);
    const errText = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    const lines = [
      `kitespan listens on ${OWN}`,
      `Also allowed: ${BOX} (--origin), ${BOTH} (--origin, adapters.json), ${FILE} (adapters.json)`,
      NO_SIGN_IN,
      "Claude Code 2.1.322 (Claude Code)",
    ];
    expect(out).toBe(`${lines.join("\n")}\n`);

    // The Origin check before the upgrade: the flag's origin and the file's pass; another gets 403.
    expect(await upgrade(BOX)).toBe(101);
    expect(await upgrade(FILE)).toBe(101);
    expect(await upgrade("https://other.example.com")).toBe(403);
    // The sender gate of a mutating route: the header and an allowed Origin.
    const post = (origin: string) =>
      fetch(`${OWN}/api/settings`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin }, body: "{}" });
    expect((await post(BOX)).status).toBe(200);
    expect((await post("https://other.example.com")).status).toBe(403);
    // The Host allowlist on reads: the forward's host passes guard 10; another host does not.
    const read = (host: string) => fetch(`${OWN}/api/settings`, { headers: { host } });
    const s = await read("box.example.com");
    expect(s.status).toBe(200);
    const reply = (await s.json()) as { access: { origins: string[]; hint: string[] } };
    expect(reply.access.origins).toEqual([BOX, BOTH, FILE]);
    expect(reply.access.hint).toEqual(lines.slice(0, 3));
    expect((await read("other.example.com")).status).toBe(403);

    // The flag's origins are never written: not to the config folder, the state folder or a log.
    proc.kill("SIGTERM");
    expect(await Promise.race([proc.exited, Bun.sleep(15_000).then(() => -1)])).toBe(0);
    const written = new Bun.Glob("**/*").scanSync({ cwd: join(dir, "e2e"), onlyFiles: true, dot: true });
    for (const f of written) {
      if (f === join("config", "kitespan", "adapters.json") || f === join("dist", "index.html")) continue;
      const t = await Bun.file(join(dir, "e2e", f)).text();
      expect([f, t.includes("box.example.com")]).toEqual([f, false]);
    }
    expect(await errText).toBe("");
  }, 40_000);
});
