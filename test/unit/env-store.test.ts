// D60 (build checklist E1, L39, L42): `$XDG_STATE_HOME/kitespan/env/<project id>.json`, folder 0700 and file 0600,
// written by the one atomic writer; read with the store's checks and then the record check; a bad file set aside as
// `.bad`, which keeps that environment's chats from starting until the user enters the variables again or removes it.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvStore, envFileFrom } from "../../server/env/store";
import { StoreError } from "../../server/store/files";
import { createStore } from "../../server/store/store";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-env-store-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const mode = (p: string) => lstatSync(p).mode & 0o777;

const P = "k3m7q2x4ab";
const Q = "a2b3c4d5e6";
const T = "2026-11-03T12:00:00.000Z";
const SECRET = "planted-env-store-value-7Q";

/** The state folder opened by the store, and an env store on its env/ folder. */
async function opened(root = fresh()) {
  const store = createStore({ root });
  await store.open();
  const env = createEnvStore({ dir: store.dirs.env, now: () => new Date(T) });
  const res = await env.open();
  return { root, store, env, res };
}

describe("the folder and the file (E1)", () => {
  test("open() makes env/ 0700; a save writes <project id>.json 0600 with the record, in the user's order", async () => {
    const { store, env } = await opened();
    expect(store.dirs.env).toBe(join(store.dirs.state, "env"));
    expect(mode(store.dirs.env)).toBe(0o700);
    expect(await env.change(P, { set: [{ name: "B_VAR", value: SECRET }, { name: "A_VAR", value: "1" }], remove: [] })).toMatchObject({ ok: true });
    const file = join(store.dirs.env, `${P}.json`);
    expect(mode(file)).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      v: 1,
      id: P,
      vars: [
        { name: "B_VAR", value: SECRET, at: T },
        { name: "A_VAR", value: "1", at: T },
      ],
    });
    expect(env.vars(P)).toEqual([
      { name: "B_VAR", value: SECRET },
      { name: "A_VAR", value: "1" },
    ]);
    expect(env.vars(Q)).toEqual([]);
    expect(env.view(P)).toEqual({ vars: [{ name: "B_VAR", at: T }, { name: "A_VAR", at: T }], unreadable: false });
    // Never in projects.json, and no stray temporary file is left.
    expect(existsSync(join(store.dirs.state, "projects.json")) ? readFileSync(join(store.dirs.state, "projects.json"), "utf8") : "").not.toContain(SECRET);
    expect(readdirSync(store.dirs.env)).toEqual([`${P}.json`]);
  });

  test("a later open reads it back; Edit replaces a value in place; removing the last variable removes the file", async () => {
    const { root, env } = await opened();
    await env.change(P, { set: [{ name: "ONE", value: "1" }, { name: "TWO", value: "2" }], remove: [] });
    const again = await opened(root);
    expect(again.res.setAside).toEqual([]);
    expect(again.env.vars(P)).toEqual([
      { name: "ONE", value: "1" },
      { name: "TWO", value: "2" },
    ]);
    expect(await again.env.change(P, { set: [{ name: "ONE", value: "uno" }, { name: "THREE", value: "3" }], remove: ["TWO", "NOT_SAVED"] })).toMatchObject({ ok: true, changed: true });
    expect(again.env.vars(P)!.map((v) => `${v.name}=${v.value}`)).toEqual(["ONE=uno", "THREE=3"]);
    expect(await again.env.change(P, { set: [], remove: ["ONE", "THREE"] })).toMatchObject({ ok: true, changed: true });
    expect(existsSync(join(again.store.dirs.env, `${P}.json`))).toBe(false);
    expect(again.env.vars(P)).toEqual([]);
    expect(await again.env.change(P, { set: [], remove: ["GONE"] })).toMatchObject({ ok: true, changed: false });
  });

  test("a 0644 file or a link in env/ refuses the boot", async () => {
    const { root, store, env } = await opened();
    await env.change(P, { set: [{ name: "ONE", value: "1" }], remove: [] });
    chmodSync(join(store.dirs.env, `${P}.json`), 0o644);
    const err = (await createStore({ root }).open().catch((e) => e)) as StoreError;
    expect(err).toBeInstanceOf(StoreError);
    expect(err.problems).toEqual([{ path: `env/${P}.json`, why: "wider-mode" }]);
    chmodSync(join(store.dirs.env, `${P}.json`), 0o600);
    const target = join(root, "elsewhere.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, join(store.dirs.env, `${Q}.json`));
    const err2 = (await createStore({ root }).open().catch((e) => e)) as StoreError;
    expect(err2.problems).toEqual([{ path: `env/${Q}.json`, why: "symlink" }]);
  });

  test("a file in the place of env/ is named", async () => {
    const root = fresh();
    mkdirSync(join(root, "state"), { mode: 0o700 });
    writeFileSync(join(root, "state", "env"), "", { mode: 0o600 });
    const err = (await createStore({ root }).open().catch((e) => e)) as StoreError;
    expect(err.problems).toEqual([{ path: "env", why: "not-a-folder" }]);
  });

  test("a stray temporary file in env/ is swept at open (it may hold a value)", async () => {
    const root = fresh();
    mkdirSync(join(root, "state", "env"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, "state"), 0o700);
    writeFileSync(join(root, "state", "env", `.${P}.json.0123456789abcdef.tmp`), SECRET, { mode: 0o600 });
    const res = await createStore({ root }).open();
    expect(res.swept).toBe(1);
    expect(readdirSync(join(root, "state", "env"))).toEqual([]);
  });
});

