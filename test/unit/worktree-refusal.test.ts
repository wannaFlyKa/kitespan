// F5 (FIX-W25b 1.1): a Start that could get no worktree names why. The ack's error gets an optional `reason`, one of
// the worktree off reasons (the one list that the server and the page share, not_top included), and only on
// `worktree_failed`: newChat's refusal sends the reason that the worktree's make gave, and none for a make that failed
// for another cause. The page shows that reason's line, else the code's own. The validator takes the field only with a
// known reason. PROTOCOL_VERSION stays 3. The chat socket runs on fake sockets; kitespan's git on a scratch repository.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_MESSAGES, PROTOCOL_VERSION, WORKTREE_OFF, ackError, ackFail, ackReason, isWorktreeOff, type NewChatFrame } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, apply, projectRecord, settle } from "../../server/chats/testing";
import { WORKTREE_OFF_LINES } from "../../server/worktree/ops";
import { wsHandlers, type ChatSock } from "../../server/ws/handlers";
import { git, scratch, type Scratch } from "./worktree-repo";

const PROJECT = "k3m7q2x4ab";
const RID = "11111111-1111-4111-8111-111111111111";
const rid = () => crypto.randomUUID();
type Frame = Record<string, unknown> & { t: string };

class FakeSock implements ChatSock {
  data: { state: unknown } = { state: null };
  readonly sent: string[] = [];
  send(s: string): number {
    this.sent.push(s);
    return s.length;
  }
  close(): void {}
  getBufferedAmount(): number {
    return 0;
  }
  ack(r: string): Frame | undefined {
    return this.sent.map((s) => JSON.parse(s) as Frame).find((f) => f.t === "ack" && f.rid === r);
  }
}

let open: { s: Scratch; reg: ChatRegistry }[] = [];
afterEach(async () => {
  for (const o of open) {
    await o.reg.shutdown();
    o.s.cleanup();
  }
  open = [];
});

async function setup(prep: (s: Scratch, d: FakeDriver) => string = (s) => s.repo) {
  const s = scratch();
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [{ ...projectRecord(PROJECT, prep(s, driver)), worktree: true }];
  const reg = new ChatRegistry({ driver, store, worktreeGit: s.wg, worktreeData: s.data }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
  await reg.boot();
  open.push({ s, reg });
  const hub = wsHandlers(reg, { pumpMs: 5 });
  const ws = new FakeSock();
  hub.open(ws);
  hub.message(ws, JSON.stringify({ t: "hello", v: 1, tab: "tab_a" }));
  return { s, driver, store, reg, hub, ws };
}

const newChat = (): NewChatFrame => ({ t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "Plan it", picks: { model: null, effort: null, mode: null }, uploads: [] });

/** Send a Start on the socket and wait for its ack. */
async function start(ctx: Awaited<ReturnType<typeof setup>>): Promise<Frame> {
  const f = newChat();
  ctx.hub.message(ctx.ws, JSON.stringify(f));
  for (let i = 0; i < 500; i++) {
    const a = ctx.ws.ack(f.rid);
    if (a) return a;
    await settle(2);
    await Bun.sleep(5);
  }
  throw new Error("no ack");
}

describe("the ack error's reason (protocol)", () => {
  test("PROTOCOL_VERSION is 4 or more (iteration 5's, row 116; 5 since iteration 7), and the one list of off reasons has a server line for each", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(4);
    expect([...WORKTREE_OFF]).toEqual(["not_git", "not_top", "no_commit", "hook", "config", "link", "nested"]);
    expect(Object.keys(WORKTREE_OFF_LINES).sort()).toEqual([...WORKTREE_OFF].sort());
    for (const r of WORKTREE_OFF) expect(isWorktreeOff(r)).toBe(true);
    expect(isWorktreeOff("failed")).toBe(false);
  });

  test("worktree_failed carries a reason when one is given; no other code does, and none is the default", () => {
    expect(ackFail(RID, "worktree_failed", "not_top")).toEqual({
      t: "ack",
      rid: RID,
      ok: false,
      error: { code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed, reason: "not_top" },
    });
    expect(ackFail(RID, "worktree_failed")).toEqual({ t: "ack", rid: RID, ok: false, error: { code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed } });
    expect("reason" in ackError("worktree_failed")).toBe(false);
    expect("reason" in ackError("stale", "hook")).toBe(false);
  });

  test("the validator takes the field only with a known reason on worktree_failed", () => {
    const err = (reason: unknown, code = "worktree_failed") => ({ code, message: ERROR_MESSAGES.worktree_failed, reason });
    for (const r of WORKTREE_OFF) expect(ackReason(err(r))).toBe(r);
    for (const bad of ["failed", "NOT_TOP", "", 3, null, {}, ["hook"]]) expect(ackReason(err(bad))).toBeNull();
    expect(ackReason(err("hook", "failed"))).toBeNull();
    expect(ackReason({ code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed })).toBeNull();
    for (const v of [null, undefined, "hook", 1, []]) expect(ackReason(v)).toBeNull();
  });
});

describe("newChat's refusal names the reason (the server)", () => {
  test("a project with a WorktreeCreate hook gets the hook's line, and no chat", async () => {
    const ctx = await setup((s, d) => {
      d.agentSettings = { ...d.agentSettings, worktreeHook: true };
      return s.repo;
    });
    const a = await start(ctx);
    expect(a).toMatchObject({ ok: false, error: { code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed, reason: "hook" } });
    const reason = ackReason(a.error);
    expect(reason).toBe("hook");
    expect(WORKTREE_OFF_LINES[reason!]).toBe("Your Claude Code settings have a WorktreeCreate hook, which kitespan's worktrees would not run.");
    expect(ctx.store.chats.size).toBe(0);
    expect(ctx.driver.opens).toHaveLength(0);
  });

  test("a folder that is not the top of its repository's main checkout gets not_top", async () => {
    const ctx = await setup((s) => {
      const sub = join(s.repo, "app");
      mkdirSync(sub);
      return sub;
    });
    expect((await start(ctx)).error).toEqual({ code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed, reason: "not_top" });
  });

  test("a repository config that could run a program gets config (the registry's outcome too)", async () => {
    const ctx = await setup();
    git(ctx.s.repo, "config", "includeIf.gitdir:/nowhere/.path", "/nowhere/config");
    expect(await apply(ctx.reg, newChat())).toEqual({ ok: false, code: "worktree_failed", reason: "config" });
  });

  test("a .claude that is a symbolic link gets link (row 100), and nothing is made behind it", async () => {
    const ctx = await setup();
    const elsewhere = join(ctx.s.root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(ctx.s.repo, ".claude"));
    expect(await apply(ctx.reg, newChat())).toEqual({ ok: false, code: "worktree_failed", reason: "link" });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("a make that failed for no off reason sends the code alone", async () => {
    // A file where kitespan's data folder for worktrees would go: the worktree cannot be made, for no reason of the folder's.
    const ctx = await setup((s) => {
      mkdirSync(s.data, { recursive: true });
      writeFileSync(join(s.data, "kitespan"), "not a folder\n");
      return s.repo;
    });
    const a = await start(ctx);
    expect(a.error).toEqual({ code: "worktree_failed", message: ERROR_MESSAGES.worktree_failed });
    expect(ackReason(a.error)).toBeNull();
  });
});
