// D60 in the registry (build checklist E3, E4, L38, L39): each start of a chat's Claude Code reads its environment's
// variables right before the start and passes them marked; a chat with none passes no env; an environment whose file
// could not be read starts nothing (`env_unreadable`); the live chat keeps the set it started with, which its `!`
// commands get; its next start (a resume) gets the set as it is then. The scripted driver stands in for Claude Code.
import { describe, expect, test } from "bun:test";
import { MARK_PHRASES, type EnvVar } from "../../server/agents/types";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import { ERROR_MESSAGES } from "../../shared/protocol";
import type { BashResult, BashRunner } from "../../server/chats/types";
import type { EnvSource } from "../../server/env/store";

const PROJECT = "k3m7q2x4ab";
const OTHER = "a2b3c4d5e6";
const CWD = "/srv/work/app";
const rid = () => crypto.randomUUID();
const SECRET = "planted-registry-env-value-M1";

/** The environments' variables by project; a project in `unreadable` reads as null. */
class TestEnv implements EnvSource {
  readonly sets = new Map<string, EnvVar[]>();
  readonly unreadable = new Set<string>();
  vars(project: string): readonly EnvVar[] | null {
    if (this.unreadable.has(project)) return null;
    return this.sets.get(project) ?? [];
  }
}

/** A `!` runner that keeps the variables each command got. */
class EnvBash implements BashRunner {
  readonly runs: { command: string; env: readonly EnvVar[] | undefined }[] = [];
  async run(input: { command: string; cwd: string; signal: AbortSignal; env?: readonly EnvVar[] }): Promise<BashResult> {
    this.runs.push({ command: input.command, env: input.env });
    return { stdout: "", stderr: "", code: 0, ms: 1, timedOut: false, capped: false };
  }
}

async function setup() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT, CWD), projectRecord(OTHER, "/srv/work/other")];
  store.settingsValue = { ...store.settingsValue, "chats.bashReply": "never" };
  const env = new TestEnv();
  const bash = new EnvBash();
  const reg = new ChatRegistry({ driver, store, bash, env }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 60_000 });
  await reg.boot();
  autoReply(driver);
  return { driver, store, env, bash, reg };
}

const newChat = (project = PROJECT, text = "hello") => ({ t: "new_chat" as const, rid: rid(), project, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [] });
const send = (chat: string, text: string) => {
  const r = rid();
  return { t: "send" as const, rid: r, chat, uuid: r, text, draftRev: null, uploads: [] };
};
const chatOf = (o: { ok: boolean; result?: unknown }) => (o.result as { chat: string }).chat;

describe("the chat start reads the environment's variables (E3)", () => {
  test("they go marked with the env phrase, in the user's order; a project with none passes no env", async () => {
    const { reg, driver, env } = await setup();
    env.sets.set(PROJECT, [
      { name: "B_FIRST", value: SECRET },
      { name: "A_SECOND", value: "2" },
    ]);
    const o = await apply(reg, newChat());
    expect(o.ok).toBe(true);
    const input = driver.last.input;
    expect(input.env?.value).toEqual([
      { name: "B_FIRST", value: SECRET },
      { name: "A_SECOND", value: "2" },
    ]);
    expect(input.env?.mark).toStartWith(`${MARK_PHRASES.env} on `);
    expect(await apply(reg, newChat(OTHER))).toMatchObject({ ok: true });
    expect(driver.last.input.env ?? null).toBeNull();
  });

  test("the live chat keeps its set; `!` gets it; the next start (a resume) gets the set as it is then", async () => {
    const { reg, driver, env, bash } = await setup();
    env.sets.set(PROJECT, [{ name: "TOKEN", value: "first" }]);
    const chat = chatOf(await apply(reg, newChat()));
    await settle();
    const first = driver.last;
    env.sets.set(PROJECT, [{ name: "TOKEN", value: "second" }]);
    expect(await apply(reg, { t: "bash", rid: rid(), chat, input: "echo $TOKEN", draftRev: null, uploads: [] })).toMatchObject({ ok: true });
    await settle(20);
    expect(bash.runs).toEqual([{ command: "echo $TOKEN", env: [{ name: "TOKEN", value: "first" }] }]);
    expect(driver.opens).toHaveLength(1);
    // The process ends; the next message starts it again, a resume, with the new value.
    first.end();
    await settle(20);
    expect(await apply(reg, send(chat, "again"))).toMatchObject({ ok: true });
    await settle();
    expect(driver.opens).toHaveLength(2);
    expect(driver.last.input.resume?.value).toBe(first.input.sessionId?.value);
    expect(driver.last.input.env?.value).toEqual([{ name: "TOKEN", value: "second" }]);
  });

  test("a chat whose environment has none: no env key at the start, and `!` gets none", async () => {
    const { reg, driver, bash } = await setup();
    const chat = chatOf(await apply(reg, newChat()));
    await settle();
    expect(driver.last.input.env ?? null).toBeNull();
    await apply(reg, { t: "bash", rid: rid(), chat, input: "pwd", draftRev: null, uploads: [] });
    await settle(20);
    expect(bash.runs[0]!.env).toEqual([]);
  });
});

describe("a file that could not be read stops the environment's chats (L39)", () => {
  test("New chat refuses with env_unreadable and makes no chat; another environment starts", async () => {
    const { reg, driver, env } = await setup();
    env.unreadable.add(PROJECT);
    expect(await apply(reg, newChat())).toEqual({ ok: false, code: "env_unreadable" });
    expect(reg.list()).toEqual([]);
    expect(driver.opens).toHaveLength(0);
    expect(await apply(reg, newChat(OTHER))).toMatchObject({ ok: true });
    expect(driver.opens).toHaveLength(1);
  });

  test("a send to a sleeping chat refuses with env_unreadable and starts nothing; once readable it starts", async () => {
    const { reg, driver, env } = await setup();
    const chat = chatOf(await apply(reg, newChat()));
    await settle();
    driver.last.end();
    await settle(20);
    env.unreadable.add(PROJECT);
    expect(await apply(reg, send(chat, "go on"))).toEqual({ ok: false, code: "env_unreadable" });
    expect(driver.opens).toHaveLength(1);
    expect(await apply(reg, { t: "bash", rid: rid(), chat, input: "ls", draftRev: null, uploads: [] })).toEqual({ ok: false, code: "env_unreadable" });
    expect(driver.opens).toHaveLength(1);
    env.unreadable.delete(PROJECT);
    expect(await apply(reg, send(chat, "go on"))).toMatchObject({ ok: true });
    expect(driver.opens).toHaveLength(2);
  });

  test("a message that waited for a start that the file refused gets the line with its code, env_unreadable", async () => {
    const driver = new FakeDriver();
    const store = new MemoryStore();
    store.projects = [projectRecord(PROJECT, CWD), projectRecord(OTHER, "/srv/work/other")];
    const env = new TestEnv();
    const reg = new ChatRegistry({ driver, store, env }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 60_000, maxLive: 1 });
    await reg.boot();
    // The other environment's chat runs a turn, so the new chat waits for its slot, Queued.
    expect((await apply(reg, newChat(OTHER))).ok).toBe(true);
    const o = await apply(reg, newChat());
    const chat = chatOf(o);
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    env.unreadable.add(PROJECT);
    driver.opens[0]!.emit({ k: "turn_end", ok: true, subtype: "success", durationMs: 5, error: null, uuids: [] });
    await settle(20);
    expect(driver.opens).toHaveLength(1);
    expect(v.of("notice")).toContainEqual({ k: "notice", text: ERROR_MESSAGES.env_unreadable, code: "env_unreadable" });
    await reg.shutdown();
  });
});
