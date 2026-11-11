// A project with Worktree on, in the chat registry (build checklist W3, W4, W5, W7 to W10, W12, L25 to L27, L31,
// L35): the scripted driver stands in for Claude Code, and kitespan's own git works on a scratch repository. Two chats
// get two worktrees and branches; a gone worktree starts nothing and offers its two buttons; Claude Code's own
// refusals never start again by themselves; archive, unarchive and delete keep the work; copies share the worktree;
// Continue here starts in a terminal session's own linked worktree.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_MESSAGES, type ChatDelta, type ChatEvent, type NewChatFrame, type SendFrame, type WorktreeAct } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import { branches, commitAll, git, scratch, type Scratch } from "./worktree-repo";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();

let open: { s: Scratch; reg: ChatRegistry }[] = [];
afterEach(async () => {
  for (const o of open) {
    await o.reg.shutdown();
    o.s.cleanup();
  }
  open = [];
});

async function setup(opts: { worktree?: boolean; prep?: (s: Scratch, d: FakeDriver) => void; bash?: FakeBash } = {}) {
  const s = scratch();
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [{ ...projectRecord(PROJECT, s.repo), ...(opts.worktree === false ? {} : { worktree: true as const }) }];
  opts.prep?.(s, driver);
  const reg = new ChatRegistry({ driver, store, worktreeGit: s.wg, worktreeData: s.data, ...(opts.bash ? { bash: opts.bash } : {}) }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
  await reg.boot();
  open.push({ s, reg });
  const deltas: ChatDelta[] = [];
  reg.subscribe((d) => deltas.push(d));
  autoReply(driver);
  return { s, driver, store, reg, deltas };
}

const newChatFrame = (text: string, over: Partial<NewChatFrame> = {}): NewChatFrame => ({ t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [], ...over });
async function newChat(reg: ChatRegistry, text = "Plan the upload feature", over: Partial<NewChatFrame> = {}): Promise<string> {
  const o = await apply(reg, newChatFrame(text, over));
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  await settle(10);
  return (o.result as { chat: string }).chat;
}
const send = (chat: string, text: string): SendFrame => {
  const r = rid();
  return { t: "send", rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};
const act = (chat: string, a: WorktreeAct) => ({ t: "worktree" as const, rid: rid(), chat, act: a });
const ledger = async (store: MemoryStore, chat: string) => (await store.readChat(chat))!;
const row = (reg: ChatRegistry, chat: string) => reg.list().find((r) => r.chat === chat)!;
/** Wait until the chat's process is gone (an archive's close runs after its ack). */
async function untilAsleep(reg: ChatRegistry, chat: string) {
  for (let i = 0; i < 200 && reg.processLives(chat); i++) await Bun.sleep(10);
  await settle(20);
  await Bun.sleep(150);
}

describe("W3: the start of a worktree chat", () => {
  test("two chats in one worktree project get two worktrees and two branches, and Claude Code starts in each", async () => {
    const { s, driver, store, reg } = await setup();
    const a = await newChat(reg, "first");
    const b = await newChat(reg, "second");
    const la = await ledger(store, a);
    const lb = await ledger(store, b);
    // Row 100: in the project's .claude/worktrees.
    expect(la.worktree?.path).toBe(join(s.repo, ".claude", "worktrees", a.slice(0, 8)));
    expect(la.worktree).toMatchObject({ root: s.repo, branch: `kitespan/${a.slice(0, 8)}`, baseRef: "refs/heads/main", baseCommit: s.head! });
    expect(la.cwd).toBe(la.worktree!.path);
    expect(lb.cwd).toBe(lb.worktree!.path);
    expect(la.cwd).not.toBe(lb.cwd);
    expect(branches(s.repo)).toEqual([`kitespan/${a.slice(0, 8)}`, `kitespan/${b.slice(0, 8)}`, "main"].sort());
    expect(driver.opens.map((c) => c.input.cwd)).toEqual([la.cwd, lb.cwd]);
    expect(driver.opens.map((c) => c.input.worktree)).toEqual([
      { path: la.cwd, root: s.repo, own: true },
      { path: lb.cwd, root: s.repo, own: true },
    ]);
    expect(row(reg, a).worktree).toEqual({ path: la.cwd, branch: la.worktree!.branch, kept: false });
  });

  test("the form's mentions resolve in the new worktree: a file it lacks refuses Start, and the worktree goes again", async () => {
    const { s, driver, store, reg } = await setup();
    writeFileSync(join(s.repo, "untracked.md"), "only in the main checkout\n");
    const o = await apply(reg, newChatFrame("look", { mentions: ["untracked.md"] }));
    expect(o).toEqual({ ok: false, code: "mention_gone" });
    expect(store.chats.size).toBe(0);
    expect(driver.opens).toHaveLength(0);
    expect(branches(s.repo)).toEqual(["main"]);
    expect(existsSync(join(s.repo, ".claude", "worktrees"))).toBe(true);
    expect(existsSync(join(s.data, "kitespan", "worktrees", PROJECT))).toBe(true);
    expect(git(s.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    // A tracked file is in the worktree, and its reference names the worktree's copy.
    const chat = await newChat(reg, "look", { mentions: ["README.md"] });
    const cwd = (await ledger(store, chat)).cwd;
    expect(driver.last.sent[0]!.text).toContain(join(cwd, "README.md"));
  });

  test("a project whose repository could run a program, or whose settings have a WorktreeCreate hook, makes no chat", async () => {
    const { s, driver, store, reg } = await setup();
    git(s.repo, "config", "includeIf.gitdir:/nowhere/.path", "/nowhere/config");
    // F5: the refusal names why, so the page shows that reason's line.
    expect(await apply(reg, newChatFrame("x"))).toEqual({ ok: false, code: "worktree_failed", reason: "config" });
    git(s.repo, "config", "--unset", "includeIf.gitdir:/nowhere/.path");
    driver.agentSettings = { ...driver.agentSettings, worktreeHook: true };
    expect(await apply(reg, newChatFrame("x"))).toEqual({ ok: false, code: "worktree_failed", reason: "hook" });
    expect(store.chats.size).toBe(0);
    expect(branches(s.repo)).toEqual(["main"]);
  });

  test("a project with Worktree off starts its chats in its own folder", async () => {
    const { s, driver, store, reg } = await setup({ worktree: false });
    const chat = await newChat(reg);
    expect((await ledger(store, chat)).cwd).toBe(s.repo);
    expect((await ledger(store, chat)).worktree).toBeUndefined();
    expect(driver.last.input.worktree).toBeNull();
    expect(row(reg, chat).worktree).toBeUndefined();
  });

  test("the short reads and the settings read use the project's folder (projectConfigRoot)", async () => {
    const { s, driver, reg } = await setup();
    const chat = await newChat(reg);
    driver.modelsAnswer = [];
    // A chat with no live process gets the kept list or one short read of its project's folder.
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await apply(reg, { t: "get", rid: rid(), chat, what: "models" });
    expect(driver.modelReads.every((c) => c === s.repo)).toBe(true);
  });

  test("a pick of no mode and a `!` command's reply rule read the user's settings of the project's folder (projectConfigRoot)", async () => {
    const bash = new FakeBash();
    const { s, driver, store, reg } = await setup({ bash });
    const chat = await newChat(reg);
    expect((await ledger(store, chat)).cwd).not.toBe(s.repo);
    const reads: string[] = [];
    const answer = driver.settings.bind(driver);
    // The registry passes the folder (AgentDriver.settings); the fake's own answer ignores it.
    driver.settings = (async (cwd: string) => {
      reads.push(cwd);
      return answer();
    }) as typeof driver.settings;
    await apply(reg, { t: "set_mode", rid: rid(), chat, value: null });
    await apply(reg, { t: "bash", rid: rid(), chat, input: "true", draftRev: null, uploads: [] });
    for (let i = 0; i < 100 && reads.length < 2; i++) await Bun.sleep(20);
    // The `!` command itself runs in the chat's own folder, its worktree.
    expect(bash.runs.map((r) => r.cwd)).toEqual([(await ledger(store, chat)).cwd]);
    expect(reads).toEqual([s.repo, s.repo]);
  });

  test("a sleeping chat's context figure (row 94): its transcript is read in its worktree, the windows' short read in the project's folder", async () => {
    const { s, driver, store, reg } = await setup();
    const chat = await newChat(reg);
    const l = await ledger(store, chat);
    driver.usages.set(l.sessionId!, { model: "claude-opus-4-6", usedTokens: 50_000 });
    driver.windowsAnswer = { "claude-opus-4-6": 200_000 };
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await untilAsleep(reg, chat);
    const from = driver.sessionDirs.length;
    const got = await apply(reg, { t: "get", rid: rid(), chat, what: "context" });
    expect(got.ok && (got.result as { maxTokens: number } | null)?.maxTokens).toBe(200_000);
    expect(driver.sessionDirs.slice(from).filter((c) => c.op === "usage").map((c) => c.cwd)).toEqual([l.cwd]);
    expect(driver.windowReads).toEqual([s.repo]);
  });
});

describe("W4: the check before every start (L35)", () => {
  test("a removed worktree: the line with its code, no start; Make it again brings it back from its branch", async () => {
    const { s, driver, store, reg } = await setup();
    const chat = await newChat(reg);
    const w = (await ledger(store, chat)).worktree!;
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await untilAsleep(reg, chat);
    await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false });
    // The user removes it by hand between two starts.
    git(s.repo, "worktree", "remove", "--force", w.path);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const opens = driver.opens.length;
    expect(await apply(reg, send(chat, "again?"))).toEqual({ ok: false, code: "worktree_gone" });
    expect(driver.opens).toHaveLength(opens);
    expect(v.of("notice").at(-1)).toEqual({ k: "notice", text: ERROR_MESSAGES.worktree_gone, code: "worktree_gone", id: expect.any(String) });
    expect(await apply(reg, act(chat, "start"))).toEqual({ ok: false, code: "stale" });
    expect(await apply(reg, act(chat, "again"))).toEqual({ ok: true, result: { started: false } });
    expect(existsSync(join(w.path, "README.md"))).toBe(true);
    expect(git(w.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(w.branch);
    expect((await apply(reg, send(chat, "now"))).ok).toBe(true);
    expect(driver.opens).toHaveLength(opens + 1);
    expect(driver.last.input.cwd).toBe(w.path);
  });

  test("Continue in the project folder: the chat runs in its project's folder from now on", async () => {
    const { s, driver, store, reg, deltas } = await setup();
    const chat = await newChat(reg);
    const w = (await ledger(store, chat)).worktree!;
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await untilAsleep(reg, chat);
    await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false });
    git(s.repo, "worktree", "remove", "--force", w.path);
    expect((await apply(reg, send(chat, "x"))).ok).toBe(false);
    expect(await apply(reg, act(chat, "project"))).toEqual({ ok: true, result: { started: false } });
    const l = await ledger(store, chat);
    expect(l.cwd).toBe(s.repo);
    expect(l.worktree).toEqual({ ...w, left: true });
    expect(row(reg, chat).worktree).toBeUndefined();
    expect(deltas.some((d) => d.chat === chat && "worktree" in d && d.worktree === null)).toBe(true);
    expect((await apply(reg, send(chat, "in the project"))).ok).toBe(true);
    expect(driver.last.input.cwd).toBe(s.repo);
    expect(driver.last.input.worktree).toBeNull();
    // The branch stays for Delete's rule.
    expect(branches(s.repo)).toContain(w.branch);
  });

  test("the line goes once the user's choice is done, so a reload or a catch-up draws no stale buttons", async () => {
    /** The refused-start lines that a page drawing these events in order still shows (no later taken_back). */
    const openLines = (events: ChatEvent[]) => {
      const open = new Map<string, ChatEvent>();
      for (const e of events) {
        if (e.k === "notice" && e.code && e.id) open.set(e.id, e);
        if (e.k === "taken_back") open.delete(e.uuid);
      }
      return [...open.values()];
    };
    for (const choice of ["again", "project"] as const) {
      const { s, store, reg } = await setup();
      const chat = await newChat(reg);
      const w = (await ledger(store, chat)).worktree!;
      await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
      await untilAsleep(reg, chat);
      await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false });
      git(s.repo, "worktree", "remove", "--force", w.path);
      const v = new RecordingViewer();
      await reg.attach(chat, v);
      expect(await apply(reg, send(chat, "again?"))).toEqual({ ok: false, code: "worktree_gone" });
      // A second refusal takes the first line's place: one open line.
      expect(await apply(reg, send(chat, "and now?"))).toEqual({ ok: false, code: "worktree_gone" });
      const lines = v.of("notice").filter((e) => e.code === "worktree_gone");
      expect(lines).toHaveLength(2);
      for (const l of lines) expect(typeof l.id).toBe("string");
      expect(openLines(v.events)).toEqual([lines[1]!]);
      const before = await reg.attach(chat, new RecordingViewer());
      expect(openLines(before!.tail.map((i) => i.e))).toEqual([lines[1]!]);
      expect(await apply(reg, act(chat, choice))).toEqual({ ok: true, result: { started: false } });
      expect(openLines(v.events)).toEqual([]);
      // A reload (the snapshot's tail) and a catch-up from the ring see the line go too.
      const after = await reg.attach(chat, new RecordingViewer());
      expect(openLines(after!.tail.map((i) => i.e))).toEqual([]);
      const ring: ChatEvent[] = [];
      for (let seq = 0, n = reg.next(chat, seq); n && n !== "gap"; seq = n.seq, n = reg.next(chat, seq)) ring.push(n.e);
      expect(openLines(ring)).toEqual([]);
    }
  });
});

