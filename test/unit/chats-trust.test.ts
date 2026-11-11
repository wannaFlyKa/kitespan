// R127 (owner rows 126, 127, 129; DESIGN-R127 sections 7 and 8): Trust this folder in the chat registry. A refused row
// (a tool result whose `trust` the driver set) is noted with the repository root that the server's own file reads find;
// `trust_folder` passes the checks in their order (the chat, the row and its path, the path's text, the folder on
// disk, the home folder, one start per folder, an answer of this boot) and then starts the agent's trust start once.
// Its state goes to every chat that holds a refused row of the folder, as `trust` events, and to a page that attaches,
// as `attached.trust`. One log line per answer holds the path and the answer only. The scripted driver stands in for
// Claude Code; the folders are real, in a scratch folder.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatEvent, TrustRef } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import type { Outcome, RegistryOptions } from "../../server/chats/types";
import type { LogEvent, LogFields, Logger } from "../../server/log";
import type { ChatLedger } from "../../server/store/types";
// The scratch repositories' own git, with no global or system config (worktree-repo.ts).
import { git } from "./worktree-repo";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "chats-trust-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const HOME = join(ROOT, "home", "you");
const SHOP = join(HOME, "projects", "shop");
/** A new repository nested in the project (the owner's case): it keys on itself, so no root. */
const NESTED = join(SHOP, "tasks", "remove-negative-qty");
/** A plain subfolder of the repository: trusting it trusts the repository, so the root is the shop. */
const INSIDE = join(SHOP, "tasks", "search-index");
const PLAIN = join(ROOT, "scratch", "plain");
const GONE = join(ROOT, "scratch", "gone");
const LINK = join(ROOT, "scratch", "link");
const FILE = join(ROOT, "scratch", "notes.txt");
for (const d of [join(SHOP, ".git"), join(NESTED, ".git"), INSIDE, PLAIN, join(LINK, "..")]) mkdirSync(d, { recursive: true });
symlinkSync(NESTED, LINK);
writeFileSync(FILE, "x");

const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const OTHER = "otherchat2abcdefghij";
const THIRD = "thirdchat2abcdefghij";
const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SID2 = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const SID3 = "1c2d3e4f-5061-4b7c-8d9e-0f1a2b3c4d5e";
const rid = () => crypto.randomUUID();

function ledger(over: Partial<ChatLedger> = {}): ChatLedger {
  return {
    v: 1,
    id: CHAT,
    project: PROJECT,
    cwd: SHOP,
    agent: "claude-code",
    sessionId: SID,
    transcript: true,
    title: { text: "Negative quantity investigator", from: "first-prompt" },
    picks: { model: null, effort: null, permissionMode: null },
    createdAt: "2026-11-05T08:00:00.000Z",
    seenAt: "2026-11-05T08:00:00.000Z",
    lastActivityAt: "2026-11-05T08:00:00.000Z",
    lastSeq: 0,
    state: "sleeping",
    lastExit: null,
    archivedAt: null,
    ...over,
  };
}

/** A history with one refused Bash row for each folder, under `bg-<n>`. */
function refusedHistory(prefix: string, folders: string[]): ChatEvent[] {
  const out: ChatEvent[] = [{ k: "user", uuid: `${prefix}-u`, text: "Stage the task folder and start the investigator.", queued: false }];
  folders.forEach((f, i) => {
    const id = `${prefix}-bg-${i}`;
    out.push({ k: "tool_call", id, name: "Bash", input: { command: `cd ${f} && claude --bg` }, parent: null });
    out.push({ k: "tool_result", id, text: `Exit code 1\nWorkspace not trusted. Run \`claude\` in ${f} once and accept the trust prompt, then retry.`, isError: true, parent: null, report: null, trust: { path: f, root: null } });
  });
  out.push({ k: "block", key: `${prefix}-m:0`, kind: "text", text: "The investigator did not start.", parent: null });
  out.push({ k: "turn_end", ok: true, subtype: "success", durationMs: 5, error: null, uuids: [`${prefix}-u`] });
  return out;
}

class LogSpy implements Logger {
  readonly lines: { ev: LogEvent; f: LogFields }[] = [];
  failures = 0;
  log(ev: LogEvent, f: LogFields = {}): void {
    this.lines.push({ ev, f: { ...f } });
  }
  sweep(): number {
    return 0;
  }
  close(): void {}
}

