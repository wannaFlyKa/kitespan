// A Start's worktree while git checks it out (build checklist W3): kitespan writes a record in its data folder (never
// in the repository, row 100) before `git worktree add`, so a server that dies during the checkout (a kill -9, a crash)
// leaves nothing that the next boot does not undo: the folder, git's entry and the branch go, and the page's resend
// of the same Start makes one chat. A shutdown during the checkout waits for it and discards the worktree. A worktree
// that a ledger holds is kept, and only its record goes. FIX-W25b 1.6: Unarchive and Make it again from its branch
// write the record before their add too (a remake's: no commit, since the branch is the chat's): a remake cut part way
// goes at the next boot and its branch stays; one whose add finished stays. The boot reads the records of every
// project, whatever its Worktree option says now. A stand-in for git (a shell script that runs the real one) slows the
// add.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NewChatFrame, WorktreeAct } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, apply, autoReply, projectRecord } from "../../server/chats/testing";
import { findGit } from "../../server/search/git";
import { makeWorktree, remakeWorktree } from "../../server/worktree/ops";
import { markMaking } from "../../server/worktree/pending";
import { branches, commitAll, git, scratch, type Scratch } from "./worktree-repo";

const PROJECT = "k3m7q2x4ab";
const CHAT = "abcdefghijklmnopqrst";
const GIT = findGit(process.env.PATH ?? "")!;
const rid = () => crypto.randomUUID();

let open: { s: Scratch; regs: ChatRegistry[] }[] = [];
afterEach(async () => {
  for (const o of open) {
    for (const r of o.regs) await r.shutdown();
    o.s.cleanup();
  }
  open = [];
});

function repo() {
  const s = scratch();
  const o = { s, regs: [] as ChatRegistry[] };
  open.push(o);
  return o;
}

async function registry(o: { s: Scratch; regs: ChatRegistry[] }, store: MemoryStore, wg = o.s.wg) {
  const driver = new FakeDriver();
  autoReply(driver);
  const reg = new ChatRegistry({ driver, store, worktreeGit: wg, worktreeData: o.s.data }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 5_000 });
  o.regs.push(reg);
  await reg.boot();
  return reg;
}

function worktreeStore(s: Scratch): MemoryStore {
  const store = new MemoryStore();
  store.projects = [{ ...projectRecord(PROJECT, s.repo), worktree: true }];
  return store;
}

