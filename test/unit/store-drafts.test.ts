// The server's drafts (D49, DESIGN.md 4.4 "drafts/<chat id>.json", 8.1 Drafts): in memory first, a file at most once
// a second per chat and at shutdown, the caps, the 128 KiB check, and a bad file that reads as an empty draft.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreError } from "../../server/store/files";
import { createStore, type StoreOptions } from "../../server/store/store";
import type { DraftRecord } from "../../server/store/types";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-store-drafts-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const T = "2026-10-31T12:00:00.000Z";
const UP = "aaaaaaaaaaaaaaaa";
const EMOJI = "\u{1F600}";

const draft = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  v: 1,
  id: CHAT,
  rev: 1,
  text: "hello",
  mode: "chat",
  command: null,
  link: false,
  uploads: [],
  by: "tab-1",
  at: T,
  ...over,
});

async function opened(opts: StoreOptions = {}) {
  const root = opts.root ?? fresh();
  const writes: string[] = [];
  const setAside: string[] = [];
  const store = createStore({ draftWriteMs: 200, ...opts, root, onWrite: (p) => writes.push(p), onSetAside: (p) => setAside.push(p) });
  await store.open();
  return { root, store, writes, setAside, file: join(root, "state", "drafts", `${CHAT}.json`) };
}

const onDisk = (file: string) => JSON.parse(readFileSync(file, "utf8")) as DraftRecord;
/** Wait until `ok()` holds, at most about two seconds. */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(20);
}

