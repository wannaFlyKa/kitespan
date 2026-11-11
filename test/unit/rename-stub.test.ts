// The rename to kitespan (iteration 6, round K1): the start command is bin/kitespan, and bin/flydeck stays for one
// release as a stub that says the new name on stderr and runs bin/kitespan with every argument in its own process (a
// server of the old name restarts into its successor as `<root>/bin/flydeck ... --bind-wait 10` and watches that
// pid). bin/kitespan reads the start-env file of the new config folder, or of the old one while the new one is not
// there (the server moves the folder at its first start). The successor runs bin/kitespan. No server starts here: a
// fake bun records what it was given.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LEGACY_BIN, LEGACY_FOLDER } from "../../shared/legacy";
import { successorArgv } from "../../server/update/successor";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const STUB = join(ROOT, LEGACY_BIN);
const SCRIPT = join(ROOT, "bin", "kitespan");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `kitespan-${name}-`)));
  scratch.push(d);
  return d;
};

describe("the stub at the old name", () => {
  test("it is an executable sh script", () => {
    expect(statSync(STUB).mode & 0o111).not.toBe(0);
    expect(readFileSync(STUB, "utf8")).toStartWith("#!/bin/sh\n");
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
    expect(readFileSync(SCRIPT, "utf8")).toStartWith("#!/bin/sh\n");
  });

  test("it says the new name once on stderr, then runs bin/kitespan in its own process with every argument", () => {
    // A copy of the stub beside a stand-in bin/kitespan that prints its pid and its arguments.
    const root = tmp("stub");
    mkdirSync(join(root, "bin"));
    copyFileSync(STUB, join(root, LEGACY_BIN));
    chmodSync(join(root, LEGACY_BIN), 0o755);
    writeFileSync(join(root, "bin", "kitespan"), `#!/bin/sh\necho "pid $$"\nfor a in "$@"; do printf '[%s]\\n' "$a"; done\n`, { mode: 0o755 });
    const r = Bun.spawnSync(["/bin/sh", "-c", 'echo "pid $$"; exec "$0" "$@"', join(root, LEGACY_BIN), "restart", "a b", "", "--port", "7942"], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin", HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString().split("\n").filter(Boolean);
    expect(out[0]).toMatch(/^pid \d+$/);
    expect(out[1]).toBe(out[0]!);
    expect(out.slice(2)).toEqual(["[restart]", "[a b]", "[]", "[--port]", "[7942]"]);
    const err = r.stderr.toString().split("\n").filter(Boolean);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("bin/kitespan");
  });

  test("the real chain: bin/flydeck restart reaches bin/kitespan restart", () => {
    const port = freePort();
    const r = Bun.spawnSync(["sh", STUB, "restart", "--port", String(port)], {
      cwd: tmp("chain"),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp("chain-home") },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    expect(r.exitCode).toBe(1);
    const err = r.stderr.toString();
    expect(err).toContain("bin/kitespan");
    expect(err).toContain(`kitespan: no kitespan answers on port ${port}.`);
  });

  test("a restart's successor runs bin/kitespan", () => {
    expect(successorArgv("/srv/k", ["--port", "7942"], "/srv")[0]).toBe("/srv/k/bin/kitespan");
  });
});

describe("bin/kitespan's start-env file", () => {
  const FAKE_BUN = `#!/bin/sh\nprintf '%s' "\${KITESPAN_TEST_VALUE-}" > "$OUT_DIR/value"\n`;

  function run(prepare: (config: string) => void): { code: number; value: string; stderr: string } {
    const dir = tmp("start-env");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "bun"), FAKE_BUN, { mode: 0o755 });
    mkdirSync(join(dir, "home"));
    const config = join(dir, "config");
    mkdirSync(config);
    prepare(config);
    const r = Bun.spawnSync(["sh", SCRIPT, "--port", "7942"], {
      cwd: dir,
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: join(dir, "home"), XDG_CONFIG_HOME: config, OUT_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const f = join(dir, "value");
    return { code: r.exitCode ?? -1, value: existsSync(f) ? readFileSync(f, "utf8") : "", stderr: r.stderr.toString() };
  }
  const startEnv = (config: string, folder: string, value: string) => {
    mkdirSync(join(config, folder), { mode: 0o700 });
    writeFileSync(join(config, folder, "start-env"), `set KITESPAN_TEST_VALUE=${value}\n`, { mode: 0o600 });
  };

  test("the new config folder's file", () => {
    expect(run((c) => startEnv(c, "kitespan", "new"))).toEqual({ code: 0, value: "new", stderr: "" });
  });

  test("the old config folder's file, while the new folder is not there", () => {
    expect(run((c) => startEnv(c, LEGACY_FOLDER, "old"))).toEqual({ code: 0, value: "old", stderr: "" });
  });

  test("the old one through a link to a folder, as the old command read it", () => {
    const r = run((c) => {
      startEnv(c, "real-config", "linked");
      symlinkSync(join(c, "real-config"), join(c, LEGACY_FOLDER));
    });
    expect(r).toEqual({ code: 0, value: "linked", stderr: "" });
  });

  test("both folders: only the new one's", () => {
    expect(
      run((c) => {
        startEnv(c, "kitespan", "new");
        startEnv(c, LEGACY_FOLDER, "old");
      }),
    ).toEqual({ code: 0, value: "new", stderr: "" });
  });

  test("anything at the new name (here an empty folder) means the new one: the old file is not read", () => {
    expect(
      run((c) => {
        mkdirSync(join(c, "kitespan"), { mode: 0o700 });
        startEnv(c, LEGACY_FOLDER, "old");
      }),
    ).toEqual({ code: 0, value: "", stderr: "" });
  });

  test("a bad line in the old folder's file refuses the start as the new one's would", () => {
    const r = run((c) => {
      mkdirSync(join(c, LEGACY_FOLDER), { mode: 0o700 });
      writeFileSync(join(c, LEGACY_FOLDER, "start-env"), "echo hello\n", { mode: 0o600 });
    });
    expect(r.code).toBe(1);
    expect(r.value).toBe("");
    expect(r.stderr).toContain(`${LEGACY_FOLDER}/start-env line 1`);
    expect(r.stderr).toStartWith("kitespan: ");
  });
});