/** The scripted Claude Code refuses the start itself: an exit with `startup`, as the driver reports it. */
function refuseWith(driver: FakeDriver, reason: "worktree_resume_refused" | "worktree_unverified" | "cwd_unavailable" | "unknown", line: string | null) {
  driver.script = (chat) => {
    setTimeout(() => {
      chat.emit({ k: "exit", code: 1, signal: null, stderr: [], startup: { reason, line } } as ChatEvent);
      chat.end(null);
    }, 0);
  };
}

describe("W5: Claude Code's own refusals, never a retry by itself", () => {
  test("worktree_resume_refused: its first error line with the code; no send starts until Continue without the worktree", async () => {
    const { driver, store, reg } = await setup({ worktree: false });
    const chat = await newChat(reg);
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await untilAsleep(reg, chat);
    await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false });
    const LINE = "Error: cannot resume into worktree /x: This session was not started.";
    refuseWith(driver, "worktree_resume_refused", LINE);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    expect((await apply(reg, send(chat, "go on"))).ok).toBe(true);
    await settle(20);
    expect(v.of("notice").at(-1)).toEqual({ k: "notice", text: LINE, code: "worktree_resume_refused", id: expect.any(String) });
    expect(v.of("exit")).toEqual([]);
    // The turn that was drawn ends with no line of its own, and the message that never ran goes back to the box.
    expect(v.of("turn_end").at(-1)).toMatchObject({ ok: false, subtype: "cut", error: null });
    const sentUuid = v.of("user").at(-1)!.uuid;
    expect(v.of("taken_back").map((e) => e.uuid)).toContain(sentUuid);
    await settle(20);
    expect(reg.draftOf(chat)?.text).toBe("go on");
    expect((await ledger(store, chat)).refused).toBe("worktree_resume_refused");
    const opens = driver.opens.length;
    expect(await apply(reg, send(chat, "again"))).toEqual({ ok: false, code: "worktree_resume_refused" });
    await settle(20);
    expect(driver.opens).toHaveLength(opens);
    autoReply(driver);
    expect(await apply(reg, act(chat, "start"))).toEqual({ ok: true, result: { started: true } });
    expect(driver.opens).toHaveLength(opens + 1);
    expect((await ledger(store, chat)).refused).toBeUndefined();
  });

  test("worktree_unverified: the line with Try again; an unknown reason keeps the plain exit line; neither starts again", async () => {
    const { driver, reg } = await setup({ worktree: false });
    const chat = await newChat(reg);
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await untilAsleep(reg, chat);
    await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false });
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    refuseWith(driver, "worktree_unverified", null);
    await apply(reg, send(chat, "one"));
    await settle(20);
    expect(v.of("notice").at(-1)).toEqual({ k: "notice", text: ERROR_MESSAGES.worktree_unverified, code: "worktree_unverified", id: expect.any(String) });
    const opens = driver.opens.length;
    await Bun.sleep(100);
    expect(driver.opens).toHaveLength(opens);
    refuseWith(driver, "unknown", "Error: something else");
    expect(await apply(reg, act(chat, "start"))).toEqual({ ok: true, result: { started: true } });
    expect((await apply(reg, send(chat, "two"))).ok).toBe(true);
    await settle(20);
    expect(v.of("exit").at(-1)).toMatchObject({ k: "exit", startup: { reason: "unknown" } });
    await Bun.sleep(100);
    expect(driver.opens).toHaveLength(opens + 1);
  });

  test("cwd_unavailable for a chat's own worktree reads as the gone worktree's line", async () => {
    const { driver, reg } = await setup();
    const chat = await newChat(reg);
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await untilAsleep(reg, chat);
    await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false });
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    refuseWith(driver, "cwd_unavailable", null);
    await apply(reg, send(chat, "x"));
    await settle(20);
    expect(v.of("notice").at(-1)).toMatchObject({ code: "worktree_gone" });
  });
});

