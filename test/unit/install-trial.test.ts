// scripts/install-trial.sh's first form outside the installer's own steps: it installs into $HOME, starts kitespan on
// that home's state folder and ends with --uninstall, so it refuses, before anything, a home that kitespan (or its old
// name, whose folders kitespan's first start moves: LEGACY_FOLDER) has used: the link, or a data, state or config
// folder by the XDG rule. Its work folder in TMPDIR goes on every exit, a failure's too. The release folder here holds
// a stub install.sh that only records that it ran and fails, so nothing is installed or started.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_FOLDER } from "../../shared/legacy";
import { type Home, makeHome, removeHomes, ROOT, snapshot } from "../install/home";

afterAll(removeHomes);

const TRIAL = join(ROOT, "scripts", "install-trial.sh");
/** The trial's port argument (nothing listens on it here: the stub install.sh fails before any start). */
const PORT = String(Number(process.env.KITESPAN_TEST_PORT) || 7941);
const STUB = '#!/bin/sh\nprintf "the stub install.sh ran\\n" >"$(dirname "$0")/ran"\nprintf "stub install.sh output\\n"\nexit 1\n';

/** A fresh home (test/install/home.ts) with sh, mktemp and dirname on PATH too, and a release folder with the stub. */
function trialHome(): { h: Home; folder: string } {
  const h = makeHome();
  for (const t of ["/bin/sh", "/usr/bin/mktemp", "/usr/bin/dirname"]) symlinkSync(t, join(h.bin, t.slice(t.lastIndexOf("/") + 1)));
  const folder = join(h.dir, "release");
  mkdirSync(folder);
  writeFileSync(join(folder, "SHA256SUMS"), `${"a".repeat(64)}  kitespan-0.1.0.tar.gz\n${"b".repeat(64)}  install.sh\n`);
  writeFileSync(join(folder, "install.sh"), STUB, { mode: 0o755 });
  return { h, folder };
}

function trial(h: Home, folder: string, env: Record<string, string | undefined> = {}): { code: number; err: string } {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...h.env, ...env })) if (v !== undefined) e[k] = v;
  const r = Bun.spawnSync(["/bin/sh", TRIAL, folder, PORT], { cwd: h.dir, env: e, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000, killSignal: "SIGKILL" });
  return { code: r.exitCode ?? -1, err: r.stderr.toString() };
}

describe("install-trial.sh <release folder> <port>", () => {
  test("a home with kitespan's link, or a data, state or config folder of kitespan or of its old name, is refused: nothing runs or changes", () => {
    const places = (h: Home) => {
      const data = join(h.home, ".local", "share");
      const state = join(h.home, ".local", "state");
      const config = join(h.home, ".config");
      return [h.link, ...[data, state, config].flatMap((base) => [join(base, "kitespan"), join(base, LEGACY_FOLDER)])];
    };
    for (let i = 0; i < 7; i++) {
      const { h, folder } = trialHome();
      const place = places(h)[i]!;
      if (place === h.link) {
        mkdirSync(h.bindir, { recursive: true });
        symlinkSync(join(h.kit, "current"), h.link);
      } else mkdirSync(place, { recursive: true });
      const before = snapshot(h.home);
      const r = trial(h, folder);
      expect({ place, code: r.code, err: r.err }).toEqual({ place, code: 1, err: `install-trial: ${place} is there already, so this is not a fresh home; nothing changed\n` });
      expect(existsSync(join(folder, "ran"))).toBe(false);
      expect(snapshot(h.home)).toEqual(before);
    }
  });

  test("by the XDG rule: an absolute XDG_STATE_HOME's folder counts, and ~/.local/state's when the variable is not set", () => {
    const { h, folder } = trialHome();
    const elsewhere = join(h.home, "elsewhere");
    mkdirSync(join(elsewhere, "kitespan"), { recursive: true });
    const r = trial(h, folder, { XDG_STATE_HOME: elsewhere });
    expect([r.code, r.err]).toEqual([1, `install-trial: ${join(elsewhere, "kitespan")} is there already, so this is not a fresh home; nothing changed\n`]);
    const g = trialHome();
    mkdirSync(join(g.h.home, ".local", "state", LEGACY_FOLDER), { recursive: true });
    const unset = trial(g.h, g.folder, { XDG_STATE_HOME: undefined, XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: undefined });
    expect([unset.code, unset.err]).toEqual([1, `install-trial: ${join(g.h.home, ".local", "state", LEGACY_FOLDER)} is there already, so this is not a fresh home; nothing changed\n`]);
    expect(existsSync(join(folder, "ran")) || existsSync(join(g.folder, "ran"))).toBe(false);
  });

  test("in a fresh home it runs the release's install.sh; its failure is one line and the installer's output, and the work folder goes", () => {
    const { h, folder } = trialHome();
    const r = trial(h, folder);
    expect(r.code).toBe(1);
    expect(r.err).toBe("install-trial: the install of kitespan 0.1.0 failed\nstub install.sh output\n");
    expect(existsSync(join(folder, "ran"))).toBe(true);
    expect(readdirSync(h.env.TMPDIR!)).toEqual([]);
  });
});
