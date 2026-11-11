// D60 and the model list (build checklist E8, L37): the list is host-wide for environments with no variables, but a
// variable such as ANTHROPIC_BASE_URL or CLAUDE_CODE_USE_BEDROCK can change it, so an environment with variables keeps
// its own record and has its own short read, which gets its variables; its list never answers for another project, and
// another's never answers for it. An environment whose variables cannot be read starts no read. Row 94's context
// windows ride on the same read: an environment with variables gets its windows from its own read, with its variables,
// kept with it, and a chat's figure takes no window that another list's read gave.
import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../../shared/protocol";
import type { EnvVar } from "../../server/agents/types";
import { ChatContexts, windowOf } from "../../server/chats/context";
import { ModelList } from "../../server/chats/models";
import { MemoryStore, projectRecord } from "../../server/chats/testing";
import type { ProjectRecord } from "../../server/store/types";

const HOST_A = "aaaaaaaaaa";
const HOST_C = "cccccccccc";
const BEDROCK = "bbbbbbbbbb";
const BROKEN = "dddddddddd";
const NOW = new Date("2026-11-03T12:00:00.000Z");

const row = (value: string): ModelInfo => ({ value, displayName: value, description: "", efforts: [], supportsAutoMode: false });
const kept = (list: string[], at: string) => ({ at, list: list.map(row) });
const BEDROCK_VARS: EnvVar[] = [{ name: "CLAUDE_CODE_USE_BEDROCK", value: "1" }];

