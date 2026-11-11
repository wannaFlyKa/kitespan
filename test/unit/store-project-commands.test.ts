// The project's last command list in the store (D59): kept with the project in projects.json, written as the row
// checks read it back (a name that cannot be a command is dropped, a long text cut, the list cut to its byte budget),
// read defensively (a bad list reads as none and never sets the projects file aside), and, as a cache, the first thing
// to go when the projects file would pass its cap: the oldest lists are dropped, never a project.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, type CommandInfo } from "../../shared/protocol";
import { projectCommandsForSave, projectCommandsFrom } from "../../server/store/commands";
import { createStore, FILE_CAPS } from "../../server/store/store";
import { STORE_LIMITS, type ProjectRecord } from "../../server/store/types";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-store-commands-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const T = "2026-11-02T10:00:00.000Z";
const row = (name: string, over: Partial<CommandInfo> = {}): CommandInfo => ({ name, description: `${name} it`, argumentHint: "", aliases: [], builtin: false, terminalOnly: false, ...over });
const ids = ["k3m7q2x4ab", "abcdefghij", "mnopqrstuv", "wxyz234567", "a2b3c4d5e6"];
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
    const list = [row("compact", { builtin: true }), row("exit", { builtin: true, terminalOnly: true }), row("review-notes", { argumentHint: "[file]", aliases: ["rn"] })];
    const rec = projectCommandsForSave(list, T);
    expect(rec).toEqual({ at: T, list });
    expect(projectCommandsFrom(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
  });

  test("written: a row whose name cannot be a command is dropped; long texts are cut; the list is cut to its budget", () => {
    const rec = projectCommandsForSave(
      [row(""), row("x".repeat(LIMITS.name + 1)), row("bad\nname"), row("ok", { description: "d".repeat(LIMITS.taskText + 50), argumentHint: "h".repeat(LIMITS.taskText + 1), aliases: ["a", "", "b".repeat(LIMITS.name + 1)] })],
      T,
    );
    expect(rec.list.map((c) => c.name)).toEqual(["ok"]);
    expect(rec.list[0]!.description.length).toBe(LIMITS.taskText);
    expect(rec.list[0]!.argumentHint.length).toBe(LIMITS.taskText);
    expect(rec.list[0]!.aliases).toEqual(["a"]);
    const many = Array.from({ length: STORE_LIMITS.projectCommands + 50 }, (_, i) => row(`c${i}`, { description: "" }));
    expect(projectCommandsForSave(many, T).list.length).toBe(STORE_LIMITS.projectCommands);
    const wide = Array.from({ length: 200 }, (_, i) => row(`w${i}`, { description: "y".repeat(LIMITS.taskText) }));
    const cut = projectCommandsForSave(wide, T);
    expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(STORE_LIMITS.projectCommandsBytes);
    expect(cut.list.length).toBeGreaterThan(10);
    expect(cut.list.map((c) => c.name)).toEqual(wide.slice(0, cut.list.length).map((c) => c.name));
  });

  test("read defensively: anything that is not such a record is none", () => {
    const good = { at: T, list: [row("compact")] };
    for (const bad of [undefined, null, 3, "x", [], {}, { at: "yesterday", list: [] }, { at: T }, { at: T, list: {} }, { ...good, list: [{ ...row("a"), builtin: "yes" }] }, { ...good, list: [{ ...row("a"), name: "" }] }, { ...good, list: [row("a"), 7] }, { at: T, list: Array.from({ length: STORE_LIMITS.projectCommands + 1 }, (_, i) => row(`c${i}`)) }]) {
      expect(projectCommandsFrom(bad)).toBeUndefined();
    }
    expect(projectCommandsFrom(good)).toEqual(good);
  });
});

describe("in projects.json", () => {
  test("kept with the project across a restart; other writers of the project keep it", async () => {
    const root = fresh();
    const store = createStore({ root });
    await store.open();
    const commands = { at: T, list: [row("compact", { builtin: true })] };
    await store.putProject(project(0, { commands }));
    const read = (await store.listProjects())[0]!;
    expect(read.commands).toEqual(commands);
    // A write of the record as read (the forget route, a new chat's picks) keeps it.
    await store.putProject({ ...read, lastUsedAt: "2026-11-02T11:00:00.000Z" });
    const again = createStore({ root });
    await again.open();
    expect((await again.listProjects())[0]).toEqual({ ...project(0, { lastUsedAt: "2026-11-02T11:00:00.000Z" }), commands });
  });

  test("a bad list in the file reads as none, and the projects file is not set aside", async () => {
    const root = fresh();
    const store = createStore({ root });
    await store.open();
    await store.putProject(project(0));
    await store.putProject(project(1));
    const file = join(store.dirs.state, "projects.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { projects: Record<string, unknown>[] };
    raw.projects[0]!.commands = { at: T, list: [{ name: 3 }] };
    raw.projects[1]!.commands = { at: T, list: [row("compact")] };
    writeFileSync(file, JSON.stringify(raw));
    const again = createStore({ root });
    const opened = await again.open();
    expect(opened.setAside).toEqual([]);
    expect(existsSync(`${file}.bad`)).toBe(false);
    const list = await again.listProjects();
    expect(list.map((p) => p.id)).toEqual(ids.slice(0, 2));
    expect("commands" in list[0]!).toBe(false);
    expect(list[1]!.commands).toEqual({ at: T, list: [row("compact")] });
  });

  test("over the file's cap, the oldest lists go first; every project stays", async () => {
    const big = (n: number) => Array.from({ length: 40 }, (_, i) => row(`p${n}-c${i}`, { description: "z".repeat(400) }));
    // The file with one project and its list, as the store writes it.
    const probe = createStore({ root: fresh() });
    await probe.open();
    await probe.putProject(project(0, { commands: projectCommandsForSave(big(0), T) }));
    const one = readFileSync(join(probe.dirs.state, "projects.json")).byteLength;
    // Room for four projects and two of the lists, not three.
    const root = fresh();
    const store = createStore({ root, projectsBytes: Math.floor(one * 2.5) });
    await store.open();
    const at = (h: number) => `2026-11-02T${String(h).padStart(2, "0")}:00:00.000Z`;
    for (let i = 0; i < 4; i++) await store.putProject(project(i, { commands: projectCommandsForSave(big(i), at(i + 1)) }));
    const list = await store.listProjects();
    expect(list.map((p) => p.id)).toEqual(ids.slice(0, 4));
    expect(list.map((p) => p.commands?.at ?? null)).toEqual([null, null, at(3), at(4)]);
    const again = createStore({ root, projectsBytes: Math.floor(one * 2.5) });
    await again.open();
    expect((await again.listProjects()).map((p) => p.commands?.at ?? null)).toEqual([null, null, at(3), at(4)]);
    expect(FILE_CAPS.projects).toBe(1024 * 1024);
  });

  test("a read shares the kept list, frozen, instead of copying it each time", async () => {
    const store = createStore({ root: fresh() });
    await store.open();
    await store.putProject(project(0, { commands: { at: T, list: [row("compact")] } }));
    const a = (await store.listProjects())[0]!;
    const b = (await store.listProjects())[0]!;
    expect(a).not.toBe(b);
    expect(a.commands).toBe(b.commands!);
    expect(Object.isFrozen(a.commands!.list[0])).toBe(true);
  });
});