describe("a file that cannot be read (L39: fail closed)", () => {
  const plant = (dir: string, id: string, body: unknown) => writeFileSync(join(dir, `${id}.json`), typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });

  test("a file that fails the record check is set aside as .bad and its environment reads as unreadable", async () => {
    const root = fresh();
    const { store } = await opened(root);
    plant(store.dirs.env, P, "{ not json");
    const again = await opened(root);
    expect(again.res.setAside).toEqual([`env/${P}.json`]);
    expect(existsSync(join(store.dirs.env, `${P}.json.bad`))).toBe(true);
    expect(mode(join(store.dirs.env, `${P}.json.bad`))).toBe(0o600);
    expect(again.env.vars(P)).toBeNull();
    expect(again.env.view(P)).toEqual({ vars: [], unreadable: true });
    // The .bad file is the mark, so it holds across restarts.
    const third = await opened(root);
    expect(third.res.setAside).toEqual([]);
    expect(third.env.vars(P)).toBeNull();
    // Other environments are not touched.
    expect(third.env.vars(Q)).toEqual([]);
  });

  test("removing the unreadable file, or entering the variables again, ends it", async () => {
    const root = fresh();
    const { store } = await opened(root);
    plant(store.dirs.env, P, "[]");
    plant(store.dirs.env, Q, "[]");
    const again = await opened(root);
    expect(again.env.vars(P)).toBeNull();
    // A remove of a name changes nothing while the file is unreadable.
    expect(await again.env.change(P, { set: [], remove: ["X"] })).toMatchObject({ ok: true });
    expect(again.env.vars(P)).toBeNull();
    expect(await again.env.change(P, { set: [], remove: [], discardUnreadable: true })).toMatchObject({ ok: true });
    expect(again.env.vars(P)).toEqual([]);
    expect(existsSync(join(store.dirs.env, `${P}.json.bad`))).toBe(false);
    expect(await again.env.change(Q, { set: [{ name: "AGAIN", value: "1" }], remove: [] })).toMatchObject({ ok: true });
    expect(again.env.vars(Q)).toEqual([{ name: "AGAIN", value: "1" }]);
    expect(existsSync(join(store.dirs.env, `${Q}.json.bad`))).toBe(false);
  });

  test("the record check: the id is the file name's, each field has its type and cap, no refused name, no repeat", () => {
    const good = { v: 1, id: P, vars: [{ name: "ONE", value: "1", at: T }] };
    expect(envFileFrom(good, P)).toEqual([{ name: "ONE", value: "1", at: T }]);
    const bad: unknown[] = [
      null,
      [],
      { ...good, v: 2 },
      { ...good, id: Q },
      { ...good, vars: {} },
      { ...good, vars: [{ name: "ONE", value: 1, at: T }] },
      { ...good, vars: [{ name: "ONE", value: "1" }] },
      { ...good, vars: [{ name: "ONE", value: "1", at: "yesterday" }] },
      { ...good, vars: [{ name: "path", value: "/bin", at: T }] },
      { ...good, vars: [{ name: "Home", value: "/h", at: T }] },
      { ...good, vars: [{ name: "1BAD", value: "1", at: T }] },
      { ...good, vars: [{ name: "ONE", value: "a\nb", at: T }] },
      { ...good, vars: [{ name: "ONE", value: "x".repeat(16_385), at: T }] },
      { ...good, vars: [{ name: "ONE", value: "1", at: T }, { name: "ONE", value: "2", at: T }] },
      { ...good, vars: Array.from({ length: 101 }, (_, i) => ({ name: `V${i}`, value: "1", at: T })) },
    ];
    for (const b of bad) expect(envFileFrom(b, P)).toBeNull();
  });

  test("before open() every environment reads as unreadable (fail closed)", () => {
    const env = createEnvStore({ dir: join(fresh(), "env") });
    expect(env.vars(P)).toBeNull();
  });
});

describe("a save is checked whole and writes nothing on any problem (E2, E5)", () => {
  test("each line's problem, with its index in `set`, and the environment's limits", async () => {
    const { store, env } = await opened();
    await env.change(P, { set: [{ name: "KEPT", value: "1" }], remove: [] });
    const r = await env.change(P, {
      set: [
        { name: "OK_ONE", value: SECRET },
        { name: "path", value: "/x" },
        { name: "OK_ONE", value: "again" },
        { name: "1BAD", value: "x" },
        { name: "GOOD", value: "a\rb" },
      ],
      remove: ["KEPT"],
    });
    expect(r).toEqual({
      ok: false,
      lines: [
        { i: 1, why: "path" },
        { i: 2, why: "twice" },
        { i: 3, why: "bad_name" },
        { i: 4, why: "bad_char" },
      ],
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    // Nothing changed, on disk or in memory.
    expect(env.vars(P)).toEqual([{ name: "KEPT", value: "1" }]);
    expect(JSON.parse(readFileSync(join(store.dirs.env, `${P}.json`), "utf8")).vars.map((v: { name: string }) => v.name)).toEqual(["KEPT"]);
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `V${i}`, value: "1" }));
    expect(await env.change(P, { set: many, remove: [] })).toEqual({ ok: false, lines: [{ i: -1, why: "too_many" }] });
    expect(await env.change(P, { set: many, remove: ["KEPT"] })).toMatchObject({ ok: true });
    const big = Array.from({ length: 5 }, (_, i) => ({ name: `B${i}`, value: "x".repeat(16_000) }));
    expect(await env.change(Q, { set: big, remove: [] })).toEqual({ ok: false, lines: [{ i: -1, why: "too_big" }] });
    expect(existsSync(join(store.dirs.env, `${Q}.json`))).toBe(false);
  });
});
