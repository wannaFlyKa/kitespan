// The demo's data and words (site/demo/, DESIGN-W1 2): only the click-through seed's public words, as the real server
// sends them, in the demo machine's own folders. No URL of another site, no http, no path in a real machine's home
// folders and no name of the machine the test runs on; the seed's ids, titles and picks; every event within the protocol's caps; the changes
// summary and its diffs in step; the start routes as the route table reads them; and the lines as DESIGN-W1 2.3 has them.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { changedFileOf, changesCardOf } from "../../shared/changes";
import { CHAT_ID, PROJECT_ID, UUID } from "../../shared/ids";
import { capEvent, type ChatEvent } from "../../shared/protocol";
import { ROUTE_BY_NAME, parsePath } from "../../shared/route";
import { CHANGES_DIFFS, CHANGES_SUMMARY } from "../../site/demo/data/changes";
import { COMMANDS } from "../../site/demo/data/catalog";
import { DEMO_CHATS } from "../../site/demo/data/chats";
import { EXAMPLE_HISTORY, EXAMPLE_PERMISSION, WAITING_TURN_USER } from "../../site/demo/data/example";
import { PROJECTS, PROJECT_FILES, SUGGESTED_FOLDERS } from "../../site/demo/data/projects";
import { DEMO_DEVICES, DEMO_LINES, DEMO_REPLIES, DEMO_ROOT, EXAMPLE_CARD, EXAMPLE_CHANGES, EXAMPLE_CHAT, START_ROUTES, demoDevice } from "../../site/demo/lines";
import { CHATS, PROJECTS as SEED_PROJECTS, PROJECT_FILES as SEED_FILES } from "../click/seed/demo";
import { EX, IDS } from "../click/seed/ids";

const DEMO = resolve(import.meta.dir, "..", "..", "site", "demo");
/** The folder of a Linux machine's home folders, spelled so that this file names no such path itself. */
const HOMES = ["", "home", ""].join("/");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const sources = filesUnder(DEMO).map((f) => ({ file: f.slice(DEMO.length + 1), text: readFileSync(f, "utf8") }));

/** Every string inside a value, for the path rules. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

describe("nothing of another site and nothing of this machine", () => {
  test("no URL and no http anywhere in site/demo/", () => {
    for (const s of sources) expect({ file: s.file, hits: s.text.match(/\b(https?|wss?):\/\/[^\s"'`)]*/g) ?? [] }).toEqual({ file: s.file, hits: [] });
  });

  test("no path of a real home folder, and no name of the machine or the user that runs this test", () => {
    const names = [hostname().split(".")[0]!, userInfo().username].filter((n) => n.length >= 4);
    for (const s of sources) {
      expect({ file: s.file, home: s.text.includes(HOMES) }).toEqual({ file: s.file, home: false });
      for (const n of names) expect({ file: s.file, name: s.text.toLowerCase().includes(n.toLowerCase()) }).toEqual({ file: s.file, name: false });
    }
  });

  test("every absolute path in the data is the demo machine's: its home folder /work, its claude, its upload folder", () => {
    const all = strings([DEMO_CHATS, CHANGES_DIFFS, CHANGES_SUMMARY, PROJECTS, SUGGESTED_FOLDERS, EXAMPLE_PERMISSION]);
    const paths = all.flatMap((s) => s.match(/(?<![\w.])\/[A-Za-z][\w.-]*(?:\/[\w.-]+)+/g) ?? []);
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) expect({ p, ok: p.startsWith("/work/") || p === "/upload/file" }).toEqual({ p, ok: true });
    expect(DEMO_ROOT).toBe("/work/kitespan");
  });

  test("the commands are Claude Code's own: no plugin's command and no user's own", () => {
    expect(COMMANDS.length).toBeGreaterThan(5);
    for (const c of COMMANDS) expect({ name: c.name, builtin: c.builtin, plain: /^[a-z-]+$/.test(c.name) }).toEqual({ name: c.name, builtin: true, plain: true });
  });
});

describe("the seed's chats, ids and projects", () => {
  test("the ids are the route examples' and the seed's", () => {
    expect(EXAMPLE_CHAT).toBe(EX.chat);
    expect(EXAMPLE_CARD).toBe(EX.toolUse);
    expect(EXAMPLE_PERMISSION.id).toBe(EX.toolUse);
    const changes = parsePath(ROUTE_BY_NAME.changesTurn!.example);
    expect(changes.params.turn).toBe(EXAMPLE_CHANGES);
    expect(CHANGES_SUMMARY.id).toBe(EXAMPLE_CHANGES);
    expect(PROJECTS.map((p) => p.id).sort()).toEqual(Object.values(IDS.projects).sort());
    expect(UUID.test(WAITING_TURN_USER)).toBe(true);
  });

  test("each chat is the seed's: its id, project, title, picks, session, archive and last activity", () => {
    expect(DEMO_CHATS.map((c) => c.chat).sort()).toEqual(CHATS.map((c) => c.id).sort());
    const projectId = Object.fromEntries(SEED_PROJECTS.map((p) => [p.key, p.id]));
    for (const seed of CHATS) {
      const c = DEMO_CHATS.find((x) => x.chat === seed.id)!;
      expect(CHAT_ID.test(c.chat) && PROJECT_ID.test(c.project)).toBe(true);
      expect({ id: c.chat, project: c.project, title: c.title, picks: c.picks, session: c.session ?? null, archived: c.archived }).toEqual({
        id: seed.id,
        project: projectId[seed.project]!,
        title: { text: seed.title, from: seed.from },
        picks: { model: seed.picks.model ?? null, effort: seed.picks.effort ?? null, mode: seed.picks.mode ?? null },
        session: seed.sessionId,
        archived: !!seed.archived,
      } as never);
      // The example chat's card waits now; the others keep the seed's times.
      expect(c.agoMin).toBe(seed.id === EXAMPLE_CHAT ? 0 : seed.lastActivity);
    }
  });

  test("the projects are the seed's, in /work, with the seed's files", () => {
    for (const seed of SEED_PROJECTS) {
      const p = PROJECTS.find((x) => x.id === seed.id)!;
      expect(p.name).toBe(seed.name);
      expect(p.cwd).toBe(`/work/${seed.name}`);
      expect(PROJECT_FILES[p.id]!.slice().sort()).toEqual(Object.keys(SEED_FILES[seed.key]).sort());
    }
    expect(PROJECTS[0]!.id).toBe(IDS.projects.kitespan);
  });
});

