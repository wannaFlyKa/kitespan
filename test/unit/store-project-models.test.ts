// The kept model list in the store (row 81): kept with the project whose chat or read gave it, in projects.json, written
// as the row checks read it back (a row whose value cannot be a model is dropped, long texts cut, unknown effort levels
// left out, the list cut to its rows and bytes), read defensively (a bad list reads as none and never sets the projects
// file aside), and, as a cache, dropped before any project when the file would pass its cap (with the command lists,
// the oldest first).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, type ModelInfo } from "../../shared/protocol";
import { projectModelsForSave, projectModelsFrom, sameModels } from "../../server/store/models";
import { projectCommandsForSave } from "../../server/store/commands";
import { createStore } from "../../server/store/store";
import { STORE_LIMITS, type ProjectRecord } from "../../server/store/types";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-store-models-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const T = "2026-11-02T10:00:00.000Z";
const row = (value: string, over: Partial<ModelInfo> = {}): ModelInfo => ({ value, displayName: `Name of ${value}`, description: `${value} it`, efforts: ["low", "medium", "high"], supportsAutoMode: false, ...over });
const ids = ["k3m7q2x4ab", "abcdefghij", "mnopqrstuv", "wxyz234567"];
const project = (i: number, over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: ids[i]!,
  cwd: `/srv/work/app${i}`,
  name: `app${i}`,
  createdAt: T,
  lastUsedAt: T,
  picks: { model: null, effort: null, permissionMode: null },
  ...over,
});

