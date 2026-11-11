// Row 99, `released.json` (server/store/released.ts): the sessions that an environment's Remove released, by folder,
// each id once (in the folder that released it last), a folder's newest 2,000 and the file's newest folders and ids
// kept; checked on every read (a bad file is set aside), written 0600 through the atomic writer; and a Continue's
// unrelease.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASED, RELEASED_LIMITS, ReleasedSessions, releasedFrom, withReleased, withoutReleased, type ReleasedFile } from "../../server/store/released";
import { ownUid } from "../../server/store/files";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-released-"));
  scratch.push(d);
  mkdirSync(join(d, "state"), { mode: 0o700 });
  return join(d, "state");
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A session id of the right shape, from a number. */
const sid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const EMPTY: ReleasedFile = { v: 1, folders: [] };
/** Sessions whose transcripts are under the folder that releases them. */
const under = (cwd: string, ids: readonly string[]) => ids.map((id) => ({ id, dir: cwd }));

describe("the record", () => {
  test("a good file reads back the same; every bad shape fails its check", () => {
    const good = { v: 1, folders: [{ cwd: "/srv/a", ids: [sid(1), sid(2)] }, { cwd: "/srv/b", ids: [sid(3)] }] };
    expect(releasedFrom(JSON.parse(JSON.stringify(good)))).toEqual(good as ReleasedFile);
    for (const bad of [
      null,
      [],
      { v: 2, folders: [] },
      { v: 1 },
      { v: 1, folders: [{ cwd: "relative", ids: [sid(1)] }] },
      { v: 1, folders: [{ cwd: "/srv/a\u0007", ids: [sid(1)] }] },
      { v: 1, folders: [{ cwd: "/srv/a", ids: [] }] },
      { v: 1, folders: [{ cwd: "/srv/a", ids: ["not-a-session"] }] },
      { v: 1, folders: [{ cwd: "/srv/a", ids: [sid(0xabc).toUpperCase()] }] },
      { v: 1, folders: [{ cwd: "/srv/a", ids: [sid(1), sid(1)] }] },
      { v: 1, folders: [{ cwd: "/srv/a", ids: [sid(1)] }, { cwd: "/srv/b", ids: [sid(1)] }] },
      { v: 1, folders: [{ cwd: "/srv/a", ids: [sid(1)] }, { cwd: "/srv/a", ids: [sid(2)] }] },
      { v: 1, folders: [{ cwd: "/srv/a", ids: Array.from({ length: RELEASED_LIMITS.perFolder + 1 }, (_, i) => sid(i)) }] },
    ])
      expect(() => releasedFrom(bad)).toThrow();
  });

  test("each id once: a release again from another folder moves it there, the newest last", () => {
    let f = withReleased(EMPTY, "/srv/a", under("/srv/a", [sid(1), sid(2), sid(2), "nope"]));
    expect(f.folders).toEqual([{ cwd: "/srv/a", ids: [sid(1), sid(2)] }]);
    f = withReleased(f, "/srv/b", under("/srv/b", [sid(2), sid(3)]));
    expect(f.folders).toEqual([
      { cwd: "/srv/a", ids: [sid(1)] },
      { cwd: "/srv/b", ids: [sid(2), sid(3)] },
    ]);
    f = withReleased(f, "/srv/a", under("/srv/a", [sid(4)]));
    expect(f.folders.map((x) => x.cwd)).toEqual(["/srv/b", "/srv/a"]);
    expect(withReleased(f, "/srv/a", [])).toBe(f);
  });

  test("a folder keeps its newest 2,000; the file its newest folders and ids, the oldest going first", () => {
    const many = Array.from({ length: RELEASED_LIMITS.perFolder + 5 }, (_, i) => sid(i));
    const one = withReleased(EMPTY, "/srv/a", under("/srv/a", many));
    expect(one.folders[0]!.ids.length).toBe(RELEASED_LIMITS.perFolder);
    expect(one.folders[0]!.ids[0]).toBe(sid(5));
    let f: ReleasedFile = EMPTY;
    for (let k = 0; k < 11; k++) f = withReleased(f, `/srv/f${k}`, under(`/srv/f${k}`, Array.from({ length: RELEASED_LIMITS.perFolder }, (_, i) => sid(k * 10_000 + i))));
    expect(f.folders.reduce((n, x) => n + x.ids.length, 0)).toBe(RELEASED_LIMITS.total);
    expect(f.folders.map((x) => x.cwd)).toEqual(Array.from({ length: 10 }, (_, k) => `/srv/f${k + 1}`));
    let g: ReleasedFile = EMPTY;
    for (let k = 0; k < RELEASED_LIMITS.folders + 3; k++) g = withReleased(g, `/srv/g${k}`, under(`/srv/g${k}`, [sid(k)]));
    expect(g.folders.length).toBe(RELEASED_LIMITS.folders);
    expect(g.folders[0]!.cwd).toBe("/srv/g3");
    expect(() => releasedFrom(g)).not.toThrow();
  });

  test("a transcript filed under another folder (a worktree chat's) keeps that folder with its id, and only its own", () => {
    const WT = "/data/kitespan/worktrees/k3m7q2x4ab/abcdefgh";
    let f = withReleased(EMPTY, "/srv/a", [
      { id: sid(1), dir: "/srv/a" },
      { id: sid(2), dir: WT },
    ]);
    expect(f.folders).toEqual([{ cwd: "/srv/a", ids: [sid(1), sid(2)], at: { [sid(2)]: WT } }]);
    expect(releasedFrom(JSON.parse(JSON.stringify(f)))).toEqual(f);
    // Released again from another folder, it moves there with its new folder; unreleased, its folder goes with it.
    f = withReleased(f, "/srv/b", [{ id: sid(2), dir: "/srv/b" }]);
    expect(f.folders).toEqual([
      { cwd: "/srv/a", ids: [sid(1)] },
      { cwd: "/srv/b", ids: [sid(2)] },
    ]);
    f = withReleased(f, "/srv/a", [{ id: sid(3), dir: WT }]);
    expect(withoutReleased(f, [sid(3)]).folders).toEqual([
      { cwd: "/srv/b", ids: [sid(2)] },
      { cwd: "/srv/a", ids: [sid(1)] },
    ]);
    for (const at of [{ [sid(9)]: WT }, { [sid(1)]: "relative" }, { [sid(1)]: "/srv/a" }, [WT], "x"]) expect(() => releasedFrom({ v: 1, folders: [{ cwd: "/srv/a", ids: [sid(1)], at }] })).toThrow();
  });

  test("unrelease takes ids out, and an emptied folder goes", () => {
    const f = withReleased(withReleased(EMPTY, "/srv/a", under("/srv/a", [sid(1), sid(2)])), "/srv/b", under("/srv/b", [sid(3)]));
    expect(withoutReleased(f, [sid(1), sid(3)]).folders).toEqual([{ cwd: "/srv/a", ids: [sid(2)] }]);
  });
});