async function setup(opts: RegistryOptions = {}, folders: { chat?: string[]; other?: string[]; third?: string[] } = {}) {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  const log = new LogSpy();
  store.projects = [projectRecord(PROJECT, SHOP)];
  store.chats.set(CHAT, ledger());
  store.chats.set(OTHER, ledger({ id: OTHER, sessionId: SID2 }));
  store.chats.set(THIRD, ledger({ id: THIRD, sessionId: SID3 }));
  driver.transcript(SID, "Stage it", SHOP);
  driver.transcript(SID2, "Stage it", SHOP);
  driver.transcript(SID3, "Stage it", SHOP);
  driver.histories.set(SID, refusedHistory("c", folders.chat ?? [NESTED, INSIDE, PLAIN, GONE, LINK, FILE]));
  driver.histories.set(SID2, refusedHistory("o", folders.other ?? [NESTED]));
  driver.histories.set(SID3, refusedHistory("t", folders.third ?? []));
  const reg = new ChatRegistry({ driver, store, log, trustHomes: () => [HOME] }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, ...opts });
  await reg.boot();
  return { driver, store, log, reg };
}

type World = Awaited<ReturnType<typeof setup>>;

/** A page on `chat`: its snapshot read the history, so the server noted the chat's refused rows. */
async function page(w: World, chat = CHAT) {
  const v = new RecordingViewer();
  const p = await w.reg.attach(chat, v);
  if (!p) throw new Error("no such chat");
  return { v, attached: p.attached, history: p.snapshot.history };
}

const trust = (w: World, toolUse: string, path: string, chat = CHAT) => apply(w.reg, { t: "trust_folder", rid: rid(), chat, toolUse, path });
const answer = (o: Outcome) => (o.ok ? (o.result as { trust: string }).trust : `error ${o.code}${o.reason ? ` ${o.reason}` : ""}`);
const trustEvents = (v: RecordingViewer) => v.events.filter((e) => e.k === "trust").map((e) => (e.k === "trust" ? `${e.path} ${e.state}` : ""));
const refOf = (history: ChatEvent[], id: string): TrustRef | undefined => (history.find((e) => e.k === "tool_result" && e.id === id) as { trust?: TrustRef } | undefined)?.trust;

describe("noting a refused row", () => {
  test("history: each refused row carries its folder and the repository root that holds it, when that is another folder", async () => {
    const w = await setup();
    const { history } = await page(w);
    expect(refOf(history, "c-bg-0")).toEqual({ path: NESTED, root: null });
    expect(refOf(history, "c-bg-1")).toEqual({ path: INSIDE, root: SHOP });
    expect(refOf(history, "c-bg-2")).toEqual({ path: PLAIN, root: null });
    expect(w.reg.trustRowPath(CHAT, "c-bg-1")).toBe(INSIDE);
    expect(w.reg.trustRowPath(CHAT, "c-nothing")).toBeNull();
    expect(w.reg.trustRowPath(OTHER, "c-bg-1")).toBeNull();
  });

  test("live: a refused row of the main thread or of a subagent gets its root before any page sees it", async () => {
    const w = await setup({}, { chat: [] });
    autoReply(w.driver);
    const { v } = await page(w);
    await apply(w.reg, { t: "send", rid: rid(), chat: CHAT, uuid: crypto.randomUUID(), text: "go", draftRev: null, uploads: [] });
    await settle(20);
    w.driver.last.emit(
      { k: "tool_call", id: "live-bg", name: "Bash", input: { command: "claude --bg" }, parent: null },
      { k: "tool_result", id: "live-bg", text: "x", isError: true, parent: null, report: null, trust: { path: INSIDE, root: null } },
      { k: "tool_result", id: "sub-bg", text: "x", isError: true, parent: "toolu_agent", report: null, trust: { path: NESTED, root: null } },
    );
    await settle(20);
    const results = v.events.filter((e) => e.k === "tool_result") as { id: string; trust?: TrustRef }[];
    expect(results.find((e) => e.id === "live-bg")?.trust).toEqual({ path: INSIDE, root: SHOP });
    expect(results.find((e) => e.id === "sub-bg")?.trust).toEqual({ path: NESTED, root: null });
    expect(w.reg.trustRowPath(CHAT, "sub-bg")).toBe(NESTED);
  });
});