describe("archive, unarchive and delete (W7, W8, W9, L25, L26)", () => {
  test("a clean worktree goes at archive and its branch stays; Unarchive makes it again from its branch", async () => {
    const { s, store, reg } = await setup();
    const chat = await newChat(reg);
    const w = (await ledger(store, chat)).worktree!;
    expect((await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true })).ok).toBe(true);
    await untilAsleep(reg, chat);
    expect(existsSync(w.path)).toBe(false);
    expect(branches(s.repo)).toContain(w.branch);
    expect(row(reg, chat).worktree?.kept).toBe(false);
    expect((await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false })).ok).toBe(true);
    expect(existsSync(join(w.path, "README.md"))).toBe(true);
    expect(git(w.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(w.branch);
  });

  test("a worktree with changes stays on disk, and the archived row says so", async () => {
    const { store, reg } = await setup();
    const chat = await newChat(reg);
    const w = (await ledger(store, chat)).worktree!;
    writeFileSync(join(w.path, "draft.txt"), "unsaved work\n");
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await untilAsleep(reg, chat);
    expect(readFileSync(join(w.path, "draft.txt"), "utf8")).toBe("unsaved work\n");
    expect(row(reg, chat).worktree).toEqual({ path: w.path, branch: w.branch, kept: true });
    expect((await ledger(store, chat)).worktree?.kept).toBe(true);
    await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false });
    expect(row(reg, chat).worktree?.kept).toBe(false);
  });

  test("delete of a chat whose branch has a commit of its own: the folder goes, the branch stays", async () => {
    const { s, store, reg } = await setup();
    const chat = await newChat(reg);
    const w = (await ledger(store, chat)).worktree!;
    writeFileSync(join(w.path, "work.txt"), "x\n");
    commitAll(w.path, "a commit of its own");
    writeFileSync(join(w.path, "dirty.txt"), "uncommitted\n");
    expect((await apply(reg, { t: "delete", rid: rid(), chat })).ok).toBe(true);
    expect(existsSync(w.path)).toBe(false);
    expect(branches(s.repo)).toContain(w.branch);
  });

  // Row 100: the path is in the project's .claude/worktrees, which the CLI and Desktop share, and Archive frees its name.
  test("a worktree that another tool makes at the path Archive freed is never the chat's: no start, no remake, kept by Archive and Delete", async () => {
    const { s, driver, store, reg } = await setup();
    const chat = await newChat(reg);
    const w = (await ledger(store, chat)).worktree!;
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await untilAsleep(reg, chat);
    expect(existsSync(w.path)).toBe(false);
    // `claude -w <the same 8 symbols>`: the CLI's own branch at the same path, with the user's uncommitted work in it.
    const theirs = `worktree-${w.path.slice(w.path.lastIndexOf("/") + 1)}`;
    git(s.repo, "worktree", "add", "-q", "-b", theirs, w.path);
    writeFileSync(join(w.path, "users-work.txt"), "mine\n");
    expect((await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false })).ok).toBe(true);
    const opens = driver.opens.length;
    expect(await apply(reg, send(chat, "go on"))).toEqual({ ok: false, code: "worktree_gone" });
    expect(driver.opens).toHaveLength(opens);
    expect(await apply(reg, act(chat, "again"))).toEqual({ ok: false, code: "worktree_failed" });
    expect(driver.opens).toHaveLength(opens);
    // Archive (no confirm for a clean worktree) and then Delete never hand that worktree to git.
    git(w.path, "add", "users-work.txt");
    commitAll(w.path, "the user's own commit");
    expect((await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true })).ok).toBe(true);
    await untilAsleep(reg, chat);
    expect(existsSync(join(w.path, "users-work.txt"))).toBe(true);
    writeFileSync(join(w.path, "more-work.txt"), "uncommitted\n");
    expect((await apply(reg, { t: "delete", rid: rid(), chat })).ok).toBe(true);
    expect(readFileSync(join(w.path, "more-work.txt"), "utf8")).toBe("uncommitted\n");
    expect(git(w.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(theirs);
    // kitespan's own branch goes with Delete (no commit of its own); the CLI's stays.
    expect(branches(s.repo)).toEqual(["main", theirs]);
  });

  test("after Archive's removal, a worktree on the chat's own branch at its path is its own (a remake whose ledger write was lost)", async () => {
    const { s, driver, store, reg } = await setup();
    const chat = await newChat(reg);
    const w = (await ledger(store, chat)).worktree!;
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await untilAsleep(reg, chat);
    expect(existsSync(w.path)).toBe(false);
    git(s.repo, "worktree", "add", "-q", w.path, w.branch);
    expect((await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false })).ok).toBe(true);
    expect((await ledger(store, chat)).worktree).toEqual(w);
    expect((await apply(reg, send(chat, "go on"))).ok).toBe(true);
    expect(driver.last.input.cwd).toBe(w.path);
  });

  test("delete of a clean chat: the folder and the branch go", async () => {
    const { s, store, reg } = await setup();
    const chat = await newChat(reg);
    const w = (await ledger(store, chat)).worktree!;
    expect((await apply(reg, { t: "delete", rid: rid(), chat })).ok).toBe(true);
    expect(existsSync(w.path)).toBe(false);
    expect(branches(s.repo)).toEqual(["main"]);
  });
});

