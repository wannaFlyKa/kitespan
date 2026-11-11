// The new-chat form's box on the server (D59, owner row 75): its mention chips, resolved inside the project's folder
// with a send's rules (server/search/mention.ts) and referenced after the upload chips (messageRef), the first user
// event and the chat's notes naming their paths, `mention_gone` with no chat made when one is not a file there; and
// the project's last command list, kept with the project from any of its chats' `commands`.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageRef, type ChatEvent, type CommandInfo, type NewChatFrame } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { PROJECT_COMMANDS } from "../../server/chats/project-commands";
import { FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle, uploadRecord } from "../../server/chats/testing";
import type { ProjectRecord } from "../../server/store/types";

const PROJECT = "k3m7q2x4ab";
const UP1 = "abcdefghijklmnop";
const rid = () => crypto.randomUUID();

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-new-chat-form-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const FOLDER = join(ROOT, "app");
const OUTSIDE = join(ROOT, "outside");
for (const f of ["src/upload.ts", "docs/my notes.md", "README.md"]) {
  mkdirSync(join(FOLDER, f, ".."), { recursive: true });
  writeFileSync(join(FOLDER, f), "x\n");
}
mkdirSync(OUTSIDE);
writeFileSync(join(OUTSIDE, "secret.txt"), "SECRET\n");
symlinkSync(join(OUTSIDE, "secret.txt"), join(FOLDER, "leak.txt"));
symlinkSync("../outside", join(FOLDER, "out-dir"));

/** A store that counts the project table's writes. */
class CountingStore extends MemoryStore {
  projectWrites = 0;
  override async putProject(rec: ProjectRecord): Promise<void> {
    this.projectWrites++;
    await super.putProject(rec);
  }
}