describe("trust_folder", () => {
  test("trusted: one start in the folder, its states on every chat that holds a refused row of it, one log line", async () => {
    const w = await setup();
    const a = await page(w);
    const b = await page(w, OTHER);
    const c = await page(w, THIRD);
    expect(answer(await trust(w, "c-bg-0", NESTED))).toBe("trusted");
    expect(w.driver.trusts).toEqual([NESTED]);
    for (const p of [a, b]) expect(trustEvents(p.v)).toEqual([`${NESTED} trusting`, `${NESTED} trusted`]);
    expect(trustEvents(c.v)).toEqual([]);
    expect(w.log.lines.filter((l) => l.ev === "trust")).toEqual([{ ev: "trust", f: { path: NESTED, answer: "trusted" } }]);
    // A page that attaches later gets the state in `attached`; a chat with no row of it gets none.
    expect((await page(w)).attached.trust).toEqual({ [NESTED]: "trusted" });
    expect((await page(w, THIRD)).attached.trust).toBeUndefined();
  });

  test("a second press of this boot answers already, with no second start; a live refusal of the folder clears that", async () => {
    const w = await setup();
    const a = await page(w);
    await page(w, OTHER);
    expect(answer(await trust(w, "c-bg-0", NESTED))).toBe("trusted");
    expect(answer(await trust(w, "o-bg-0", NESTED, OTHER))).toBe("already");
    expect(w.driver.trusts).toEqual([NESTED]);
    expect(trustEvents(a.v).at(-1)).toBe(`${NESTED} already`);
    expect(w.log.lines.filter((l) => l.ev === "trust").map((l) => l.f.answer)).toEqual(["trusted", "already"]);
    // Claude Code refuses the folder again, live: the next press starts again.
    autoReply(w.driver);
    await apply(w.reg, { t: "send", rid: rid(), chat: CHAT, uuid: crypto.randomUUID(), text: "try again", draftRev: null, uploads: [] });
    await settle(20);
    w.driver.last.emit({ k: "tool_result", id: "again-bg", text: "x", isError: true, parent: null, report: null, trust: { path: NESTED, root: null } });
    await settle(20);
    expect((await page(w)).attached.trust).toBeUndefined();
    expect(answer(await trust(w, "again-bg", NESTED))).toBe("trusted");
    expect(w.driver.trusts).toEqual([NESTED, NESTED]);
  });

  test("a live refusal that clears a folder's answer tells every chat that holds a row of it (D49), once", async () => {
    const w = await setup();
    const a = await page(w);
    const b = await page(w, OTHER);
    const c = await page(w, THIRD);
    expect(answer(await trust(w, "c-bg-0", NESTED))).toBe("trusted");
    autoReply(w.driver);
    await apply(w.reg, { t: "send", rid: rid(), chat: CHAT, uuid: crypto.randomUUID(), text: "try again", draftRev: null, uploads: [] });
    await settle(20);
    w.driver.last.emit({ k: "tool_result", id: "again-bg", text: "x", isError: true, parent: null, report: null, trust: { path: NESTED, root: null } });
    await settle(20);
    // The other chat's open page drops the answer too, so it offers Trust this folder as a page that attaches now does.
    for (const p of [a, b]) expect(trustEvents(p.v)).toEqual([`${NESTED} trusting`, `${NESTED} trusted`, `${NESTED} null`]);
    expect(trustEvents(c.v)).toEqual([]);
    expect((await page(w, OTHER)).attached.trust).toBeUndefined();
    // A second refusal with no answer in between changes nothing, so it tells nobody.
    w.driver.last.emit({ k: "tool_result", id: "again-bg-2", text: "x", isError: true, parent: null, report: null, trust: { path: NESTED, root: null } });
    await settle(20);
    expect(trustEvents(b.v).length).toBe(3);
  });

  test("not recorded, failed and no claude", async () => {
    const w = await setup();
    const a = await page(w);
    w.driver.trustAnswer = { recorded: false };
    expect(answer(await trust(w, "c-bg-0", NESTED))).toBe("not_recorded");
    w.driver.trustAnswer = "failed";
    expect(answer(await trust(w, "c-bg-1", INSIDE))).toBe("failed");
    w.driver.trustAnswer = "no_claude";
    expect(answer(await trust(w, "c-bg-2", PLAIN))).toBe("error no_claude");
    expect(trustEvents(a.v)).toEqual([`${NESTED} trusting`, `${NESTED} not_recorded`, `${INSIDE} trusting`, `${INSIDE} failed`, `${PLAIN} trusting`, `${PLAIN} failed`]);
    // A folder that did not record may be pressed again (from the confirm's Try again or a link): it starts again.
    w.driver.trustAnswer = { recorded: true };
    expect(answer(await trust(w, "c-bg-0", NESTED))).toBe("trusted");
  });

  test("one start per folder at a time: a press while one runs is busy, from any chat; another folder is not", async () => {
    const w = await setup();
    await page(w);
    await page(w, OTHER);
    let release!: () => void;
    w.driver.trustWait = new Promise<void>((r) => (release = r));
    const first = trust(w, "c-bg-0", NESTED);
    await settle(5);
    expect(answer(await trust(w, "c-bg-0", NESTED))).toBe("error busy");
    expect(answer(await trust(w, "o-bg-0", NESTED, OTHER))).toBe("error busy");
    expect((await page(w)).attached.trust).toEqual({ [NESTED]: "trusting" });
    const other = trust(w, "c-bg-1", INSIDE);
    release();
    expect(answer(await first)).toBe("trusted");
    expect(answer(await other)).toBe("trusted");
    expect(w.driver.trusts).toEqual([NESTED, INSIDE]);
  });

  test("gone: the folder is not there, so no start; its state goes to the pages", async () => {
    const w = await setup();
    const a = await page(w);
    expect(answer(await trust(w, "c-bg-3", GONE))).toBe("gone");
    expect(w.driver.trusts).toEqual([]);
    expect(trustEvents(a.v)).toEqual([`${GONE} gone`]);
    expect(w.log.lines.filter((l) => l.ev === "trust")).toEqual([{ ev: "trust", f: { path: GONE, answer: "gone" } }]);
  });

  test("the folder on disk: a link, a path through a link, a file", async () => {
    const w = await setup({}, { chat: [LINK, join(LINK, ".git"), FILE] });
    await page(w);
    expect(answer(await trust(w, "c-bg-0", LINK))).toBe("error trust_refused link");
    expect(answer(await trust(w, "c-bg-1", join(LINK, ".git")))).toBe("error trust_refused link");
    expect(answer(await trust(w, "c-bg-2", FILE))).toBe("error trust_refused not_folder");
    expect(w.driver.trusts).toEqual([]);
  });

  test("never the home folder, nor a folder that holds it (the root among them)", async () => {
    const w = await setup({}, { chat: [HOME, dirname(HOME), "/"] });
    await page(w);
    expect(answer(await trust(w, "c-bg-0", HOME))).toBe("error trust_refused home");
    expect(answer(await trust(w, "c-bg-1", dirname(HOME)))).toBe("error trust_refused holds_home");
    expect(answer(await trust(w, "c-bg-2", "/"))).toBe("error trust_refused holds_home");
    expect(w.driver.trusts).toEqual([]);
  });

  test("never a folder whose repository root is the home folder or holds it: Claude Code keys the trust on that root", async () => {
    // A home folder that is a repository itself (a dotfiles repository), and a repository that holds a home folder.
    const home = join(ROOT, "dothome", "you");
    const notes = join(home, "notes", "todo");
    const outer = join(ROOT, "outer");
    const outerHome = join(outer, "home", "me");
    const docs = join(outer, "docs");
    for (const d of [join(home, ".git"), notes, join(outer, ".git"), outerHome, docs]) mkdirSync(d, { recursive: true });
    // A home folder that is a linked worktree of a bare repository: the key is the bare repository, whose one trust
    // covers every worktree of it, the home folder among them.
    const src = join(ROOT, "wthome-src");
    mkdirSync(src, { recursive: true });
    git(src, "init", "-q");
    writeFileSync(join(src, "README.md"), "x\n");
    git(src, "add", "README.md");
    git(src, "commit", "-q", "-m", "first");
    const bare = join(ROOT, "wthome", "dotfiles.git");
    git(ROOT, "clone", "-q", "--bare", src, bare);
    const wtHome = join(ROOT, "wthome", "me");
    git(bare, "worktree", "add", "-q", "-b", "home", wtHome);
    const wtNotes = join(wtHome, "notes");
    mkdirSync(wtNotes);
    for (const [homes, path, why] of [
      [[home], notes, "home"],
      [[outerHome], docs, "holds_home"],
      [[wtHome], wtNotes, "holds_home"],
    ] as const) {
      const driver = new FakeDriver();
      const store = new MemoryStore();
      store.projects = [projectRecord(PROJECT, SHOP)];
      store.chats.set(CHAT, ledger());
      driver.transcript(SID, "Stage it", SHOP);
      driver.histories.set(SID, refusedHistory("h", [path]));
      const reg = new ChatRegistry({ driver, store, trustHomes: () => homes }, { idleMs: 60_000 });
      await reg.boot();
      const p = await reg.attach(CHAT, new RecordingViewer());
      expect(refOf(p!.snapshot.history, "h-bg-0")?.root).toBe(path === notes ? home : path === docs ? outer : bare);
      expect(answer(await apply(reg, { t: "trust_folder", rid: rid(), chat: CHAT, toolUse: "h-bg-0", path }))).toBe(`error trust_refused ${why}`);
      expect(driver.trusts).toEqual([]);
      await reg.shutdown();
    }
  });

  test("the path's text: over 4,096 bytes is too long; a control character is a bad request", async () => {
    const long = `/${"a".repeat(4096)}`;
    const w = await setup({}, { chat: [long] });
    await page(w);
    expect(answer(await trust(w, "c-bg-0", long))).toBe("error trust_refused too_long");
    // A row whose path holds a tab (no Claude Code line has one, but a row says what it says).
    const live = await setup({}, { chat: [] });
    autoReply(live.driver);
    await page(live);
    await apply(live.reg, { t: "send", rid: rid(), chat: CHAT, uuid: crypto.randomUUID(), text: "go", draftRev: null, uploads: [] });
    await settle(20);
    live.driver.last.emit({ k: "tool_result", id: "tab-bg", text: "x", isError: true, parent: null, report: null, trust: { path: `${PLAIN}\tx`, root: null } });
    await settle(20);
    expect(answer(await trust(live, "tab-bg", `${PLAIN}\tx`))).toBe("error bad_request");
    expect(live.driver.trusts).toEqual([]);
  });

  test("stale: no such row, another path than the row's, a row of another chat", async () => {
    const w = await setup();
    await page(w);
    await page(w, OTHER);
    expect(answer(await trust(w, "c-nothing", NESTED))).toBe("error stale");
    expect(answer(await trust(w, "c-bg-0", INSIDE))).toBe("error stale");
    expect(answer(await trust(w, "o-bg-0", NESTED))).toBe("error stale");
    expect(w.driver.trusts).toEqual([]);
  });

  test("the chat: not found, archived, a restart that drains", async () => {
    const w = await setup();
    await page(w);
    expect(answer(await trust(w, "c-bg-0", NESTED, "nochat2abcdefghijklm"))).toBe("error not_found");
    const archived = await setup();
    archived.store.chats.set(CHAT, ledger({ archivedAt: "2026-11-05T09:00:00.000Z" }));
    const reg = new ChatRegistry({ driver: archived.driver, store: archived.store, trustHomes: () => [HOME] }, { idleMs: 60_000 });
    await reg.boot();
    await reg.attach(CHAT, new RecordingViewer());
    expect(answer(await apply(reg, { t: "trust_folder", rid: rid(), chat: CHAT, toolUse: "c-bg-0", path: NESTED }))).toBe("error archived");
    expect(w.reg.drain("finish")).toEqual({ ok: true });
    expect(answer(await trust(w, "c-bg-0", NESTED))).toBe("error restarting");
    expect(w.driver.trusts).toEqual([]);
    expect(archived.driver.trusts).toEqual([]);
  });

  test("unsupported: an agent with no trust start", async () => {
    const w = await setup();
    await page(w);
    w.driver.caps = { ...w.driver.caps, trustFolder: false };
    const reg = new ChatRegistry({ driver: w.driver, store: w.store, trustHomes: () => [HOME] }, { idleMs: 60_000 });
    await reg.boot();
    await reg.attach(CHAT, new RecordingViewer());
    expect(answer(await apply(reg, { t: "trust_folder", rid: rid(), chat: CHAT, toolUse: "c-bg-0", path: NESTED }))).toBe("error unsupported");
    expect(reg.capabilities.trustFolder).toBe(false);
  });

  test("the shutdown ends a trust start in flight: it answers failed", async () => {
    const w = await setup();
    const a = await page(w);
    w.driver.trustWait = new Promise<void>(() => {});
    const run = trust(w, "c-bg-0", NESTED);
    await settle(5);
    await w.reg.shutdown();
    expect(answer(await run)).toBe("failed");
    expect(trustEvents(a.v)).toEqual([`${NESTED} trusting`, `${NESTED} failed`]);
  });

  test("Delete takes the chat's rows with it", async () => {
    const w = await setup();
    await page(w);
    expect(w.reg.trustRowPath(CHAT, "c-bg-0")).toBe(NESTED);
    expect((await apply(w.reg, { t: "delete", rid: rid(), chat: CHAT })).ok).toBe(true);
    expect(w.reg.trustRowPath(CHAT, "c-bg-0")).toBeNull();
  });
});