describe("W10, L27: Continue in a copy runs in the same worktree", () => {
  test("the copy's ledger has the same worktree and folder; archiving the copy keeps the worktree of the listed original", async () => {
    const { store, driver, reg } = await setup();
    const chat = await newChat(reg);
    const l = await ledger(store, chat);
    const o = await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: l.sessionId!, fork: true });
    expect(o.ok).toBe(true);
    const copy = (o as { result: { chat: string } }).result.chat;
    const lc = await ledger(store, copy);
    expect(lc.cwd).toBe(l.cwd);
    expect(lc.worktree).toEqual({ path: l.worktree!.path, root: l.worktree!.root, branch: l.worktree!.branch, baseRef: l.worktree!.baseRef, baseCommit: l.worktree!.baseCommit });
    expect(driver.forks.at(-1)!.cwd).toBe(l.cwd);
    await apply(reg, { t: "archive", rid: rid(), chat: copy, on: true, stop: true });
    await untilAsleep(reg, copy);
    expect(existsSync(l.worktree!.path)).toBe(true);
    // Its own start runs there too.
    await apply(reg, { t: "archive", rid: rid(), chat: copy, on: false, stop: false });
    expect((await apply(reg, send(copy, "in the copy"))).ok).toBe(true);
    expect(driver.last.input.cwd).toBe(l.cwd);
    expect(driver.last.input.worktree).toEqual({ path: l.cwd, root: l.worktree!.root, own: true });
  });

  test("a copy of a chat whose worktree Archive removed starts nowhere else: another tool's worktree at the path is not its", async () => {
    const { s, store, driver, reg } = await setup();
    const chat = await newChat(reg);
    const l = await ledger(store, chat);
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await untilAsleep(reg, chat);
    expect((await ledger(store, chat)).worktree?.removed).toBe(true);
    git(s.repo, "worktree", "add", "-q", "-b", "worktree-theirs", l.worktree!.path);
    const o = await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: l.sessionId!, fork: true });
    expect(o.ok).toBe(true);
    const copy = (o as { result: { chat: string } }).result.chat;
    expect((await ledger(store, copy)).worktree?.removed).toBe(true);
    const opens = driver.opens.length;
    expect(await apply(reg, send(copy, "in the copy"))).toEqual({ ok: false, code: "worktree_gone" });
    expect(driver.opens).toHaveLength(opens);
  });
});

