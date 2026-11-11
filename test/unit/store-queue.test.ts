// RD-8 (R11): a chat's queue file, `queue/<chat id>.json`, in scratch folders: the folder 0700 made and checked at
// open() with its stray `.tmp` files swept, the file 0600 through the one atomic writer, read back by the next server
// life, gone when nothing waits and at Delete, a bad file set aside, and the 4 MiB cap.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreError } from "../../server/store/files";
import { createStore, type StoreOptions } from "../../server/store/store";
import { STORE_LIMITS, type QueueRecord, type QueuedNote } from "../../server/store/types";
import { MemoryStore } from "../../server/chats/testing";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-store-queue-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const mode = (p: string) => lstatSync(p).mode & 0o777;

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const OTHER = "abcdefghijabcdefghij";
const T = "2026-11-02T12:00:00.000Z";

const note = (text: string, over: Partial<QueuedNote> = {}): QueuedNote => ({ uuid: crypto.randomUUID(), text, userText: text, uploads: [], mentions: [], at: T, ...over });
const record = (msgs: QueuedNote[], id = CHAT): QueueRecord => ({ v: 1, id, msgs });

async function opened(opts: StoreOptions = {}) {
  const root = opts.root ?? fresh();
  const writes: string[] = [];
  const setAside: string[] = [];
  const store = createStore({ ...opts, root, onWrite: (p) => writes.push(p), onSetAside: (p) => setAside.push(p) });
  await store.open();
  return { root, store, writes, setAside, file: join(root, "state", "queue", `${CHAT}.json`) };
}
const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as StoreError).code;

describe("the queue folder", () => {
  test("open() makes queue/ 0700, refuses a wider one, and sweeps a stray .tmp file there", async () => {
    const { root, store } = await opened();
    expect(store.dirs.queue).toBe(join(root, "state", "queue"));
    expect(mode(store.dirs.queue)).toBe(0o700);
    writeFileSync(join(store.dirs.queue, `.${CHAT}.json.0123456789abcdef.tmp`), "{", { mode: 0o600 });
    const next = await createStore({ root }).open();
    expect(next.swept).toBe(1);
    expect(readdirSync(store.dirs.queue)).toEqual([]);
    chmodSync(store.dirs.queue, 0o755);
    const err = (await createStore({ root })
      .open()
      .catch((e) => e)) as StoreError;
    expect(err.problems).toEqual([{ path: "queue", why: "wider-mode" }]);
  });
});

describe("the queue file", () => {
  test("is written 0600 before the write resolves, in send order, and the next server life reads it back", async () => {
    const { root, store, file, writes } = await opened();
    expect(await store.readQueue(CHAT)).toBeNull();
    const rec = record([note("first"), note("second", { uploads: ["abcdefghijklmnop"], mentions: ["src/a.ts"] })]);
    await store.writeQueue(rec);
    expect(mode(file)).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(rec);
    expect(writes).toEqual([`queue/${CHAT}.json`]);
    const next = createStore({ root });
    await next.open();
    expect(await next.readQueue(CHAT)).toEqual(rec);
  });

  test("a record with no message removes the file", async () => {
    const { store, file } = await opened();
    await store.writeQueue(record([note("one")]));
    await store.writeQueue(record([]));
    expect(existsSync(file)).toBe(false);
    expect(await store.readQueue(CHAT)).toBeNull();
    await store.writeQueue(record([]));
  });

  test("a file that fails its check is set aside and reads as none", async () => {
    const { root, store, file } = await opened();
    await store.writeQueue(record([note("one")]));
    writeFileSync(file, JSON.stringify(record([note("x", { uuid: "not-a-uuid" })])), { mode: 0o600 });
    const next = await opened({ root });
    expect(await next.store.readQueue(CHAT)).toBeNull();
    expect(next.setAside).toEqual([`queue/${CHAT}.json`]);
    expect(existsSync(`${file}.bad`)).toBe(true);
  });

  test("a bad record or a bad chat id is refused, and so is a file over 4 MiB; nothing is written", async () => {
    const { store, file } = await opened();
    expect(await code(store.writeQueue(record([note("x", { at: "yesterday" })])))).toBe("bad_value");
    expect(await code(store.writeQueue(record([note("x")], "NOT A CHAT")))).toBe("bad_value");
    const big = "y".repeat(1024 * 1024);
    expect(await code(store.writeQueue(record([note(big), note(big), note(big), note(big)])))).toBe("too_large");
    expect(existsSync(file)).toBe(false);
    expect(STORE_LIMITS.queueBytes).toBe(4 * 1024 * 1024);
  });

  test("Delete removes the file, and a later write for the chat writes nothing; another chat's file stays", async () => {
    const { store, file } = await opened();
    await store.writeQueue(record([note("one")]));
    await store.writeQueue(record([note("two")], OTHER));
    await store.deleteChat(CHAT);
    expect(existsSync(file)).toBe(false);
    await store.writeQueue(record([note("late")]));
    expect(existsSync(file)).toBe(false);
    expect((await store.readQueue(OTHER))?.msgs.map((m) => m.text)).toEqual(["two"]);
  });
});

describe("the store in memory (the registry's tests)", () => {
  test("keeps a copy, forgets an empty record and a deleted chat's", async () => {
    const store = new MemoryStore();
    const rec = record([note("one")]);
    await store.writeQueue(rec);
    rec.msgs.push(note("not written"));
    expect((await store.readQueue(CHAT))?.msgs.map((m) => m.text)).toEqual(["one"]);
    await store.writeQueue(record([]));
    expect(await store.readQueue(CHAT)).toBeNull();
    await store.writeQueue(record([note("again")]));
    await store.deleteChat(CHAT);
    expect(await store.readQueue(CHAT)).toBeNull();
  });
});
