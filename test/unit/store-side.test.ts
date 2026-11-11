// R124: a chat's side file, `side/<chat id>.json` (store/side.ts), in scratch folders: the folder 0700 made and
// checked at open() with its stray `.tmp` files swept, the file 0600 through the one atomic writer and read back by the
// next server life, a bad file set aside, the shape and the 1 MiB cap checked on write, and Delete removing it (a late
// write for a deleted chat is dropped).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SideExchange } from "../../shared/protocol";
import { StoreError } from "../../server/store/files";
import { SIDE_FILE_BYTES, sideRecordOf, type SideRecord } from "../../server/store/side";
import { createStore, type StoreOptions } from "../../server/store/store";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-store-side-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const mode = (p: string) => lstatSync(p).mode & 0o777;

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const T = "2026-11-04T12:00:00.000Z";
const ex = (i: number, over: Partial<SideExchange> = {}): SideExchange => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, question: `Q${i}`, at: T, state: "answered", answer: `A${i}`, ...over });
const record = (exchanges: SideExchange[], rev = 3, id = CHAT): SideRecord => ({ v: 1, id, rev, exchanges });

async function opened(opts: StoreOptions = {}) {
  const root = opts.root ?? fresh();
  const writes: string[] = [];
  const setAside: string[] = [];
  const store = createStore({ ...opts, root, onWrite: (p) => writes.push(p), onSetAside: (p) => setAside.push(p) });
  await store.open();
  return { root, store, writes, setAside, file: join(root, "state", "side", `${CHAT}.json`) };
}
const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as StoreError).code;

describe("the side file", () => {
  test("its folder is made 0700 at open(), and a stray temporary file there is swept", async () => {
    const { root, store } = await opened();
    expect(store.dirs.side).toBe(join(root, "state", "side"));
    expect(mode(store.dirs.side)).toBe(0o700);
    writeFileSync(join(store.dirs.side, `.${CHAT}.json.0123456789abcdef.tmp`), "{", { mode: 0o600 });
    const again = createStore({ root });
    expect((await again.open()).swept).toBe(1);
    expect(readdirSync(again.dirs.side)).toEqual([]);
  });

  test("written at once, 0600, and read back by the next server life as it was", async () => {
    const { root, store, writes, file } = await opened();
    expect(await store.readSide(CHAT)).toBeNull();
    const rec = record([ex(1), ex(2, { synthetic: true, fallback: "Sonnet answered." }), ex(3, { state: "asking", answer: undefined, retry: { attempt: 2, max: 10, delayMs: 4000 } })]);
    await store.writeSide(rec);
    expect(writes).toEqual([`side/${CHAT}.json`]);
    expect(mode(file)).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(rec);
    const next = createStore({ root });
    await next.open();
    expect(await next.readSide(CHAT)).toEqual(rec);
  });

  test("a file that fails its check is set aside as .bad and reads as none", async () => {
    for (const body of ["{", JSON.stringify({ v: 2, id: CHAT, rev: 1, exchanges: [] }), JSON.stringify(record([ex(1)], 1, "abcdefghijabcdefghij")), JSON.stringify(record([ex(1, { state: "failed", answer: undefined, error: "failed" }), ex(2)]))]) {
      const { store, setAside, file } = await opened();
      writeFileSync(file, body, { mode: 0o600 });
      expect(await store.readSide(CHAT)).toBeNull();
      expect(setAside).toEqual([`side/${CHAT}.json`]);
      expect(existsSync(`${file}.bad`)).toBe(true);
      expect(existsSync(file)).toBe(false);
    }
  });

  test("a write that breaks the shape or the cap is refused, and nothing is written", async () => {
    const { store, file } = await opened();
    expect(await code(store.writeSide(record([ex(1, { state: "asking", answer: undefined }), ex(2)])))).toBe("bad_value");
    expect(await code(store.writeSide(record(Array.from({ length: 21 }, (_, i) => ex(i + 1)))))).toBe("bad_value");
    expect(await code(store.writeSide(record([ex(1, { fallback: "via arn:aws:bedrock:x" })])))).toBe("bad_value");
    const big = (i: number) => ex(i, { question: "问".repeat(5000), answer: "答".repeat(20000) });
    expect(await code(store.writeSide(record(Array.from({ length: 20 }, (_, i) => big(i + 1)))))).toBe("too_large");
    expect(existsSync(file)).toBe(false);
    expect(SIDE_FILE_BYTES).toBe(1024 * 1024);
  });

  test("Delete removes it, and a late write for the deleted chat is dropped", async () => {
    const { store, file } = await opened();
    await store.writeSide(record([ex(1)]));
    expect(existsSync(file)).toBe(true);
    await store.deleteChat(CHAT);
    expect(existsSync(file)).toBe(false);
    await store.writeSide(record([ex(1), ex(2)], 4));
    expect(existsSync(file)).toBe(false);
    expect(await store.readSide(CHAT)).toBeNull();
  });

  test("the read check: the id matches the file, each exchange is checked, ids are unique", () => {
    expect(sideRecordOf(record([ex(1)]), CHAT)).toEqual(record([ex(1)]));
    expect(sideRecordOf(record([ex(1)]), "abcdefghijabcdefghij")).toBeNull();
    expect(sideRecordOf(record([ex(1), ex(1)]))).toBeNull();
    expect(sideRecordOf({ ...record([]), rev: -1 })).toBeNull();
    expect(sideRecordOf({ ...record([]), rev: 1.5 })).toBeNull();
    expect(sideRecordOf(record([{ ...ex(1), question: "" }]))).toBeNull();
    expect(sideRecordOf({ ...record([ex(1)]), extra: true })).toEqual(record([ex(1)]));
  });
});