describe("the file", () => {
  test("written 0600 through the atomic writer, read back after a reopen; a Continue's unrelease is kept too", async () => {
    const dir = fresh();
    const r = new ReleasedSessions({ dir, uid: ownUid() });
    await r.open();
    expect(r.of("/srv/a")).toEqual([]);
    await r.release("/srv/a", under("/srv/a", [sid(1), sid(2)]));
    expect(statSync(join(dir, RELEASED)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, RELEASED), "utf8"))).toEqual({ v: 1, folders: [{ cwd: "/srv/a", ids: [sid(1), sid(2)] }] });
    await r.unrelease([sid(1)]);
    await r.unrelease([sid(9)]);
    const again = new ReleasedSessions({ dir, uid: ownUid() });
    await again.open();
    expect(again.of("/srv/a")).toEqual(under("/srv/a", [sid(2)]));
    expect(again.of("/srv/b")).toEqual([]);
  });

  test("each session reads back with the folder that holds its transcript; a file written before that reads as the folder's", async () => {
    const dir = fresh();
    const WT = "/data/kitespan/worktrees/k3m7q2x4ab/abcdefgh";
    const r = new ReleasedSessions({ dir, uid: ownUid() });
    await r.open();
    await r.release("/srv/a", [
      { id: sid(1), dir: "/srv/a" },
      { id: sid(2), dir: WT },
    ]);
    const again = new ReleasedSessions({ dir, uid: ownUid() });
    await again.open();
    expect(again.of("/srv/a")).toEqual([
      { id: sid(1), dir: "/srv/a" },
      { id: sid(2), dir: WT },
    ]);
    expect(again.folderOf("/srv/a", sid(2))).toBe(WT);
    expect(again.folderOf("/srv/a", sid(1))).toBe("/srv/a");
    expect(again.folderOf("/srv/b", sid(2))).toBeNull();
    const old = fresh();
    writeFileSync(join(old, RELEASED), JSON.stringify({ v: 1, folders: [{ cwd: "/srv/a", ids: [sid(1)] }] }), { mode: 0o600 });
    const before = new ReleasedSessions({ dir: old, uid: ownUid() });
    await before.open();
    expect(before.of("/srv/a")).toEqual([{ id: sid(1), dir: "/srv/a" }]);
  });

  test("a file that fails its check, or is wider than 0600, is set aside as .bad and reads as none", async () => {
    for (const [text, mode] of [
      ['{"v":1,"folders":[{"cwd":"x","ids":[]}]}', 0o600],
      ["{not json", 0o600],
      [JSON.stringify({ v: 1, folders: [{ cwd: "/srv/a", ids: [sid(1)] }] }), 0o644],
    ] as const) {
      const dir = fresh();
      writeFileSync(join(dir, RELEASED), text, { mode });
      const aside: string[] = [];
      const r = new ReleasedSessions({ dir, uid: ownUid(), onSetAside: (p) => aside.push(p) });
      await r.open();
      expect(aside).toEqual([RELEASED]);
      expect(existsSync(join(dir, `${RELEASED}.bad`))).toBe(true);
      expect(r.of("/srv/a")).toEqual([]);
    }
  });
});