describe("the list's record", () => {
  test("a list as Claude Code gave it is kept as is, and reads back the same", () => {
    const list = [row("default"), row("claude-opus-5-5", { efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true }), row("claude-haiku-5-5", { efforts: [] })];
    const rec = projectModelsForSave(list, T);
    expect(rec).toEqual({ at: T, list });
    expect(projectModelsFrom(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
    expect(sameModels(rec.list, list)).toBe(true);
    expect(sameModels(rec.list, list.slice(1))).toBe(false);
  });

  test("written: a row whose value cannot be a model is dropped; long texts are cut; unknown effort levels left out; the caps", () => {
    const rec = projectModelsForSave(
      [
        row(""),
        row("x".repeat(LIMITS.name + 1)),
        row("bad\nvalue"),
        row("ok", { displayName: "n".repeat(LIMITS.name + 9), description: "d".repeat(LIMITS.taskText + 50), efforts: ["low", "turbo", "high", "low"] as never, supportsAutoMode: "yes" as never }),
      ],
      T,
    );
    expect(rec.list.map((m) => m.value)).toEqual(["ok"]);
    expect(rec.list[0]!.displayName.length).toBe(LIMITS.name);
    expect(rec.list[0]!.description.length).toBe(LIMITS.taskText);
    expect(rec.list[0]!.efforts).toEqual(["low", "high"]);
    expect(rec.list[0]!.supportsAutoMode).toBe(false);
    const many = Array.from({ length: STORE_LIMITS.projectModels + 20 }, (_, i) => row(`m${i}`));
    expect(projectModelsForSave(many, T).list.length).toBe(STORE_LIMITS.projectModels);
    const wide = Array.from({ length: 60 }, (_, i) => row(`w${i}`, { description: "y".repeat(LIMITS.taskText) }));
    const cut = projectModelsForSave(wide, T);
    expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(STORE_LIMITS.projectModelsBytes);
    expect(cut.list.length).toBeGreaterThan(5);
    expect(cut.list.map((m) => m.value)).toEqual(wide.slice(0, cut.list.length).map((m) => m.value));
  });

  test("read defensively: anything that is not exactly such a record is none", () => {
    const good = { at: T, list: [row("default")] };
    for (const bad of [
      undefined,
      null,
      3,
      "x",
      [],
      {},
      { at: "yesterday", list: [] },
      { at: T },
      { at: T, list: {} },
      { ...good, list: [{ ...row("a"), supportsAutoMode: "yes" }] },
      { ...good, list: [{ ...row("a"), value: "" }] },
      { ...good, list: [{ ...row("a"), efforts: ["turbo"] }] },
      { ...good, list: [{ ...row("a"), efforts: "low" }] },
      { ...good, list: [{ ...row("a"), description: 7 }] },
      { ...good, list: [row("a"), 7] },
      { at: T, list: Array.from({ length: STORE_LIMITS.projectModels + 1 }, (_, i) => row(`m${i}`)) },
    ]) {
      expect(projectModelsFrom(bad)).toBeUndefined();
    }
    expect(projectModelsFrom(good)).toEqual(good);
  });
});

describe("in projects.json", () => {
  test("kept with the project across a restart; other writers of the project keep it", async () => {
    const root = fresh();
    const store = createStore({ root });
    await store.open();
    const models = { at: T, list: [row("default"), row("claude-opus-5-5")] };
    await store.putProject(project(0, { models }));
    const read = (await store.listProjects())[0]!;
    expect(read.models).toEqual(models);
    await store.putProject({ ...read, lastUsedAt: "2026-11-02T11:00:00.000Z" });
    const again = createStore({ root });
    await again.open();
    expect((await again.listProjects())[0]).toEqual({ ...project(0, { lastUsedAt: "2026-11-02T11:00:00.000Z" }), models });
  });

  test("a bad list in the file reads as none, and the projects file is not set aside", async () => {
    const root = fresh();
    const store = createStore({ root });
    await store.open();
    await store.putProject(project(0));
    await store.putProject(project(1));
    const file = join(store.dirs.state, "projects.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { projects: Record<string, unknown>[] };
    raw.projects[0]!.models = { at: T, list: [{ value: 3 }] };
    raw.projects[1]!.models = { at: T, list: [row("default")] };
    writeFileSync(file, JSON.stringify(raw));
    const again = createStore({ root });
    const opened = await again.open();
    expect(opened.setAside).toEqual([]);
    expect(existsSync(`${file}.bad`)).toBe(false);
    const list = await again.listProjects();
    expect(list.map((p) => p.id)).toEqual(ids.slice(0, 2));
    expect("models" in list[0]!).toBe(false);
    expect(list[1]!.models).toEqual({ at: T, list: [row("default")] });
  });

  test("over the file's cap, the oldest kept lists go first, of either kind; every project stays", async () => {
    const big = (n: number) => Array.from({ length: 20 }, (_, i) => row(`p${n}-m${i}`, { description: "z".repeat(400) }));
    const probe = createStore({ root: fresh() });
    await probe.open();
    await probe.putProject(project(0, { models: projectModelsForSave(big(0), T) }));
    const one = readFileSync(join(probe.dirs.state, "projects.json")).byteLength;
    const root = fresh();
    const store = createStore({ root, projectsBytes: Math.floor(one * 2.5) });
    await store.open();
    const at = (h: number) => `2026-11-02T${String(h).padStart(2, "0")}:00:00.000Z`;
    for (let i = 0; i < 4; i++) await store.putProject(project(i, { models: projectModelsForSave(big(i), at(i + 1)) }));
    const list = await store.listProjects();
    expect(list.map((p) => p.id)).toEqual(ids);
    expect(list.map((p) => p.models?.at ?? null)).toEqual([null, null, at(3), at(4)]);
    // A command list older than every model list goes before them.
    const mixed = createStore({ root: fresh(), projectsBytes: Math.floor(one * 2.5) });
    await mixed.open();
    const commands = Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, description: "z".repeat(400), argumentHint: "", aliases: [], builtin: true, terminalOnly: false }));
    await mixed.putProject(project(0, { commands: projectCommandsForSave(commands, at(1)) }));
    await mixed.putProject(project(1, { models: projectModelsForSave(big(1), at(2)) }));
    await mixed.putProject(project(2, { models: projectModelsForSave(big(2), at(3)) }));
    const after = await mixed.listProjects();
    expect(after.map((p) => p.commands?.at ?? null)).toEqual([null, null, null]);
    expect(after.map((p) => p.models?.at ?? null)).toEqual([null, at(2), at(3)]);
  });

  test("a read shares the kept list, frozen, instead of copying it each time", async () => {
    const store = createStore({ root: fresh() });
    await store.open();
    await store.putProject(project(0, { models: { at: T, list: [row("default")] } }));
    const a = (await store.listProjects())[0]!;
    const b = (await store.listProjects())[0]!;
    expect(a).not.toBe(b);
    expect(a.models).toBe(b.models!);
    expect(Object.isFrozen(a.models!.list[0])).toBe(true);
    expect(Object.isFrozen(a.models!.list[0]!.efforts)).toBe(true);
  });
});
