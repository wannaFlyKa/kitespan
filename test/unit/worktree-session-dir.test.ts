// W4's Continue in the project folder and the session's transcript (build checklist W4, W9, W10, W12, L26, L27, L35):
// Claude Code keeps a session's transcript under the folder it ran in, also after a resume in the project's folder,
// so a chat that went on in its project's folder after its worktree was gone (its own, or a terminal session's linked
// worktree) keeps that folder as `sessionDir`, and every session function (history, info, rename, delete, fork) is
// asked with it, never with the project's folder; a copy of such a chat has it too. A new transcript (the old one is
// gone) is filed under the chat's own folder again. The scripted driver records each call's folder.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { NewChatFrame, SendFrame, WorktreeAct } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import { git, scratch, type Scratch } from "./worktree-repo";

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

async function setup(worktree: boolean) {
  const s = scratch();
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [{ ...projectRecord(PROJECT, s.repo), ...(worktree ? { worktree: true as const } : {}) }];
  const reg = new ChatRegistry({ driver, store, worktreeGit: s.wg, worktreeData: s.data }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
  await reg.boot();
  open.push({ s, reg });
  autoReply(driver);
  return { s, driver, store, reg };
}

const newChatFrame = (text: string): NewChatFrame => ({ t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] });
const send = (chat: string, text: string): SendFrame => {
  const r = rid();
  return { t: "send", rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};
const act = (chat: string, a: WorktreeAct) => ({ t: "worktree" as const, rid: rid(), chat, act: a });
const chatOf = (o: unknown) => (o as { result: { chat: string } }).result.chat;

async function asleep(reg: ChatRegistry, chat: string) {
  await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
  for (let i = 0; i < 200 && reg.processLives(chat); i++) await Bun.sleep(10);
  await settle(20);
  await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false });
}

/** Every session function that the steps after `from` asked, with its folder. */
const asked = (driver: FakeDriver, from: number) => driver.sessionDirs.slice(from).map((c) => `${c.op} ${c.cwd}`);

