// The rename to kitespan (iteration 6, round K1; launch/PLAN.md L4): the old name's readers, which take an install or a
// page of the old name over for one release. The environment names (the new one, the old one with one line that names
// both and never a value, both), the sender header (the new one, the old one, neither), bin/kitespan restart's
// headers, the worktree branch prefix (new worktrees get the new one; a ledger or a record in the making of the old
// one keeps working for good), the day log files (the new name; the sweep still takes the old files), and the
// Temporary upload folder's new name. Every old literal comes from shared/legacy.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LEGACY_BRANCH_PREFIX, LEGACY_FOLDER, LEGACY_HEADER, LEGACY_LOG_PREFIX, LEGACY_NAME, legacyEnvName, readEnv } from "../../shared/legacy";
import { createGate, ownOrigin, senderHeader, senderPasses } from "../../server/gate/guards";
import { createLogger, logFileName } from "../../server/log";
import { WORKTREE_BRANCH, ledgerFrom } from "../../server/store/records";
import { tempFolderPath } from "../../server/store/uploads";
import { sweepMaking, type Making } from "../../server/worktree/pending";
import { branchOf } from "../../server/worktree/place";
import { pickTestPort } from "../click/ports";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `kitespan-${name}-`));
  scratch.push(d);
  return d;
};
const OLD_UPPER = LEGACY_NAME.toUpperCase();

describe("the environment names", () => {
  const lines = () => {
    const said: string[] = [];
    return { said, say: (l: string) => void said.push(l) };
  };

  test("each new name's old name", () => {
    expect(legacyEnvName("KITESPAN_PUSH_TEST_ORIGIN")).toBe(`${OLD_UPPER}_PUSH_TEST_ORIGIN`);
    expect(legacyEnvName("KITESPAN_LIVE")).toBe(`${OLD_UPPER}_LIVE`);
    expect(legacyEnvName("KITESPANTEST_LATE")).toBe(`${OLD_UPPER}TEST_LATE`);
    expect(legacyEnvName("HOME")).toBeNull();
  });

  test("the new name alone: its value, and no line", () => {
    const l = lines();
    expect(readEnv({ KITESPAN_TEST_PORT: "7942" }, "KITESPAN_TEST_PORT", l.say)).toBe("7942");
    expect(l.said).toEqual([]);
  });

  test("the old name alone: its value for this release, and one line that names both names and never the value", () => {
    const l = lines();
    const env = { [`${OLD_UPPER}_TEST_PORT`]: "7942-secret-value" };
    expect(readEnv(env, "KITESPAN_TEST_PORT", l.say)).toBe("7942-secret-value");
    expect(readEnv(env, "KITESPAN_TEST_PORT", l.say)).toBe("7942-secret-value");
    expect(l.said).toHaveLength(1);
    expect(l.said[0]).toContain(`${OLD_UPPER}_TEST_PORT`);
    expect(l.said[0]).toContain("KITESPAN_TEST_PORT");
    expect(l.said[0]).not.toContain("secret");
  });

  test("both names: the new one wins, and one line says the old one is not read", () => {
    const l = lines();
    expect(readEnv({ KITESPAN_LIVE: "1", [`${OLD_UPPER}_LIVE`]: "0" }, "KITESPAN_LIVE", l.say)).toBe("1");
    expect(l.said).toHaveLength(1);
    expect(l.said[0]).toContain(`${OLD_UPPER}_LIVE`);
    expect(l.said[0]).toContain("not read");
  });

  test("neither: undefined, and no line", () => {
    const l = lines();
    expect(readEnv({}, "KITESPAN_LIVE", l.say)).toBeUndefined();
    expect(l.said).toEqual([]);
  });

  test("the click-through's test port takes the new name, and the old one for this release", () => {
    const quiet = () => {};
    expect(pickTestPort(undefined, { KITESPAN_TEST_PORT: "7942" }, quiet)).toBe(7942);
    expect(pickTestPort(undefined, { [`${OLD_UPPER}_TEST_PORT`]: "7942" }, quiet)).toBe(7942);
    expect(() => pickTestPort(undefined, { [`${OLD_UPPER}_TEST_PORT`]: "7940" }, quiet)).toThrow();
  });
});

