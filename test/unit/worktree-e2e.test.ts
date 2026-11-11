// Row 73 end to end in one process (build checklist W3, W5): the chat registry, the real Claude driver and the SDK,
// the fake claude, and kitespan's own git on a scratch repository. Two chats of a worktree project get two worktrees
// and two branches, and each fake's argv has its own cwd and `--project-config-root=<project folder>` as one argument.
// A resume that Claude Code refuses (`worktree_resume_refused`) shows its line with its code, and nothing starts
// again by itself. The SDK's session reads are fakes, so no folder of the user's own Claude Code is read.
import { afterAll, describe, expect, test } from "bun:test";
import { ChatRegistry } from "../../server/chats/registry";
import { MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import type { ChatEvent, NewChatFrame } from "../../shared/protocol";
import { rig, type Rig } from "../fake-claude/harness";
import { branches, scratch } from "./worktree-repo";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();
const s = scratch();
const LINE = "Error: cannot resume into worktree /x/wt: it failed its safety checks. This session was not started.";
const fakes = {
  resolveSettings: (async () => ({ effective: {} })) as never,
  filterEscalatingDefaultMode: ((x: unknown) => x) as never,
  getSessionInfo: (async () => undefined) as never,
  getSessionMessages: (async () => []) as never,
};
const r: Rig = rig({ startupFailure: { reason: "worktree_resume_refused", errors: [LINE], onResume: true } }, { knownFolders: () => [s.repo], sdk: fakes });
const store = new MemoryStore();
store.projects = [{ ...projectRecord(PROJECT, s.repo), worktree: true }];
const reg = new ChatRegistry({ driver: r.driver, store, worktreeGit: s.wg, worktreeData: s.data }, { idleMs: 60_000, closeGraceMs: 2_000, shutdownMs: 8_000 });
afterAll(async () => {
  await reg.shutdown();
  await r.cleanup();
  s.cleanup();
});

const newChat = async (text: string): Promise<string> => {
  const f: NewChatFrame = { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] };
  const o = await apply(reg, f);
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  return (o.result as { chat: string }).chat;
};
async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("a worktree project with the fake claude", () => {
  test("two chats: two worktrees, two branches, and each Claude Code in its own with the project's config root", async () => {
    await reg.boot();
    const a = await newChat("first");
    const b = await newChat("second");
    await r.fake.waitFor((l) => l.t === "turn_end" && l.n === 1, 10_000);
    await until(() => r.fake.trace().filter((l) => l.t === "turn_end").length >= 2);
    const la = (await store.readChat(a))!;
    const lb = (await store.readChat(b))!;
    expect(branches(s.repo)).toEqual([`kitespan/${a.slice(0, 8)}`, `kitespan/${b.slice(0, 8)}`, "main"].sort());
    const starts = r.fake.trace().filter((l) => l.t === "start");
    expect(starts.map((l) => l.cwd).sort()).toEqual([la.cwd, lb.cwd].sort());
    for (const st of starts) expect((st.args as string[]).filter((x) => x.startsWith("--project-config-root"))).toEqual([`--project-config-root=${s.repo}`]);
  });

  test("a refused resume: its line and code, the message back in the box, and no start by itself", async () => {
    const chat = reg.list()[0]!.chat;
    await apply(reg, { t: "archive", rid: rid(), chat, on: true, stop: true });
    await until(() => !reg.processLives(chat));
    await apply(reg, { t: "archive", rid: rid(), chat, on: false, stop: false });
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const before = r.fake.trace().filter((l) => l.t === "start").length;
    const u = rid();
    expect((await apply(reg, { t: "send", rid: u, chat, uuid: u, text: "go on", draftRev: null, uploads: [] })).ok).toBe(true);
    await until(() => v.events.some((e: ChatEvent) => e.k === "notice" && e.code === "worktree_resume_refused"));
    expect(v.of("notice").at(-1)).toEqual({ k: "notice", text: LINE, code: "worktree_resume_refused", id: expect.any(String) });
    expect(r.fake.trace().some((l) => l.t === "startup_failure")).toBe(true);
    await settle(20);
    expect(reg.draftOf(chat)?.text).toBe("go on");
    expect((await store.readChat(chat))!.refused).toBe("worktree_resume_refused");
    await Bun.sleep(500);
    expect(r.fake.trace().filter((l) => l.t === "start").length).toBe(before + 1);
  });
});