describe("W12, L31: Continue here of a terminal session that ran in a linked worktree", () => {
  test("the chat starts in that session's own folder, as a linked worktree that is not kitespan's", async () => {
    const { s, driver, store, reg } = await setup({ worktree: false });
    const term = join(s.root, "terminal-wt");
    git(s.repo, "worktree", "add", "-q", "-b", "feature", term);
    const sid = crypto.randomUUID();
    driver.transcript(sid, "From the terminal", term);
    const o = await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid });
    expect(o.ok).toBe(true);
    const chat = (o as { result: { chat: string } }).result.chat;
    const l = await ledger(store, chat);
    expect(l.cwd).toBe(term);
    expect(l.linked).toBe(true);
    expect(l.worktree).toBeUndefined();
    expect(row(reg, chat).worktree).toEqual({ path: term, branch: null, kept: false });
    expect((await apply(reg, send(chat, "go on"))).ok).toBe(true);
    expect(driver.last.input.cwd).toBe(term);
    expect(driver.last.input.worktree).toEqual({ path: term, root: s.repo, own: false });
    // Delete never removes a worktree that kitespan did not make.
    expect((await apply(reg, { t: "delete", rid: rid(), chat })).ok).toBe(true);
    expect(existsSync(join(term, "README.md"))).toBe(true);
    expect(branches(s.repo)).toContain("feature");
  });

  test("row 100: one in a worktree inside the project's folder (Claude Code's own .claude/worktrees) is a linked one, never the project's folder", async () => {
    const { s, driver, store, reg } = await setup({ worktree: false });
    const term = join(s.repo, ".claude", "worktrees", "feature-x");
    git(s.repo, "worktree", "add", "-q", "-b", "worktree-feature-x", term);
    const sid = crypto.randomUUID();
    driver.transcript(sid, "From the terminal", term);
    const o = await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid });
    const chat = (o as { result: { chat: string } }).result.chat;
    const l = await ledger(store, chat);
    expect({ cwd: l.cwd, linked: l.linked, worktree: l.worktree }).toEqual({ cwd: term, linked: true, worktree: undefined });
    expect((await apply(reg, send(chat, "go on"))).ok).toBe(true);
    expect(driver.last.input.worktree).toEqual({ path: term, root: s.repo, own: false });
  });

  test("row 100: one in a plain folder under .claude/worktrees (no worktree) is a chat of the project's folder", async () => {
    const { s, driver, store, reg } = await setup({ worktree: false });
    const plain = join(s.repo, ".claude", "worktrees", "plain");
    mkdirSync(plain, { recursive: true });
    const sid = crypto.randomUUID();
    driver.transcript(sid, "From the terminal", plain);
    const o = await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid });
    const chat = (o as { result: { chat: string } }).result.chat;
    const l = await ledger(store, chat);
    expect({ cwd: l.cwd, linked: l.linked, worktree: l.worktree }).toEqual({ cwd: s.repo, linked: undefined, worktree: undefined });
    expect(row(reg, chat).worktree ?? null).toBeNull();
  });

  test("a session in the project's folder, or in a folder that is no worktree of it, continues in the project's folder", async () => {
    const { s, driver, store, reg } = await setup({ worktree: false });
    const sid = crypto.randomUUID();
    driver.transcript(sid, "From the terminal", join(s.root, "elsewhere"));
    const o = await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid });
    const chat = (o as { result: { chat: string } }).result.chat;
    expect((await ledger(store, chat)).cwd).toBe(s.repo);
    expect((await ledger(store, chat)).linked).toBeUndefined();
  });
});
