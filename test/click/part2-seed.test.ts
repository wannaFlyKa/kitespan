// The click-through seed of part 2 (row 73, D60) on the real server, with no browser: the worktree scene boots
// bin/kitespan with the fake claude, its two repositories are there (seed/repos.ts), the server's Worktree reads say
// what New environment shows for them and for a plain folder, and a project added with Worktree on gives its new chat
// a worktree in the project's own `.claude/worktrees` (row 100), on its own branch, with the fake claude started in it
// and given the project's folder as one `--project-config-root=` argument, its record in the making in the seed's own
// data folder, and the main checkout's git status clean (the local ignore). scripts/ui-check.ts then clicks the same
// path in a browser. A stub page stands in for the built one; the port is KITESPAN_TEST_PORT or a free test port.

import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { LINUX_ONLY, PROCFS } from "../linux";
import { boot, pickTestPort, type Booted } from "./harness";
import { hasBranch, seedGit, worktreeList, WORKTREE_HOOK } from "./seed/repos";
import { PART2_SCENE } from "./seed/scenes";

const PORT = pickTestPort(7942);
const DIST = mkdtempSync(join(tmpdir(), "kitespan-click-stub-"));
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>stub page</body></html>");
let h: Booted | null = null;
afterAll(async () => {
  if (h) await h.stop().catch(() => {});
  rmSync(DIST, { recursive: true, force: true });
});

type Frame = Record<string, any>;