let clock = Date.parse("2026-11-02T10:00:00.000Z");
async function setup() {
  const driver = new FakeDriver();
  const store = new CountingStore();
  store.projects = [projectRecord(PROJECT, FOLDER)];
  const reg = new ChatRegistry({ driver, store, now: () => new Date(clock) }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
  await reg.boot();
  return { driver, store, reg };
}

function newChat(text: string, over: Partial<NewChatFrame> = {}): NewChatFrame {
  return { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text, picks: { model: null, effort: null, mode: null }, uploads: [], ...over };
}

const ref = (rel: string) => messageRef(join(FOLDER, rel));

describe("new_chat with mention chips", () => {
  test("each chip's reference follows the text and the upload chips; the first user event and the notes name the paths", async () => {
    const { reg, driver, store } = await setup();
    store.uploads.set(UP1, uploadRecord(UP1, null, PROJECT, "red.png"));
    const f = newChat("compare these", { uploads: [UP1], mentions: ["src/upload.ts", "docs/my notes.md"] });
    const o = await apply(reg, f);
    expect(o.ok).toBe(true);
    const chat = (o as { result: { chat: string } }).result.chat;
    const text = `compare these @/tmp/kitespan-uploads-test/u-abcdef/red.png ${ref("src/upload.ts")} ${ref("docs/my notes.md")}`;
    expect(text).toContain(`@"${FOLDER}/docs/my notes.md"`);
    expect(driver.last.sent).toEqual([{ uuid: f.uuid, text }]);
    // The title is the user's own text, never the references.
    expect(reg.list().find((r) => r.chat === chat)?.title).toBe("compare these");
    const p = (await reg.attach(chat, new RecordingViewer("tab_b")))!;
    const users = p.tail.map((i) => i.e).filter((e): e is Extract<ChatEvent, { k: "user" }> => e.k === "user");
    expect(users).toEqual([{ k: "user", uuid: f.uuid, text, queued: false, mentions: ["src/upload.ts", "docs/my notes.md"] }]);
    await settle();
    expect(store.notes.get(chat)?.mentions).toEqual([{ uuid: f.uuid, paths: ["src/upload.ts", "docs/my notes.md"] }]);
  });

  test("a first message of chips only", async () => {
    const { reg, driver } = await setup();
    expect((await apply(reg, newChat("", { mentions: ["README.md"] }))).ok).toBe(true);
    expect(driver.last.sent[0]!.text).toBe(ref("README.md"));
  });

  test("a chip that is not a file in the project's folder: mention_gone, no chat made, no upload claimed, nothing started", async () => {
    const { reg, driver, store } = await setup();
    store.uploads.set(UP1, uploadRecord(UP1, null, PROJECT, "red.png"));
    for (const bad of ["src/gone.ts", "leak.txt", "out-dir/secret.txt", "src"]) {
      expect(await apply(reg, newChat("x", { uploads: [UP1], mentions: ["README.md", bad] }))).toEqual({ ok: false, code: "mention_gone" });
    }
    expect(reg.list()).toEqual([]);
    expect(driver.opens.length).toBe(0);
    expect(store.uploads.get(UP1)?.chat).toBeNull();
    expect(store.chats.size).toBe(0);
  });

  test("a start that fails puts the first message back in the new chat's draft, with its chips", async () => {
    const { reg, driver, store } = await setup();
    driver.openThrows = true;
    const o = await apply(reg, newChat("see", { mentions: ["README.md"] }));
    expect(o.ok).toBe(true);
    await settle(10);
    const chat = (o as { result: { chat: string } }).result.chat;
    expect(store.drafts.get(chat)).toMatchObject({ text: "see", mentions: ["README.md"] });
  });
});

describe("the project's last command list, from any of its chats", () => {
  const row = (name: string, over: Partial<CommandInfo> = {}): CommandInfo => ({ name, description: `${name} it`, argumentHint: "", aliases: [], builtin: false, terminalOnly: false, ...over });

  test("a chat's commands event is kept with its project, with the time; the same list again within the hour is not written", async () => {
    const { reg, driver, store } = await setup();
    expect((await apply(reg, newChat("first"))).ok).toBe(true);
    const writes = store.projectWrites;
    const list = [row("compact", { builtin: true }), row("exit", { builtin: true, terminalOnly: true }), row("review-notes", { argumentHint: "[file]", aliases: ["rn"] })];
    driver.last.emit({ k: "commands", list });
    await settle(10);
    expect(store.projects[0]!.commands).toEqual({ at: new Date(clock).toISOString(), list });
    expect(store.projectWrites).toBe(writes + 1);
    // The same list: no write while the kept one is fresh; past the refresh time, written again with the new time.
    clock += 60_000;
    driver.last.emit({ k: "commands", list });
    await settle(10);
    expect(store.projectWrites).toBe(writes + 1);
    clock += PROJECT_COMMANDS.refreshMs;
    driver.last.emit({ k: "commands", list });
    await settle(10);
    expect(store.projectWrites).toBe(writes + 2);
    expect(store.projects[0]!.commands?.at).toBe(new Date(clock).toISOString());
    // Another list replaces it at once.
    driver.last.emit({ k: "commands", list: [row("compact", { builtin: true })] });
    await settle(10);
    expect(store.projects[0]!.commands?.list.map((c) => c.name)).toEqual(["compact"]);
  });

  test("a `get commands` of a live chat keeps its answer too; the project's picks and last use stay", async () => {
    const { reg, driver, store } = await setup();
    const o = await apply(reg, newChat("first", { picks: { model: "claude-fake-1", effort: null, mode: null } }));
    const chat = (o as { result: { chat: string } }).result.chat;
    await settle(10);
    const before = store.projects[0]!;
    expect(before.picks.model?.value).toBe("claude-fake-1");
    driver.last.commandList = [row("context", { builtin: true })];
    expect(await apply(reg, { t: "get", rid: rid(), chat, what: "commands" })).toEqual({ ok: true, result: driver.last.commandList });
    await settle(10);
    const after = store.projects[0]!;
    expect(after.commands?.list).toEqual(driver.last.commandList);
    expect({ picks: after.picks, lastUsedAt: after.lastUsedAt }).toEqual({ picks: before.picks, lastUsedAt: before.lastUsedAt });
  });

  test("a new chat's remembered picks never drop a list that was kept meanwhile", async () => {
    const { reg, driver, store } = await setup();
    let release!: () => void;
    driver.probeWait = new Promise<void>((r) => (release = r));
    const started = apply(reg, newChat("first", { picks: { model: "claude-fake-1", effort: null, mode: null } }));
    await settle();
    // While the new chat's start probes the binary, the project's list arrives (the form's short read, another chat).
    store.projects[0] = { ...store.projects[0]!, commands: { at: new Date(clock).toISOString(), list: [row("compact")] } };
    release();
    expect((await started).ok).toBe(true);
    expect(store.projects[0]!.commands?.list.map((c) => c.name)).toEqual(["compact"]);
    expect(store.projects[0]!.picks.model?.value).toBe("claude-fake-1");
  });
});
