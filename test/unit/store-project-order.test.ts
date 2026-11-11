// Row 99 in the store: a project's place in the sidebar (`order`, absent until the user moves an environment), read
// defensively (a bad value reads as none and never sets the projects file aside); several projects in one write of
// projects.json (a move); and Remove, which takes one project and its new-chat form's upload records out, and drops a
// later write of that id, so a cache write that read the project before never brings it back.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFrom, projectsFrom } from "../../server/store/records";
import { createStore } from "../../server/store/store";
import { MemoryStore, uploadRecord } from "../../server/chats/testing";
import type { ProjectRecord, Store, UploadRecord } from "../../server/store/types";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-store-order-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const T = "2026-11-03T10:00:00.000Z";
const ids = ["k3m7q2x4ab", "abcdefghij", "mnopqrstuv"] as const;
const project = (i: number, over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: ids[i]!,
  cwd: `/srv/work/app${i}`,
  name: `app${i}`,
  createdAt: T,
  lastUsedAt: T,
  picks: { model: null, effort: null, permissionMode: null },
  ...over,
});

function upload(id: string, chat: string | null, projectId: string): UploadRecord {
  const dir = `/tmp/kitespan-order-test/u-${id.slice(0, 6)}`;
  return { ...uploadRecord(id, chat, projectId), dir, path: `${dir}/notes.txt` };
}

describe("the record's order", () => {
  test("absent stays absent; a safe integer is kept, negative ones too", () => {
    expect("order" in projectFrom(project(0))).toBe(false);
    expect(projectFrom(project(0, { order: 0 })).order).toBe(0);
    expect(projectFrom(project(0, { order: 3 })).order).toBe(3);
    expect(projectFrom(project(0, { order: -2 })).order).toBe(-2);
  });

  test("a bad order reads as none and never fails the project or the file", () => {
    for (const bad of [1.5, "2", null, Number.NaN, 2 ** 60, true, {}, []]) {
      const rec = projectFrom({ ...project(0), order: bad });
      expect("order" in rec).toBe(false);
      expect(rec.name).toBe("app0");
    }
    const file = projectsFrom({ v: 1, projects: [{ ...project(0), order: "x" }, { ...project(1), order: 1 }] });
    expect(file.projects.map((p) => p.order)).toEqual([undefined, 1]);
  });
});

describe("the file store", () => {
  test("putProjects writes several projects in one write, and they read back after a reopen", async () => {
    const root = fresh();
    const writes: string[] = [];
    const s = createStore({ root, onWrite: (p) => writes.push(p) });
    await s.open();
    await s.putProject(project(0));
    await s.putProject(project(1));
    writes.length = 0;
    await s.putProjects([project(0, { order: 1 }), project(1, { order: 0, name: "renamed" }), project(2, { order: 2 })]);
    expect(writes).toEqual(["projects.json"]);
    const again = createStore({ root });
    await again.open();
    const list = await again.listProjects();
    expect(list.map((p) => [p.id, p.order, p.name])).toEqual([
      [ids[0], 1, "app0"],
      [ids[1], 0, "renamed"],
      [ids[2], 2, "app2"],
    ]);
  });

  test("putProjects refuses a folder that another project has, and changes nothing", async () => {
    const s = createStore({ root: fresh() });
    await s.open();
    await s.putProject(project(0));
    await expect(s.putProjects([project(1, { cwd: project(0).cwd })])).rejects.toThrow();
    expect((await s.listProjects()).map((p) => p.id)).toEqual([ids[0]]);
  });

  test("removeProject takes the project and its form's uploads out; a later write of its id is dropped", async () => {
    const root = fresh();
    const s = createStore({ root });
    await s.open();
    await s.putProject(project(0));
    await s.putProject(project(1));
    await s.putUpload(upload("formupload2abcde", null, ids[0]!));
    await s.putUpload(upload("otherupload2abcd", null, ids[1]!));
    const gone = await s.removeProject(ids[0]!);
    expect(gone?.id).toBe(ids[0]);
    expect((await s.listProjects()).map((p) => p.id)).toEqual([ids[1]]);
    expect((await s.listUploads(null)).map((u) => u.id)).toEqual(["otherupload2abcd"]);
    // A cache write (models, context windows, the kept facts) that read the project before Remove.
    await s.putProject({ ...project(0), name: "late" });
    await s.putProjects([{ ...project(0), order: 0 }, { ...project(1), order: 1 }]);
    expect((await s.listProjects()).map((p) => [p.id, p.order])).toEqual([[ids[1], 1]]);
    expect(await s.removeProject(ids[0]!)).toBeNull();
    const file = JSON.parse(readFileSync(join(root, "state", "projects.json"), "utf8"));
    expect(file.projects.map((p: ProjectRecord) => p.id)).toEqual([ids[1]]);
    const again = createStore({ root });
    await again.open();
    expect((await again.listProjects()).map((p) => p.id)).toEqual([ids[1]]);
  });

  test("a projects file with an order field from a later version, or a bad one, still opens", async () => {
    const root = fresh();
    const s = createStore({ root });
    await s.open();
    await s.putProject(project(0));
    const path = join(root, "state", "projects.json");
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.projects[0].order = "first";
    writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
    const again = createStore({ root });
    const opened = await again.open();
    expect(opened.setAside).toEqual([]);
    expect((await again.listProjects()).map((p) => [p.id, p.order])).toEqual([[ids[0], undefined]]);
  });
});

describe("the memory store (the registry's tests) keeps the same rules", () => {
  test("putProjects and removeProject", async () => {
    const s: Store = new MemoryStore();
    await s.putProjects([project(0, { order: 0 }), project(1, { order: 1 })]);
    await s.putUpload(upload("formupload2abcde", null, ids[0]!));
    expect((await s.removeProject(ids[0]!))?.id).toBe(ids[0]);
    await s.putProject(project(0));
    expect((await s.listProjects()).map((p) => p.id)).toEqual([ids[1]]);
    expect(await s.listUploads(null)).toEqual([]);
  });
});
