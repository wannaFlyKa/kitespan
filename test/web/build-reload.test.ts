// After Restart to apply (DESIGN.md 4.10), the new server serves only its own build, from memory: an open page that
// keeps running the build it loaded asks for lazy chunks that are gone (the Terminal pane's xterm) and lacks the code
// the owner applied. So a `welcome` from another server life (a new epoch) makes the page read the server's page and
// compare the module scripts it names with its own: another build reloads the page once (the 30 s guard; drafts are
// the server's, D49), the same build reloads nothing, and a plain reconnect to the same server reads nothing.
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ServerFrame } from "../../shared/protocol";
import { moduleScripts, watchBuild } from "../../web/net/build";

const page = (src: string) =>
  `<!doctype html><html><head><link rel="stylesheet" crossorigin href="/assets/chunk-tzr2sv8z.css"><script type="module" crossorigin src="${src}"></script></head><body><div id="root"></div></body></html>`;
const welcome = (epoch: string): ServerFrame => ({ t: "welcome", epoch, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" });

function setup(served: () => Promise<string>) {
  let listener: ((f: ServerFrame) => void) | null = null;
  const conn = { on: (fn: (f: ServerFrame) => void) => ((listener = fn), () => {}) };
  let reads = 0;
  let reloads = 0;
  watchBuild(conn, {
    own: ["/assets/chunk-s5dctx9b.js"],
    readPage: () => {
      reads++;
      return served();
    },
    reload: () => void reloads++,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { send: (f: ServerFrame) => listener!(f), flush, reads: () => reads, reloads: () => reloads };
}

describe("the page's build after a restart", () => {
  test("the module scripts of a built page, in order; none in a page without them", () => {
    expect(moduleScripts(page("/assets/chunk-s5dctx9b.js"))).toEqual(["/assets/chunk-s5dctx9b.js"]);
    expect(moduleScripts(`<script src="/x.js"></script><script type="module" src='/a.js'></script><script src="/b.js" type="module"></script>`)).toEqual(["/a.js", "/b.js"]);
    expect(moduleScripts("<html></html>")).toEqual([]);
  });

  test("a welcome of a new epoch whose server names another build reloads the page once; the same build reloads nothing", async () => {
    let served = page("/assets/chunk-s5dctx9b.js");
    const t = setup(async () => served);
    t.send(welcome("e1"));
    t.send(welcome("e1"));
    await t.flush();
    // The first welcome of the page life, and a reconnect to the same server, read nothing.
    expect(t.reads()).toBe(0);
    t.send(welcome("e2"));
    await t.flush();
    expect(t.reads()).toBe(1);
    expect(t.reloads()).toBe(0);
    served = page("/assets/chunk-0ba8jk69.js");
    t.send(welcome("e3"));
    await t.flush();
    expect(t.reads()).toBe(2);
    expect(t.reloads()).toBe(1);
  });

  test("a read that fails, or a page that names no script, reloads nothing", async () => {
    const failing = setup(async () => {
      throw new TypeError("network");
    });
    failing.send(welcome("e1"));
    failing.send(welcome("e2"));
    await failing.flush();
    expect(failing.reloads()).toBe(0);
    const empty = setup(async () => "<html></html>");
    empty.send(welcome("e1"));
    empty.send(welcome("e2"));
    await empty.flush();
    expect(empty.reloads()).toBe(0);
  });
});