describe("the events, the changes and the card", () => {
  const all: { chat: string; e: ChatEvent }[] = DEMO_CHATS.flatMap((c) => c.history.map((e) => ({ chat: c.chat, e })));

  test("every event of every chat's history is within the protocol's caps", () => {
    expect(all.length).toBeGreaterThan(40);
    for (const { chat, e } of all) expect({ chat, k: e.k, capped: Bun.deepEquals(capEvent(e), e) }).toEqual({ chat, k: e.k, capped: true });
  });

  test("the example chat: the fix, its changes card, then the turn that waits on the Bash card", () => {
    expect(DEMO_CHATS.find((c) => c.chat === EXAMPLE_CHAT)!.history).toBe(EXAMPLE_HISTORY);
    const card = EXAMPLE_HISTORY.find((e) => e.k === "changes");
    expect(card && changesCardOf(card)).toEqual({ id: EXAMPLE_CHANGES, at: CHANGES_SUMMARY.at, how: "git", total: 3, added: 18, removed: 4, files: CHANGES_SUMMARY.files });
    const last = EXAMPLE_HISTORY.at(-1)!;
    expect(last).toMatchObject({ k: "tool_call", id: EXAMPLE_CARD, name: "Bash", input: EXAMPLE_PERMISSION.input });
    expect(EXAMPLE_HISTORY.filter((e) => e.k === "user").at(-1)).toMatchObject({ uuid: WAITING_TURN_USER, text: "Clean the build folder and rebuild, then run the test once more." });
    // One row per tool-use id: the example id is the waiting call's alone.
    const ids = EXAMPLE_HISTORY.flatMap((e) => (e.k === "tool_call" ? [e.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the summary's files are its diffs, and each diff's counts are its lines", () => {
    expect(Object.keys(CHANGES_DIFFS).sort()).toEqual(CHANGES_SUMMARY.files.map((f) => f.path).sort());
    for (const f of CHANGES_SUMMARY.files) {
      expect(changedFileOf(f)).toEqual(f);
      const d = CHANGES_DIFFS[f.path]!;
      const lines = d.hunks.flatMap((h) => h.lines);
      expect({ path: f.path, added: lines.filter((l) => l.startsWith("+")).length, removed: lines.filter((l) => l.startsWith("-")).length }).toEqual({ path: f.path, added: f.added, removed: f.removed });
    }
  });
});

describe("the words and the routes", () => {
  test("each line is one short sentence, and the replies are the design's", () => {
    for (const [k, l] of Object.entries(DEMO_LINES)) expect({ k, ok: /^[A-Z][^.]*\.$/.test(l) && l.length <= 60 }).toEqual({ k, ok: true });
    expect(DEMO_LINES.terminal).toBe("The Terminal pane does not run in this demo.");
    expect(DEMO_REPLIES.en.startsWith("This is a demo with made-up chats, so nothing ran.")).toBe(true);
    expect(DEMO_REPLIES["zh-CN"]).toContain("Claude Code");
    // The Chinese reply opens as the page's own note words it (对话都是虚构的), not with a long attributive.
    expect(DEMO_REPLIES["zh-CN"].startsWith("这是一个演示，对话都是虚构的，所以什么都没有真正运行。")).toBe(true);
    for (const r of Object.values(DEMO_REPLIES)) expect(r).toContain("Claude Code");
  });

  test("each device starts on its route, as the route table reads it", () => {
    for (const d of DEMO_DEVICES) {
      const r = parsePath(START_ROUTES[d]);
      expect({ d, fallback: r.fallbackFrom ?? null, chat: r.params.chat }).toEqual({ d, fallback: null, chat: EXAMPLE_CHAT });
    }
    const laptop = parsePath(START_ROUTES.laptop);
    expect(laptop.name).toBe("changesFile");
    expect(laptop.params).toMatchObject({ turn: EXAMPLE_CHANGES, path: "src/upload.ts" });
    expect(laptop.query.below).toBe("details");
    expect(parsePath(START_ROUTES.phone).name).toBe("chat");
  });

  test("a frame's device is read from its query; anything else is the full-width one", () => {
    expect(demoDevice("?device=phone")).toBe("phone");
    expect(demoDevice("?device=laptop&x=1")).toBe("laptop");
    for (const q of ["", "?device=tablet", "?device="]) expect(demoDevice(q)).toBe("auto");
  });
});