describe("a chat that went on in its project's folder keeps the folder its transcript is filed under", () => {
  test("its own worktree, gone and forgotten by git: history, rename, a copy and Delete all ask the worktree's path", async () => {
    const { s, driver, store, reg } = await setup(true);
    const chat = chatOf(await apply(reg, newChatFrame("first")));
    await settle(20);
    const w = (await store.readChat(chat))!.worktree!;
    const sid = (await store.readChat(chat))!.sessionId!;
    await asleep(reg, chat);
    // The user's own `git worktree remove`: the folder goes and git forgets it.
    git(s.repo, "worktree", "remove", "--force", w.path);
    expect((await apply(reg, send(chat, "x"))).ok).toBe(false);
    expect((await apply(reg, act(chat, "project"))).ok).toBe(true);
    const l = (await store.readChat(chat))!;
    expect(l.cwd).toBe(s.repo);
    expect(l.sessionDir).toBe(w.path);
    // The resume in the project's folder finds the transcript there.
    const from = driver.sessionDirs.length;
    expect((await apply(reg, send(chat, "in the project"))).ok).toBe(true);
    await settle(20);
    expect(driver.last.input.cwd).toBe(s.repo);
    expect(driver.last.input.resume?.value).toBe(sid);
    expect((await apply(reg, { t: "rename", rid: rid(), chat, title: "Renamed" })).ok).toBe(true);
    expect((await apply(reg, { t: "get", rid: rid(), chat, what: "history", before: null })).ok).toBe(true);
    // Continue in a copy: the fork goes beside the original, so the copy has the same folder.
    const copy = chatOf(await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid, fork: true }));
    const lc = (await store.readChat(copy))!;
    expect(lc.cwd).toBe(s.repo);
    expect(lc.sessionDir).toBe(w.path);
    expect((await apply(reg, { t: "delete", rid: rid(), chat: copy })).ok).toBe(true);
    expect((await apply(reg, { t: "delete", rid: rid(), chat })).ok).toBe(true);
    const calls = asked(driver, from);
    expect(calls.filter((c) => c.endsWith(` ${s.repo}`))).toEqual([]);
    for (const op of ["info", "rename", "history", "fork", "delete"]) expect(calls).toContain(`${op} ${w.path}`);
    expect(driver.deletedSessions).toHaveLength(2);
  });

  test("a terminal session's linked worktree, gone: Delete asks that worktree's path, which the ledger keeps", async () => {
    const { s, driver, store, reg } = await setup(false);
    const term = join(s.root, "terminal-wt");
    git(s.repo, "worktree", "add", "-q", "-b", "feature", term);
    const sid = crypto.randomUUID();
    driver.transcript(sid, "From the terminal", term);
    const chat = chatOf(await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid }));
    expect((await store.readChat(chat))!.linked).toBe(true);
    git(s.repo, "worktree", "remove", "--force", term);
    expect(await apply(reg, send(chat, "x"))).toEqual({ ok: false, code: "cwd_unavailable" });
    expect((await apply(reg, act(chat, "project"))).ok).toBe(true);
    const l = (await store.readChat(chat))!;
    expect(l.cwd).toBe(s.repo);
    expect(l.linked).toBeUndefined();
    expect(l.sessionDir).toBe(term);
    const from = driver.sessionDirs.length;
    const copy = chatOf(await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: sid, fork: true }));
    expect((await store.readChat(copy))!.sessionDir).toBe(term);
    expect((await apply(reg, { t: "delete", rid: rid(), chat })).ok).toBe(true);
    expect(asked(driver, from)).toEqual([`info ${term}`, `fork ${term}`, `delete ${term}`]);
  });

  test("a sleeping chat's context figure (row 94) reads the transcript there too; the windows' short read uses the project's folder", async () => {
    const { s, driver, store, reg } = await setup(true);
    const chat = chatOf(await apply(reg, newChatFrame("first")));
    await settle(20);
    const w = (await store.readChat(chat))!.worktree!;
    const sid = (await store.readChat(chat))!.sessionId!;
    await asleep(reg, chat);
    git(s.repo, "worktree", "remove", "--force", w.path);
    await apply(reg, send(chat, "x"));
    expect((await apply(reg, act(chat, "project"))).ok).toBe(true);
    driver.usages.set(sid, { model: "claude-opus-4-6", usedTokens: 50_000 });
    driver.windowsAnswer = { "claude-opus-4-6": 200_000 };
    const from = driver.sessionDirs.length;
    const got = await apply(reg, { t: "get", rid: rid(), chat, what: "context" });
    expect(got.ok && (got.result as { maxTokens: number } | null)?.maxTokens).toBe(200_000);
    expect(asked(driver, from).filter((c) => c.startsWith("usage "))).toEqual([`usage ${w.path}`]);
    expect(driver.windowReads).toEqual([s.repo]);
  });

  test("a new transcript (the old one is gone) is filed under the chat's own folder again", async () => {
    const { s, driver, store, reg } = await setup(true);
    const chat = chatOf(await apply(reg, newChatFrame("first")));
    await settle(20);
    const w = (await store.readChat(chat))!.worktree!;
    const sid = (await store.readChat(chat))!.sessionId!;
    await asleep(reg, chat);
    git(s.repo, "worktree", "remove", "--force", w.path);
    await apply(reg, send(chat, "x"));
    await apply(reg, act(chat, "project"));
    // After a restart (so nothing of the old transcript is known), Claude Code's cleanup has removed it.
    await reg.shutdown();
    const next = new ChatRegistry({ driver, store, worktreeGit: s.wg, worktreeData: s.data }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
    await next.boot();
    open.push({ s, reg: next });
    driver.sessions.delete(sid);
    driver.histories.delete(sid);
    expect((await apply(next, send(chat, "again"))).ok).toBe(true);
    expect(driver.last.input.sessionId?.value).toBe(sid);
    expect((await store.readChat(chat))!.sessionDir).toBeUndefined();
  });
});