/** A stand-in for git whose `worktree add` first runs `body` in sh. */
function slowAdd(s: Scratch, body: string): string {
  const p = join(s.root, "git-stand-in");
  writeFileSync(p, `#!/bin/sh\ncase " $* " in *" worktree add "*) ${body};; esac\nexec '${GIT}' "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const chatOf = (o: unknown) => (o as { result: { chat: string } }).result.chat;
const act = (chat: string, a: WorktreeAct) => ({ t: "worktree" as const, rid: rid(), chat, act: a });
const archive = (chat: string, on: boolean) => ({ t: "archive" as const, rid: rid(), chat, on, stop: true });
/** The smudge filter that hangs a checkout of a `.txt` file (no config of the repository names it). */
const HANG = "export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=filter.slow.smudge GIT_CONFIG_VALUE_0='sleep 20; cat' GIT_CONFIG_KEY_1=filter.slow.required GIT_CONFIG_VALUE_1=true";
const frame = (): NewChatFrame => ({ t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "Plan it", picks: { model: null, effort: null, mode: null }, uploads: [] });
/** The project's folder of the data folder: its records in the making. */
const dirOf = (s: Scratch) => join(s.data, "kitespan", "worktrees", PROJECT);
/** The project's own `.claude/worktrees`: its worktrees (row 100). */
const treesOf = (s: Scratch) => join(s.repo, ".claude", "worktrees");
const recordOf = (s: Scratch, w: { path: string }) => join(dirOf(s), `${w.path.slice(w.path.lastIndexOf("/") + 1)}.making`);
const entries = (s: Scratch) => git(s.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length ?? 0;

describe("a worktree in the making (W3)", () => {
  test(
    "a server that died during the checkout: the next boot undoes it, and the resend of the Start makes one chat",
    async () => {
      const o = repo();
      const { s } = o;
      writeFileSync(join(s.repo, ".gitattributes"), "*.txt filter=slow\n");
      writeFileSync(join(s.repo, "a.txt"), "a\n");
      commitAll(s.repo, "files");
      // The dead server's add: its checkout hangs in a smudge filter that no config of the repository names, so it is
      // still running when the next server boots (git outlives a kill -9 of its server).
      const hang = slowAdd(s, "export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=filter.slow.smudge GIT_CONFIG_VALUE_0='sleep 20; cat' GIT_CONFIG_KEY_1=filter.slow.required GIT_CONFIG_VALUE_1=true");
      const dead = makeWorktree({ ...s.wg, git: hang, addMs: 4_000 }, { root: s.repo, data: s.data, projectId: PROJECT, chatId: CHAT }, () => {});
      const path = join(treesOf(s), "abcdefgh");
      await until(() => existsSync(join(dirOf(s), "abcdefgh.making")) && existsSync(join(s.repo, ".git", "worktrees", "abcdefgh", "locked")));
      expect(branches(s.repo)).toContain("kitespan/abcdefgh");
      const store = worktreeStore(s);
      const reg = await registry(o, store);
      expect(existsSync(path)).toBe(false);
      expect(branches(s.repo)).toEqual(["main"]);
      expect(entries(s)).toBe(1);
      // The page's resend of the Start whose ack it never got: one chat, one worktree.
      const f = frame();
      const first = await apply(reg, f);
      expect(first.ok).toBe(true);
      expect(await apply(reg, f)).toEqual(first);
      expect(reg.list()).toHaveLength(1);
      expect(store.chats.size).toBe(1);
      const chat = (first as { result: { chat: string } }).result.chat;
      expect(branches(s.repo)).toEqual([`kitespan/${chat.slice(0, 8)}`, "main"].sort());
      // The new chat's ledger holds its worktree, so its record is gone; the dead add ends at its own deadline.
      expect(readdirSync(dirOf(s))).toEqual([]);
      expect(readdirSync(treesOf(s))).toEqual([chat.slice(0, 8)]);
      expect(await dead).toEqual({ ok: false, why: "failed" });
      expect(readdirSync(dirOf(s))).toEqual([]);
      expect(readdirSync(treesOf(s))).toEqual([chat.slice(0, 8)]);
      expect(entries(s)).toBe(2);
    },
    20_000,
  );

  test("a shutdown during the checkout waits for it, then discards the worktree: nothing is left", async () => {
    const o = repo();
    const { s } = o;
    const store = worktreeStore(s);
    const reg = await registry(o, store, { ...s.wg, git: slowAdd(s, "sleep 0.6") });
    const start = apply(reg, frame());
    await until(() => existsSync(dirOf(s)) && readdirSync(dirOf(s)).some((f) => f.endsWith(".making")));
    await reg.shutdown();
    // What the server leaves as it exits right after its shutdown.
    expect(readdirSync(dirOf(s))).toEqual([]);
    expect(readdirSync(treesOf(s))).toEqual([]);
    expect(branches(s.repo)).toEqual(["main"]);
    expect(entries(s)).toBe(1);
    expect(store.chats.size).toBe(0);
    expect(await start).toEqual({ ok: false, code: "restarting" });
  });

  test("a worktree that a ledger holds is kept at boot, and only its record goes", async () => {
    const o = repo();
    const { s } = o;
    const store = worktreeStore(s);
    const reg = await registry(o, store);
    const made = await apply(reg, frame());
    const chat = (made as { result: { chat: string } }).result.chat;
    const w = (await store.readChat(chat))!.worktree!;
    expect(w.path).toBe(join(treesOf(s), chat.slice(0, 8)));
    expect(readdirSync(dirOf(s))).toEqual([]);
    // As a crash between the ledger's write and the record's removal leaves it.
    expect(await markMaking(w, dirOf(s))).toBe(true);
    expect(readdirSync(dirOf(s))).toEqual([`${chat.slice(0, 8)}.making`]);
    await reg.shutdown();
    await registry(o, store);
    expect(readdirSync(dirOf(s))).toEqual([]);
    expect(existsSync(join(w.path, "README.md"))).toBe(true);
    expect(branches(s.repo)).toContain(w.branch);
  });

  test("the boot reads the records of every project, also one whose Worktree option is off now", async () => {
    const o = repo();
    const { s } = o;
    // A Start's add that finished before its server died, and no ledger holds it; then the user turned Worktree off.
    const made = await makeWorktree(s.wg, { root: s.repo, data: s.data, projectId: PROJECT, chatId: CHAT }, () => {});
    expect(made.ok).toBe(true);
    expect(readdirSync(dirOf(s))).toEqual(["abcdefgh.making"]);
    expect(readdirSync(treesOf(s))).toEqual(["abcdefgh"]);
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT, s.repo)];
    await registry(o, store);
    expect(readdirSync(dirOf(s))).toEqual([]);
    expect(readdirSync(treesOf(s))).toEqual([]);
    expect(branches(s.repo)).toEqual(["main"]);
    expect(entries(s)).toBe(1);
  });

  test(
    "Unarchive's remake writes its record first: a server that died during its checkout leaves nothing half made, and the branch stays",
    async () => {
      const o = repo();
      const { s } = o;
      writeFileSync(join(s.repo, ".gitattributes"), "*.txt filter=slow\n");
      writeFileSync(join(s.repo, "a.txt"), "a\n");
      commitAll(s.repo, "files");
      const store = worktreeStore(s);
      const first = await registry(o, store);
      const chat = chatOf(await apply(first, frame()));
      const w = (await store.readChat(chat))!.worktree!;
      // Archive of the clean worktree removes it; its branch stays.
      await apply(first, archive(chat, true));
      await until(() => !existsSync(w.path));
      await first.shutdown();
      // The dead server's Unarchive: its remake's checkout hangs, and its record is there before the add.
      const dead = remakeWorktree({ ...s.wg, git: slowAdd(s, HANG), addMs: 4_000 }, w, s.data, PROJECT, () => {});
      const admin = join(s.repo, ".git", "worktrees", w.path.slice(w.path.lastIndexOf("/") + 1));
      await until(() => existsSync(recordOf(s, w)) && existsSync(join(admin, "locked")));
      expect(existsSync(w.path)).toBe(true);
      // The next boot: the half-made worktree and its record go; the chat's branch stays.
      const next = await registry(o, store);
      expect(existsSync(w.path)).toBe(false);
      expect(existsSync(recordOf(s, w))).toBe(false);
      expect(branches(s.repo)).toContain(w.branch);
      expect(entries(s)).toBe(1);
      expect(await dead).toBe(false);
      expect(readdirSync(dirOf(s))).toEqual([]);
      // Unarchive in the new server makes it again from its branch, with no record left.
      await apply(next, archive(chat, false));
      expect(existsSync(join(w.path, "a.txt"))).toBe(true);
      expect(git(w.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(w.branch);
      expect(readdirSync(dirOf(s))).toEqual([]);
      expect(readdirSync(treesOf(s))).toEqual([chat.slice(0, 8)]);
    },
    20_000,
  );

  test("Make it again from its branch writes its record before the add, and removes it once the worktree is back", async () => {
    const o = repo();
    const { s } = o;
    const store = worktreeStore(s);
    const reg = await registry(o, store, { ...s.wg, git: slowAdd(s, "sleep 0.6") });
    const chat = chatOf(await apply(reg, frame()));
    const w = (await store.readChat(chat))!.worktree!;
    await apply(reg, archive(chat, true));
    await until(() => !existsSync(w.path));
    await apply(reg, archive(chat, false));
    expect(existsSync(w.path)).toBe(true);
    // The user removes it by hand; the next start is refused (W4), then Make it again.
    git(s.repo, "worktree", "remove", "--force", w.path);
    expect(await apply(reg, { t: "send", rid: rid(), chat, uuid: rid(), text: "again?", draftRev: null, uploads: [] })).toEqual({ ok: false, code: "worktree_gone" });
    const again = apply(reg, act(chat, "again"));
    // The stand-in sleeps before the add: the record is there meanwhile, and the folder is not yet.
    await until(() => existsSync(recordOf(s, w)));
    expect(existsSync(w.path)).toBe(false);
    expect(await again).toEqual({ ok: true, result: { started: false } });
    expect(existsSync(recordOf(s, w))).toBe(false);
    expect(existsSync(join(w.path, "README.md"))).toBe(true);
  }, 20_000);

  test("a remake whose add finished before its record went: the next boot keeps the worktree, and the record goes", async () => {
    const o = repo();
    const { s } = o;
    const store = worktreeStore(s);
    const reg = await registry(o, store);
    const chat = chatOf(await apply(reg, frame()));
    const w = (await store.readChat(chat))!.worktree!;
    writeFileSync(join(w.path, "notes.txt"), "work in progress\n");
    // As a crash between a remake's add and its record's removal leaves it (the remake's record has no commit).
    expect(await markMaking(w, dirOf(s), true)).toBe(true);
    await reg.shutdown();
    await registry(o, store);
    expect(readdirSync(dirOf(s))).toEqual([]);
    expect(readdirSync(treesOf(s))).toEqual([chat.slice(0, 8)]);
    expect(existsSync(join(w.path, "notes.txt"))).toBe(true);
    expect(branches(s.repo)).toContain(w.branch);
  });
});