describe("the draft store", () => {
  test("a chat with no draft file reads as an empty draft with rev 0", async () => {
    const { store, file } = await opened();
    const d = await store.readDraft(CHAT);
    expect(d).toMatchObject({ v: 1, id: CHAT, rev: 0, text: "", mode: "chat", command: null, link: false, uploads: [], by: null });
    expect(d.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(existsSync(file)).toBe(false);
  });

  test("a save is in memory at once and on disk 0600 soon after", async () => {
    const { store, file } = await opened();
    store.saveDraft(draft());
    expect((await store.readDraft(CHAT)).text).toBe("hello");
    await until(() => existsSync(file));
    expect(onDisk(file).text).toBe("hello");
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  test("the file is written at most once per window, with the newest state then", async () => {
    const { store, writes, file } = await opened({ draftWriteMs: 400 });
    store.saveDraft(draft({ rev: 1, text: "a" }));
    await until(() => writes.length > 0);
    expect(writes.length).toBe(1);
    store.saveDraft(draft({ rev: 2, text: "ab" }));
    store.saveDraft(draft({ rev: 3, text: "abc" }));
    await Bun.sleep(60);
    expect(writes.length).toBe(1);
    expect(onDisk(file).text).toBe("a");
    expect((await store.readDraft(CHAT)).text).toBe("abc");
    await until(() => writes.length > 1);
    expect(writes.length).toBe(2);
    expect(onDisk(file)).toMatchObject({ rev: 3, text: "abc" });
  });

  test("flush writes a pending draft at once (shutdown)", async () => {
    const { store, writes, file } = await opened({ draftWriteMs: 60_000 });
    store.saveDraft(draft({ rev: 1, text: "first" }));
    await until(() => writes.length > 0);
    store.saveDraft(draft({ rev: 2, text: "second" }));
    expect(onDisk(file).text).toBe("first");
    await store.flush();
    expect(writes.length).toBe(2);
    expect(onDisk(file).text).toBe("second");
  });

  test("rev survives a restart, and an empty draft keeps its record", async () => {
    const { root, store, file } = await opened();
    store.saveDraft(draft({ rev: 5, text: "kept" }));
    await store.flush();
    store.saveDraft(draft({ rev: 6, text: "", by: "tab-2" }));
    await store.flush();
    expect(onDisk(file)).toMatchObject({ rev: 6, text: "" });
    const again = createStore({ root });
    await again.open();
    expect(await again.readDraft(CHAT)).toMatchObject({ rev: 6, text: "", by: "tab-2" });
  });

  test("the text cap: just under, at and over 20,000 UTF-16 units", async () => {
    const { store } = await opened();
    for (const [len, kept] of [
      [19_999, 19_999],
      [20_000, 20_000],
      [20_001, 20_000],
    ] as const) {
      store.saveDraft(draft({ text: "a".repeat(len) }));
      expect((await store.readDraft(CHAT)).text.length).toBe(kept);
    }
  });

  test("the cut never lands inside a surrogate pair", async () => {
    const { store } = await opened();
    store.saveDraft(draft({ text: "a".repeat(19_999) + EMOJI }));
    const cut = (await store.readDraft(CHAT)).text;
    expect(cut).toBe("a".repeat(19_999));
    store.saveDraft(draft({ text: "a".repeat(19_998) + EMOJI + "b" }));
    expect((await store.readDraft(CHAT)).text).toBe("a".repeat(19_998) + EMOJI);
  });

  test("the chip only in slash mode and cut at 120; at most 100 uploads", async () => {
    const { store } = await opened();
    store.saveDraft(draft({ mode: "chat", command: "review" }));
    expect((await store.readDraft(CHAT)).command).toBeNull();
    store.saveDraft(draft({ mode: "slash", command: "c".repeat(130) }));
    expect((await store.readDraft(CHAT)).command).toBe("c".repeat(120));
    const ids = Array.from({ length: 120 }, (_, i) => `aaaaaaaaaaaaaa${"abcdefghijklmnopqrstuvwxyz234567"[i % 32]}${"abcdefghijklmnopqrstuvwxyz234567"[Math.floor(i / 32)]}`);
    store.saveDraft(draft({ uploads: ids }));
    expect((await store.readDraft(CHAT)).uploads).toEqual(ids.slice(0, 100));
  });

  test("a draft with a bad field is refused at once", async () => {
    const { store, file } = await opened();
    for (const over of [{ id: "x" }, { rev: -1 }, { mode: "shell" as never }, { uploads: ["../x"] }, { by: "t".repeat(65) }, { at: "now" }]) {
      let err: unknown = null;
      try {
        store.saveDraft(draft(over));
      } catch (e) {
        err = e;
      }
      expect((err as StoreError).code).toBe("bad_value");
    }
    await store.flush();
    expect(existsSync(file)).toBe(false);
  });

  test("20,000 characters that JSON escapes to six bytes each still fit the 128 KiB file", async () => {
    const { store, file } = await opened();
    store.saveDraft(draft({ text: "\u0001".repeat(20_000) }));
    await store.flush();
    expect(readFileSync(file).byteLength).toBeGreaterThan(120_000);
    expect(readFileSync(file).byteLength).toBeLessThanOrEqual(128 * 1024);
    expect((await createStore({ root: join(file, "..", "..", "..") }).open()).setAside).toEqual([]);
  });

  test("readDraft of an id that is not a chat id is refused", async () => {
    const { store } = await opened();
    expect(((await store.readDraft("../../x").catch((e) => e)) as StoreError).code).toBe("bad_value");
  });
});

describe("a bad draft file", () => {
  const plant = async (body: string | Uint8Array) => {
    const ctx = await opened();
    writeFileSync(ctx.file, body, { mode: 0o600 });
    return ctx;
  };

  test("torn JSON is set aside as .bad, reported once, and the chat starts with an empty draft", async () => {
    const { store, setAside, root } = await plant('{"v":1,"id":');
    expect(await store.readDraft(CHAT)).toMatchObject({ rev: 0, text: "" });
    expect(setAside).toEqual([`drafts/${CHAT}.json`]);
    expect(readdirSync(join(root, "state", "drafts"))).toEqual([`${CHAT}.json.bad`]);
    await store.readDraft(CHAT);
    expect(setAside.length).toBe(1);
  });

  test("a file over 128 KiB is set aside", async () => {
    const big = JSON.stringify({ ...draft(), text: "x".repeat(20_000), pad: "y".repeat(128 * 1024) });
    const { store, setAside } = await plant(big);
    expect(await store.readDraft(CHAT)).toMatchObject({ rev: 0, text: "" });
    expect(setAside).toEqual([`drafts/${CHAT}.json`]);
  });

  test("a draft whose id is not its file name, or whose text is over the cap, is set aside", async () => {
    const a = await plant(JSON.stringify(draft({ id: "abcdefghijabcdefghij" })));
    expect((await a.store.readDraft(CHAT)).rev).toBe(0);
    expect(a.setAside.length).toBe(1);
    const b = await plant(JSON.stringify(draft({ text: "x".repeat(20_001) })));
    expect((await b.store.readDraft(CHAT)).rev).toBe(0);
    expect(b.setAside.length).toBe(1);
  });

  test("a good file is read with its upload ids", async () => {
    const { store, setAside } = await plant(JSON.stringify(draft({ rev: 4, uploads: [UP] })));
    expect(await store.readDraft(CHAT)).toEqual(draft({ rev: 4, uploads: [UP] }));
    expect(setAside).toEqual([]);
  });

  test("a file from before v0.3 has no mentions key and reads as none; a file with mentions keeps them in order", async () => {
    const old = await plant(JSON.stringify(draft({ rev: 2 })));
    const read = await old.store.readDraft(CHAT);
    expect(read).toEqual(draft({ rev: 2 }));
    expect("mentions" in read).toBe(false);
    const withSome = await plant(JSON.stringify(draft({ rev: 3, mentions: ["src/b.ts", "a b/c.md", "src/b.ts"] })));
    expect((await withSome.store.readDraft(CHAT)).mentions).toEqual(["src/b.ts", "a b/c.md"]);
    expect(withSome.setAside).toEqual([]);
  });

  test("a file whose mentions are not safe relative paths is set aside", async () => {
    for (const bad of [["/etc/passwd"], ["../x"], ["a/../b"], "src/a.ts", [7]]) {
      const ctx = await plant(JSON.stringify({ ...draft(), mentions: bad }));
      expect((await ctx.store.readDraft(CHAT)).rev).toBe(0);
      expect(ctx.setAside.length).toBe(1);
    }
  });
});

describe("mentions in the draft (v0.3 search, C1)", () => {
  test("a save keeps the mentions through a restart; an empty list leaves the key out", async () => {
    const { root, store, file } = await opened();
    store.saveDraft(draft({ rev: 7, mentions: ["src/upload.ts", "notes/会議.md"] }));
    await store.flush();
    expect(onDisk(file).mentions).toEqual(["src/upload.ts", "notes/会議.md"]);
    const again = createStore({ root });
    await again.open();
    expect((await again.readDraft(CHAT)).mentions).toEqual(["src/upload.ts", "notes/会議.md"]);
    store.saveDraft(draft({ rev: 8, mentions: [] }));
    await store.flush();
    expect("mentions" in onDisk(file)).toBe(false);
  });

  test("at most 100 mentions are kept, and a bad one is refused at once", async () => {
    const { store } = await opened();
    const paths = Array.from({ length: 120 }, (_, i) => `src/f${i}.ts`);
    store.saveDraft(draft({ mentions: paths }));
    expect((await store.readDraft(CHAT)).mentions).toEqual(paths.slice(0, 100));
    let err: unknown = null;
    try {
      store.saveDraft(draft({ mentions: ["../outside"] }));
    } catch (e) {
      err = e;
    }
    expect((err as StoreError).code).toBe("bad_value");
  });
});