describe("the sender header", () => {
  const PORT = 7942;
  const gate = createGate(PORT);
  const req = (headers: Record<string, string>) => new Request(`${ownOrigin(PORT)}/api/x`, { method: "POST", headers });
  const base = { "content-type": "application/json", origin: ownOrigin(PORT) };

  test("x-kitespan: 1 passes the sender gate, and so does the old name's for this release", () => {
    expect(senderPasses(req({ ...base, "x-kitespan": "1" }), gate, "json")).toBe(true);
    expect(senderPasses(req({ ...base, [LEGACY_HEADER]: "1" }), gate, "json")).toBe(true);
  });

  test("no header, or a value other than 1, fails it", () => {
    expect(senderPasses(req(base), gate, "json")).toBe(false);
    for (const v of ["0", "true", "11", ""]) {
      expect(senderPasses(req({ ...base, "x-kitespan": v }), gate, "json")).toBe(false);
      expect(senderPasses(req({ ...base, [LEGACY_HEADER]: v }), gate, "json")).toBe(false);
    }
  });

  test("the page's own reads (commands, models, message search) take either", () => {
    expect(senderHeader(new Headers({ "x-kitespan": "1" }))).toBe(true);
    expect(senderHeader(new Headers({ [LEGACY_HEADER]: "1" }))).toBe(true);
    expect(senderHeader(new Headers({ "x-kitespan": "0", [LEGACY_HEADER]: "0" }))).toBe(false);
    expect(senderHeader(new Headers())).toBe(false);
  });

  test("the old name is x- and the old name", () => {
    expect(LEGACY_HEADER).toBe(`x-${LEGACY_NAME}`);
  });

  test("bin/kitespan restart sends the new header, and the old one for a server of the old name that runs until its restart", async () => {
    let seen: Headers | null = null;
    const port = freePort();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(r) {
        seen = r.headers;
        return Response.json({ ok: true }, { status: 202 });
      },
    });
    try {
      const p = Bun.spawn([process.execPath, "--no-env-file", join(ROOT, "server", "update", "ask-restart.ts"), "--port", String(port)], {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp("restart") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      expect(out).toBe("kitespan restarts when the running turns end.\n");
      const h = seen as Headers | null;
      expect(h?.get("x-kitespan")).toBe("1");
      expect(h?.get(LEGACY_HEADER)).toBe("1");
      expect(h?.get("origin")).toBe(`http://127.0.0.1:${port}`);
    } finally {
      server.stop(true);
    }
  });
});