async function socket(port: number): Promise<{ frames: Frame[]; send: (f: Frame) => void; waitFor: (ok: (f: Frame) => boolean, ms?: number) => Promise<Frame>; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
  const frames: Frame[] = [];
  ws.onmessage = (m) => {
    if (typeof m.data === "string") frames.push(JSON.parse(m.data) as Frame);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket did not open"));
  });
  const waitFor = async (ok: (f: Frame) => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = frames.find(ok);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; frames: ${frames.map((f) => (f.t === "ev" ? `ev:${f.e?.k}` : f.t)).join(", ")}`);
      await Bun.sleep(20);
    }
  };
  return { frames, send: (f) => ws.send(JSON.stringify(f)), waitFor, close: () => ws.close() };
}

test.skipIf(!PROCFS)(
  `${PART2_SCENE.worktree.name}: ${PART2_SCENE.worktree.about}; a new chat in a project with Worktree on runs in its own worktree ${LINUX_ONLY}`,
  async () => {
    h = await boot({ scene: "worktree", port: PORT, dist: DIST });
    const { shop, hooks, linked } = h.seed.repos;
    const home = h.seed.home;
    // The repositories: two commits on main in shop, one in hooks with the hook in its project settings.
    expect(seedGit(shop, home, ["rev-list", "--count", "HEAD"]).out.trim()).toBe("2");
    expect(seedGit(shop, home, ["symbolic-ref", "--short", "HEAD"]).out.trim()).toBe("main");
    expect(seedGit(shop, home, ["status", "--porcelain"]).out).toBe("");
    expect(JSON.parse(readFileSync(join(hooks, ".claude", "settings.json"), "utf8"))).toEqual(WORKTREE_HOOK);
    // Row 100's link rule: linked's committed .claude is a symbolic link to its own config folder.
    expect(lstatSync(join(linked, ".claude")).isSymbolicLink()).toBe(true);
    expect(seedGit(linked, home, ["status", "--porcelain"]).out).toBe("");
    // No project has them yet, and nothing of kitespan's is in the data folder or the repository.
    const before = (await (await fetch(`${h.base}/api/projects`)).json()) as { projects: Frame[] };
    expect(before.projects.some((p) => p.folder === shop || p.cwd === shop)).toBe(false);
    expect(existsSync(join(h.seed.data, "kitespan"))).toBe(false);
    expect(existsSync(join(shop, ".claude"))).toBe(false);

    // New environment's read for each folder (W2, L29, L33).
    const can = async (path: string) => (await (await fetch(`${h!.base}/api/folders/worktree?path=${encodeURIComponent(path)}`)).json()) as Frame;
    expect(await can(shop)).toEqual({ ok: true });
    expect(await can(hooks)).toMatchObject({ ok: false, why: "hook" });
    expect(await can(linked)).toMatchObject({ ok: false, why: "link", line: "This repository's .claude or .claude/worktrees is a symbolic link or not a folder, so kitespan makes no worktree here." });
    expect(await can(h.seed.homeFolders.documents)).toMatchObject({ ok: false, why: "not_git" });

    // Use this folder with Worktree on: the new project keeps the option.
    const origin = h.base;
    const added = await fetch(`${h.base}/api/projects`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin }, body: JSON.stringify({ cwd: shop, worktree: true }) });
    expect(added.status).toBe(201);
    const project = ((await added.json()) as { project: Frame }).project;
    expect(project).toMatchObject({ worktree: true, worktreeOff: null });

    // Start: the chat's worktree is made before Claude Code starts, in the project's .claude/worktrees, on
    // kitespan/<8>.
    const s = await socket(PORT);
    try {
      s.send({ t: "hello", v: PROTOCOL_VERSION, tab: "part2-seed-test" });
      await s.waitFor((f) => f.t === "welcome");
      const rid = crypto.randomUUID();
      s.send({ t: "new_chat", rid, uuid: rid, project: project.id, text: "Add a coupon to the cart total", picks: { model: null, effort: null, mode: null }, uploads: [] });
      const ack = await s.waitFor((f) => f.t === "ack" && f.rid === rid, 30_000);
      expect(ack.ok).toBe(true);
      const chat = ack.result.chat as string;
      const ledger = JSON.parse(readFileSync(join(h.seed.state, "chats", `${chat}.json`), "utf8")) as Frame;
      const path = join(shop, ".claude", "worktrees", chat.slice(0, 8));
      const branch = `kitespan/${chat.slice(0, 8)}`;
      expect(ledger.cwd).toBe(path);
      expect(ledger.worktree).toMatchObject({ path, root: shop, branch });
      expect(lstatSync(path).isDirectory()).toBe(true);
      expect(worktreeList(shop, home)).toEqual([
        { path: shop, branch: "main" },
        { path, branch },
      ]);
      expect(hasBranch(shop, home, branch)).toBe(true);
      // The fake claude ran in the worktree, with the project's folder as one argument (the session id is the
      // ledger's once the start has made it; the SDK writes it as `--session-id=<id>`).
      const end = Date.now() + 15_000;
      let start: Frame | undefined;
      while (!start && Date.now() < end) {
        const sid = (JSON.parse(readFileSync(join(h.seed.state, "chats", `${chat}.json`), "utf8")) as Frame).sessionId;
        start = sid ? h.trace().find((l) => l.t === "start" && Array.isArray(l.args) && (l.args as string[]).some((a) => a === sid || a.endsWith(`=${sid}`))) : undefined;
        if (!start) await Bun.sleep(50);
      }
      expect(start?.cwd).toBe(path);
      expect(start?.args as string[]).toContain(`--project-config-root=${shop}`);
      // The user's checkout is as it was: the main checkout ignores the worktree locally (info/exclude, never a tracked
      // file), and kitespan's record of it in the making went into the seed's data folder and is gone again.
      expect(seedGit(shop, home, ["status", "--porcelain"]).out).toBe("");
      expect(seedGit(shop, home, ["status", "--porcelain", "--ignored"]).out).toBe("!! .claude/\n");
      expect(readFileSync(join(shop, ".git", "info", "exclude"), "utf8").split("\n")).toContain("**/.claude/worktrees/");
      expect(readdirSync(join(h.seed.data, "kitespan", "worktrees", project.id))).toEqual([]);
    } finally {
      s.close();
    }
  },
  60_000,
);