function setup(prep: (p: Record<string, ProjectRecord>) => void = () => {}) {
  const store = new MemoryStore();
  const p: Record<string, ProjectRecord> = {
    [HOST_A]: projectRecord(HOST_A, "/srv/a"),
    [HOST_C]: projectRecord(HOST_C, "/srv/c"),
    [BEDROCK]: projectRecord(BEDROCK, "/srv/b"),
    [BROKEN]: projectRecord(BROKEN, "/srv/d"),
  };
  prep(p);
  store.projects = Object.values(p);
  const reads: { cwd: string; vars: readonly EnvVar[] }[] = [];
  const windowReads: { cwd: string; vars: readonly EnvVar[] }[] = [];
  let answer: (cwd: string) => ModelInfo[] = (cwd) => [row(`read-of-${cwd}`)];
  let gate: Promise<void> | null = null;
  const list = new ModelList({
    store,
    read: async (cwd, vars) => {
      reads.push({ cwd, vars: [...vars] });
      if (gate) await gate;
      return answer(cwd);
    },
    windows: async (cwd, vars) => {
      windowReads.push({ cwd, vars: [...vars] });
      return { [`window-of-${cwd}`]: vars.length ? 1_000_000 : 200_000 };
    },
    vars: (id) => (id === BEDROCK ? BEDROCK_VARS : id === BROKEN ? null : []),
    now: () => NOW,
  });
  return {
    store,
    list,
    reads,
    windowReads,
    setAnswer: (f: (cwd: string) => ModelInfo[]) => (answer = f),
    hold: () => {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

const values = (a: { models: ModelInfo[] }) => a.models.map((m) => m.value);

describe("each picker lists its own record (E8)", () => {
  test("two projects, one with variables: each lists its own; a third with none takes the host's list", async () => {
    const { list, reads } = setup((p) => {
      p[HOST_A]!.models = kept(["host-opus"], "2026-11-03T10:00:00.000Z");
      // Newer, but an environment with variables: never the host's list.
      p[BEDROCK]!.models = kept(["bedrock-opus"], "2026-11-03T11:00:00.000Z");
    });
    expect(values(await list.answer({ id: HOST_A, cwd: "/srv/a" }, true))).toEqual(["host-opus"]);
    expect(values(await list.answer({ id: BEDROCK, cwd: "/srv/b" }, true))).toEqual(["bedrock-opus"]);
    expect(values(await list.answer({ id: HOST_C, cwd: "/srv/c" }, true))).toEqual(["host-opus"]);
    expect(reads).toEqual([]);
  });

  test("an environment with variables and no record of its own reads its own list, with its variables", async () => {
    const { list, reads, store } = setup((p) => {
      p[HOST_A]!.models = kept(["host-opus"], "2026-11-03T10:00:00.000Z");
    });
    expect(values(await list.answer({ id: BEDROCK, cwd: "/srv/b" }, true))).toEqual(["read-of-/srv/b"]);
    expect(reads).toEqual([{ cwd: "/srv/b", vars: BEDROCK_VARS }]);
    expect(store.projects.find((p) => p.id === BEDROCK)!.models!.list.map((m) => m.value)).toEqual(["read-of-/srv/b"]);
    // The host's list is as it was.
    expect(values(await list.answer({ id: HOST_C, cwd: "/srv/c" }, true))).toEqual(["host-opus"]);
  });

  test("the host's read and an environment's own read never take each other's answer", async () => {
    const { list, reads, hold } = setup();
    const release = hold();
    const host = list.answer({ id: HOST_A, cwd: "/srv/a" }, true);
    const own = list.answer({ id: BEDROCK, cwd: "/srv/b" }, true);
    const host2 = list.answer({ id: HOST_C, cwd: "/srv/c" }, true);
    await Bun.sleep(5);
    release();
    expect(values(await host)).toEqual(["read-of-/srv/a"]);
    expect(values(await host2)).toEqual(["read-of-/srv/a"]);
    expect(values(await own)).toEqual(["read-of-/srv/b"]);
    expect(reads.map((r) => [r.cwd, r.vars.length])).toEqual([
      ["/srv/a", 0],
      ["/srv/b", 1],
    ]);
  });

  test("a live chat's list is kept with its own environment: against its own record, never as the host's", async () => {
    const { list, store } = setup((p) => {
      p[HOST_A]!.models = kept(["host-opus"], "2026-11-03T11:30:00.000Z");
    });
    // The same rows as the host's newest list, kept under an hour ago: an environment's own record still takes them.
    expect(await list.keep(BEDROCK, [row("host-opus")])).toBe(true);
    expect(await list.keep(HOST_C, [row("host-opus")])).toBe(false);
    expect(await list.keep(BEDROCK, [row("host-opus")])).toBe(false);
    expect(await list.keep(HOST_C, [row("other")])).toBe(true);
    expect(values(await list.answer({ id: HOST_A, cwd: "/srv/a" }, true))).toEqual(["other"]);
    expect(values(await list.answer({ id: BEDROCK, cwd: "/srv/b" }, true))).toEqual(["host-opus"]);
    expect(store.projects.find((p) => p.id === BEDROCK)!.models!.list.map((m) => m.value)).toEqual(["host-opus"]);
  });

  test("an environment whose variables cannot be read starts no read, and is not given the host's list", async () => {
    const { list, reads } = setup((p) => {
      p[HOST_A]!.models = kept(["host-opus"], "2026-11-03T10:00:00.000Z");
    });
    expect(await list.answer({ id: BROKEN, cwd: "/srv/d" }, true)).toEqual({ models: [], at: null });
    expect(reads).toEqual([]);
  });
});

describe("row 94's windows ride on each list's own read (D60)", () => {
  const windowsOf = (store: { projects: ProjectRecord[] }, id: string) => store.projects.find((p) => p.id === id)!.contextWindows;

  test("an environment with variables reads its windows with them and keeps them with itself; the host's read is not fresh for it", async () => {
    const { list, store, reads, windowReads } = setup();
    await list.refreshWindows({ id: HOST_A, cwd: "/srv/a" }, true);
    expect(windowReads).toEqual([{ cwd: "/srv/a", vars: [] }]);
    expect(windowsOf(store, HOST_A)).toEqual({ "window-of-/srv/a": 200_000 });
    // The host's windows were read in this server's last day: another project with none starts no read.
    await list.refreshWindows({ id: HOST_C, cwd: "/srv/c" }, true);
    expect(windowReads).toHaveLength(1);
    // An environment with variables has its own read, from the same process as its model list, with its variables.
    await list.refreshWindows({ id: BEDROCK, cwd: "/srv/b" }, true);
    expect(windowReads).toEqual([
      { cwd: "/srv/a", vars: [] },
      { cwd: "/srv/b", vars: BEDROCK_VARS },
    ]);
    expect(reads.at(-1)).toEqual({ cwd: "/srv/b", vars: BEDROCK_VARS });
    expect(windowsOf(store, BEDROCK)).toEqual({ "window-of-/srv/b": 1_000_000 });
    expect(windowsOf(store, HOST_A)).toEqual({ "window-of-/srv/a": 200_000 });
    await list.refreshWindows({ id: BEDROCK, cwd: "/srv/b" }, true);
    expect(windowReads).toHaveLength(2);
    // One whose variables cannot be read starts none.
    await list.refreshWindows({ id: BROKEN, cwd: "/srv/d" }, true);
    expect(windowReads).toHaveLength(2);
  });

  test("the model list's own read of an environment with variables keeps its windows too", async () => {
    const { list, store, windowReads } = setup();
    expect(values(await list.answer({ id: BEDROCK, cwd: "/srv/b" }, true))).toEqual(["read-of-/srv/b"]);
    expect(windowReads).toEqual([{ cwd: "/srv/b", vars: BEDROCK_VARS }]);
    expect(windowsOf(store, BEDROCK)).toEqual({ "window-of-/srv/b": 1_000_000 });
    expect(store.projects.filter((p) => p.contextWindows).map((p) => p.id)).toEqual([BEDROCK]);
  });

  test("a figure takes no window that another list's read gave (windowOf)", () => {
    const own = (id: string) => id === BEDROCK || id === BROKEN;
    const projects: Pick<ProjectRecord, "id" | "contextWindows">[] = [
      { id: HOST_A, contextWindows: { m: 200_000, host: 5 } },
      { id: HOST_C },
      { id: BEDROCK, contextWindows: { m: 1_000_000, own: 7 } },
      { id: BROKEN },
    ];
    expect([windowOf(projects, HOST_C, "m", own), windowOf(projects, BEDROCK, "m", own)]).toEqual([200_000, 1_000_000]);
    expect([windowOf(projects, HOST_C, "own", own), windowOf(projects, BEDROCK, "host", own), windowOf(projects, BROKEN, "m", own)]).toEqual([null, null, null]);
    // With no environment that has variables, any project's window answers, as row 94 has it.
    expect(windowOf(projects, HOST_C, "own")).toBe(7);
  });

  test("a sleeping chat of an environment with variables asks for its own read when only the host's list knows its model", async () => {
    const { list, store, windowReads } = setup((p) => {
      p[HOST_A]!.contextWindows = { "window-of-/srv/b": 200_000 };
    });
    const contexts = new ChatContexts({
      store,
      usage: async () => ({ model: "window-of-/srv/b", usedTokens: 100_000 }),
      refresh: (chat) => list.refreshWindows({ id: chat.project, cwd: chat.cwd }, true),
      own: (id) => list.own(id),
      now: () => NOW,
    });
    const chat = { project: BEDROCK, sessionId: "9f8a3e9b-9fac-4e1d-8f2a-3b4c5d6e7f80", cwd: "/srv/b" };
    expect((await contexts.answer(undefined, chat))?.maxTokens).toBe(1_000_000);
    expect(windowReads).toEqual([{ cwd: "/srv/b", vars: BEDROCK_VARS }]);
    // A chat of a project with none still takes the host's.
    expect((await contexts.answer(undefined, { ...chat, project: HOST_C, cwd: "/srv/c" }))?.maxTokens).toBe(200_000);
    expect(windowReads).toHaveLength(1);
  });
});

describe("a change of an environment's variables (ModelList.forget, called from the env route)", () => {
  const url = (v: readonly EnvVar[]) => v.find((x) => x.name === "ANTHROPIC_BASE_URL")?.value ?? "none";
  function changing() {
    let vars: EnvVar[] = [{ name: "ANTHROPIC_BASE_URL", value: "https://one.example" }];
    const store = new MemoryStore();
    store.projects = [projectRecord(BEDROCK, "/srv/b")];
    const reads: string[] = [];
    let fail = false;
    let gate: Promise<void> | null = null;
    const list = new ModelList({
      store,
      read: async (_cwd, v) => {
        reads.push(url(v));
        if (gate) await gate;
        if (fail) throw new Error("read failed");
        return [row(`list-of-${url(v)}`)];
      },
      windows: async (_cwd, v) => {
        if (gate) await gate;
        return { default: url(v) === "https://one.example" ? 200_000 : 1_000_000 };
      },
      vars: () => vars,
      now: () => NOW,
    });
    /** The values change, and the env route drops what the project kept (api.ts), then tells the list. */
    const change = (value: string) => {
      vars = [{ name: "ANTHROPIC_BASE_URL", value }];
      store.projects = store.projects.map(({ models: _m, contextWindows: _w, ...rest }) => rest);
      list.forget(BEDROCK);
    };
    const hold = () => {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    };
    return { store, list, reads, change, hold, failNext: (on: boolean) => (fail = on) };
  }
  const project = (store: MemoryStore) => store.projects.find((p) => p.id === BEDROCK)!;

  test("the day of the old values' windows goes: the next figure's refresh reads again, with the new values", async () => {
    const { store, list, reads, change } = changing();
    await list.refreshWindows({ id: BEDROCK, cwd: "/srv/b" }, true);
    expect(project(store).contextWindows).toEqual({ default: 200_000 });
    change("https://two.example");
    await list.refreshWindows({ id: BEDROCK, cwd: "/srv/b" }, true);
    expect(reads).toEqual(["https://one.example", "https://two.example"]);
    expect(project(store).contextWindows).toEqual({ default: 1_000_000 });
    expect(values(await list.answer({ id: BEDROCK, cwd: "/srv/b" }, true))).toEqual(["list-of-https://two.example"]);
  });

  test("the minute after a failed read goes: the next list reads at once, with the new values", async () => {
    const { list, reads, change, failNext } = changing();
    failNext(true);
    expect(await list.answer({ id: BEDROCK, cwd: "/srv/b" }, true)).toEqual({ models: [], at: null });
    expect(await list.answer({ id: BEDROCK, cwd: "/srv/b" }, true)).toEqual({ models: [], at: null });
    expect(reads).toEqual(["https://one.example"]);
    failNext(false);
    change("https://two.example");
    expect(values(await list.answer({ id: BEDROCK, cwd: "/srv/b" }, true))).toEqual(["list-of-https://two.example"]);
    expect(reads).toEqual(["https://one.example", "https://two.example"]);
  });

  test("a read in flight with the old values keeps nothing when it ends after the change", async () => {
    const { store, list, change, hold } = changing();
    const release = hold();
    const asked = list.answer({ id: BEDROCK, cwd: "/srv/b" }, true);
    await Bun.sleep(5);
    change("https://two.example");
    release();
    await asked;
    await Bun.sleep(5);
    expect([project(store).models ?? null, project(store).contextWindows ?? null]).toEqual([null, null]);
    expect(values(await list.answer({ id: BEDROCK, cwd: "/srv/b" }, true))).toEqual(["list-of-https://two.example"]);
    expect(project(store).contextWindows).toEqual({ default: 1_000_000 });
  });
});