describe("the worktree branch", () => {
  const CHAT = "abcdefghijklmnopqrst";
  const at = "2026-11-03T08:00:00.000Z";
  const ledger = (branch: string, path: string) => ({
    v: 1,
    id: CHAT,
    project: "k3m7q2x4ab",
    cwd: path,
    agent: "claude-code",
    sessionId: null,
    title: null,
    picks: { model: null, effort: null, permissionMode: null },
    createdAt: at,
    seenAt: at,
    lastActivityAt: at,
    lastSeq: 0,
    state: "sleeping",
    lastExit: null,
    archivedAt: null,
    worktree: { path, root: "/srv/repo", branch, baseRef: "refs/heads/main", baseCommit: "a".repeat(40) },
  });

  test("a new worktree gets kitespan/<name>", () => {
    expect(branchOf("abcdefgh")).toBe("kitespan/abcdefgh");
    expect(branchOf("abcdefgh-2")).toBe("kitespan/abcdefgh-2");
  });

  test("the ledger's check takes both prefixes, for good: a worktree of the old name keeps its chat", () => {
    for (const p of ["kitespan/", LEGACY_BRANCH_PREFIX]) {
      expect(WORKTREE_BRANCH.test(`${p}abcdefgh`)).toBe(true);
      expect(WORKTREE_BRANCH.test(`${p}abcdefgh-12`)).toBe(true);
      expect(WORKTREE_BRANCH.test(`${p}ABCDEFGH`)).toBe(false);
    }
    for (const bad of ["main", "other/abcdefgh", "kitespan/abc", `${LEGACY_BRANCH_PREFIX}abcdefgh-0`]) expect(WORKTREE_BRANCH.test(bad)).toBe(false);
    const old = `/data/${LEGACY_FOLDER}/worktrees/k3m7q2x4ab/abcdefgh`;
    expect(ledgerFrom(ledger(`${LEGACY_BRANCH_PREFIX}abcdefgh`, old)).worktree?.branch).toBe(`${LEGACY_BRANCH_PREFIX}abcdefgh`);
    expect(ledgerFrom(ledger("kitespan/abcdefgh", "/srv/repo/.claude/worktrees/abcdefgh")).worktree?.branch).toBe("kitespan/abcdefgh");
  });

  test("a record in the making keeps its own branch, of either name; one of another branch is not one of ours", async () => {
    const data = tmp("making");
    // The old data folder, while it is the data folder (nothing at the new one).
    const records = join(data, LEGACY_FOLDER, "worktrees", "k3m7q2x4ab");
    mkdirSync(records, { recursive: true, mode: 0o700 });
    const rec = (name: string, branch: string) =>
      writeFileSync(join(records, `${name}.making`), JSON.stringify({ v: 1, path: `/srv/repo/.claude/worktrees/${name}`, root: "/srv/repo", branch, commit: "a".repeat(40) }), { mode: 0o600 });
    rec("abcdefgh", `${LEGACY_BRANCH_PREFIX}abcdefgh`);
    rec("bcdefghi", "kitespan/bcdefghi");
    rec("cdefghij", "other/cdefghij");
    rec("defghijk", "kitespan/abcdefgh");
    const undone: Making[] = [];
    const n = await sweepMaking(
      data,
      [{ id: "k3m7q2x4ab", cwd: "/srv/repo" }],
      () => false,
      async (m) => {
        undone.push(m);
        return true;
      },
      async () => true,
    );
    expect(n).toBe(2);
    expect(undone.map((m) => m.branch).sort()).toEqual(["kitespan/bcdefghi", `${LEGACY_BRANCH_PREFIX}abcdefgh`].sort());
    expect(readdirSync(records)).toEqual([]);
  });
});

describe("the day log files", () => {
  test("a new day's file is kitespan-<date>.log", () => {
    expect(logFileName(new Date("2026-11-07T10:00:00Z"))).toBe("kitespan-2026-11-07.log");
  });

  test("the 14-day sweep removes the old name's files too, and keeps the recent ones of both", () => {
    const dir = join(tmp("logs"), "logs");
    mkdirSync(dir, { mode: 0o700 });
    for (const n of [`${LEGACY_LOG_PREFIX}2026-10-01.log`, "kitespan-2026-10-01.log", `${LEGACY_LOG_PREFIX}2026-11-06.log`, "kitespan-2026-11-06.log", "server-out.log"]) {
      writeFileSync(join(dir, n), "{}\n", { mode: 0o600 });
    }
    const log = createLogger({ dir, now: () => new Date("2026-11-07T10:00:00Z") });
    log.close();
    expect(readdirSync(dir).sort()).toEqual([`${LEGACY_LOG_PREFIX}2026-11-06.log`, "kitespan-2026-11-06.log", "server-out.log"].sort());
  });
});

describe("the Temporary upload folder", () => {
  test("new uploads go to kitespan-uploads-<user>", () => {
    expect(tempFolderPath({ stateUploads: "/srv/s/uploads", tmpRoot: "/tmp", home: "/srv/u", user: "tester", uid: 1000 })).toBe("/tmp/kitespan-uploads-tester");
  });
});
