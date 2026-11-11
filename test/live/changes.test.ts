// The opt-in live test of the changed-files card at a turn's end (round U1 of iteration 5; DESIGN-U1 4, 5 and 9). It
// runs 3 short real turns on KITESPAN_LIVE_MODEL (a Haiku row) through a real bin/kitespan and its socket, in
// acceptEdits mode (Claude's file tools edit with no card), in two scratch folders beside KITESPAN_LIVE_PROJECT.
// Without KITESPAN_LIVE=1 it is one skipped test. The cases, in order, each after the one before:
//
// A. A new git repository beside the scratch project (the project's parent folder must not be in a repository), made
//    with no system or global git config of the user's, with one commit of notes.txt (3 lines); the server, and the
//    repository as a project.
// B. A new chat there in acceptEdits mode on the model row, and its first turn: Claude appends a line to notes.txt and
//    writes hello.txt with its file tools, and no card opens.
// C. That turn's card, live (the `changes` event after its end), for a second page from history (right after the
//    turn's end, from the store) and from the summary read: exactly hello.txt (new, +1) and notes.txt (+1), from git's
//    marks, nothing left out. kitespan's log holds one `changes` line with its count.
// D. The diff read: notes.txt is one hunk whose one added line is "four"; hello.txt is a new file; a path that is not in
//    the turn answers `no_file`; every answer is no-store, and no line of kitespan's log names a changed file.
// E. The user's own edit is kept apart (DESIGN-U1 4.2 and 4.3). A second turn runs `sleep 8`, then appends a line to
//    notes.txt. The test writes during.txt 2 s into the command's run (a change while a tool runs is the turn's, as
//    Claude Code's own record counts it) and user.txt once the command has returned and no tool runs (the user's): the
//    card holds during.txt and notes.txt, and the summary counts user.txt in `others` (1).
// F. A plain folder beside the project, not a repository: a new chat whose turn creates a.txt with the Write tool. Its
//    card falls back to Claude's own edits (`edits`, why `not_git`) with a.txt, and its diff is the Write's own hunk.
//
// At the end: Delete for each chat (it removes the chat's changes folder and its transcript), the server, both scratch
// folders (by their own name start, in the project's parent only), a transcript that a failed step left, and Claude
// Code's folder for each scratch path when nothing else is in it. It logs counts, ids, states and booleans; never a
// file's content, a diff line or a reply.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { changeFileApiPath, changesApiPath, changesCardOf, type ChangedFile, type ChangesCard, type ChangesSummary, type FileDiff } from "../../shared/changes";
import type { ChatEvent, Picks } from "../../shared/protocol";
import { allowOnly, attach, cardAnswerer, claudeConfigDir, findTranscript, hello, LiveServer, liveSuite, need, ofKind, rid, scratchGit, sessionOf, TurnLog, waitEv, waitTurnEnd, type Frame, type Page } from "./live";

/** The name starts of the two scratch folders that this test makes beside KITESPAN_LIVE_PROJECT. */
const REPO_PREFIX = "kitespan-changes-live-repo-";
const PLAIN_PREFIX = "kitespan-changes-live-plain-";
/** The fixed identity of the scratch repository's one commit. */
const WHO = ["-c", "user.name=kitespan live test", "-c", "user.email=kitespan-live@example.invalid", "-c", "commit.gpgsign=false"];
const T_TURN = 180_000;
/** Claude Code's projects folder name for a folder: its path with every character that is not a letter or a digit as "-". */
const SLUG = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, "-");

const PROMPT_B = "Append the line four to notes.txt and create a file hello.txt that holds the word hi. Use your file tools, not a shell command. Then reply OK.";
const PROMPT_E = "Run the shell command sleep 8. Then append the line five to notes.txt with your file tools, not a shell command. Then reply OK.";
const PROMPT_F = "Create a file a.txt that holds the word hi. Use the Write tool, not a shell command. Then reply OK.";

type Ev<K extends ChatEvent["k"]> = Extract<ChatEvent, { k: K }>;

/** A plain text file's row as a summary has it. */
const row = (path: string, status: ChangedFile["status"], added: number, removed: number): ChangedFile => ({ path, status, added, removed });

/** The diff's added and removed lines, each without its sign. */
function signed(d: FileDiff): { added: string[]; removed: string[] } {
  const lines = (d.hunks ?? []).flatMap((h) => h.lines);
  return { added: lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1)), removed: lines.filter((l) => l.startsWith("-")).map((l) => l.slice(1)) };
}

/** The tool calls of `events` that have begun (a call event came) and have no end yet (a result, a denial or a stop). */
function openCalls(events: readonly ChatEvent[]): string[] {
  const begun = new Set<string>();
  const ended = new Set<string>();
  for (const e of events) {
    if (e.k === "tool_call") begun.add(e.id);
    else if (e.k === "tool_result" || e.k === "denied" || e.k === "tool_stopped") ended.add(e.id);
  }
  return [...begun].filter((id) => !ended.has(id));
}

/** kitespan's log lines, as text. */
function logText(server: LiveServer): string[] {
  const logs = join(server.stateDir, "logs");
  return readdirSync(logs).flatMap((n) => readFileSync(join(logs, n), "utf8").split("\n")).filter(Boolean);
}

/** kitespan's log lines of one event. */
const logLines = (server: LiveServer, ev: string): Frame[] => logText(server).filter((l) => l.includes(`"ev":"${ev}"`)).map((l) => JSON.parse(l) as Frame);

liveSuite("test/live/changes.test.ts", {}, (env) => {
  const log = new TurnLog("changes");
  const parent = dirname(env.project);
  const picks: Picks = { model: env.model, effort: null, mode: "acceptEdits" };
  let repo: string | null = null;
  let plain: string | null = null;
  let server: LiveServer | null = null;
  let page: Page | null = null;
  let project: string | null = null;
  /** Each chat that this test made, with its folder: Delete and the transcripts at the end. */
  const chats: { chat: string; cwd: string }[] = [];
  /** B's chat in the repository, and its first turn. */
  let chat: string | null = null;
  let turnB: { uuid: string; from: number } | null = null;
  let cardB: ChangesCard | null = null;
  let diffsRead = false;
  let keptApart = false;

  afterAll(async () => {
    const sessions: { session: string; cwd: string }[] = [];
    for (const c of chats) {
      if (page)
        for (const e of [...page.events(c.chat), ...page.drawn(c.chat)])
          if (e.k === "session" && !sessions.some((s) => s.session === e.sessionId)) sessions.push({ session: e.sessionId, cwd: c.cwd });
      const del = page && !page.closed && server?.running ? await page.request({ t: "delete", rid: rid(), chat: c.chat }, 60_000).catch(() => null) : null;
      log.line({ step: "G", chat: c.chat, deleted: del?.ok ?? null, changesFolder: server ? existsSync(join(server.stateDir, "changes", c.chat)) : null });
    }
    page?.close();
    if (server) await server.stop();
    // Delete removes a chat's transcript; one that a failed step left goes by its session's own file.
    for (const s of sessions) {
      const file = findTranscript(s.session, s.cwd);
      if (file && basename(file) === `${s.session}.jsonl`) rmSync(file, { force: true });
    }
    // Claude Code's folder for each scratch path, only when nothing else is in it.
    for (const dir of [repo, plain]) {
      if (!dir) continue;
      try {
        rmdirSync(join(claudeConfigDir(), "projects", SLUG(dir)));
      } catch {
        // not there, or not empty
      }
    }
    if (repo && dirname(repo) === parent && basename(repo).startsWith(REPO_PREFIX)) rmSync(repo, { recursive: true, force: true });
    if (plain && dirname(plain) === parent && basename(plain).startsWith(PLAIN_PREFIX)) rmSync(plain, { recursive: true, force: true });
    log.summary();
  }, 180_000);

  describe("the changed-files card, live", () => {
    test("A: a new git repository beside the scratch project, with one commit of notes.txt; the server; the repository as a project", async () => {
      const inside = scratchGit(parent, ["rev-parse", "--is-inside-work-tree"]);
      if (inside.code === 0 && inside.out.trim() === "true")
        throw new Error("KITESPAN_LIVE_PROJECT's parent folder is in a git repository: the test makes its scratch folders there, so give a project whose parent is a plain scratch folder");
      repo = realpathSync(mkdtempSync(join(parent, REPO_PREFIX)));
      const git = (what: string, args: string[]) => {
        const r = scratchGit(repo!, args);
        if (r.code !== 0) throw new Error(`git ${what} failed in the scratch repository (exit ${r.code})`);
        return r.out.trim();
      };
      git("init", ["-c", "init.defaultBranch=main", "init", "--quiet"]);
      writeFileSync(join(repo, "notes.txt"), "one\ntwo\nthree\n");
      git("add", ["add", "notes.txt"]);
      git("commit", [...WHO, "commit", "--quiet", "-m", "The scratch repository's one commit"]);
      const clean = git("status", ["status", "--porcelain"]) === "";
      server = await LiveServer.boot(env);
      page = (await hello(server, "changes-live")).page;
      project = await server.addProject(repo);
      log.line({ step: "A", project, clean });
      expect(clean).toBe(true);
    }, 60_000);

    test("B: a new chat in acceptEdits mode on the model row; its first turn edits notes.txt and writes hello.txt with the file tools, with no card", async () => {
      need(page && project && repo, "A");
      const P = page;
      const uuid = rid();
      const t0 = performance.now();
      const ack = await P.request({ t: "new_chat", rid: rid(), project, uuid, text: PROMPT_B, picks, uploads: [] });
      if (!ack.ok) throw new Error(`new_chat was refused: ${ack.error?.code}`);
      const c = ack.result.chat as string;
      chats.push({ chat: c, cwd: repo });
      const from = P.frames.length;
      await attach(P, c);
      // Every card is denied: in acceptEdits mode the file tools need none.
      const end = await waitTurnEnd(P, c, uuid, from, T_TURN, cardAnswerer(P, c, allowOnly([])));
      const drawn = P.drawn(c);
      const session = sessionOf(drawn);
      log.turn({ purpose: "B: an edit and a new file with the file tools", model: env.model, chat: c, session: session?.sessionId ?? null, ms: performance.now() - t0, ok: end.ok });
      const tools = [...new Map(ofKind(drawn, "tool_call").filter((x) => x.parent === null).map((x) => [x.id, x.name])).values()];
      const cards = ofKind(drawn, "card_open").filter((x) => x.card.kind === "permission");
      const notes = readFileSync(join(repo, "notes.txt"), "utf8");
      const hi = existsSync(join(repo, "hello.txt")) ? readFileSync(join(repo, "hello.txt"), "utf8") : null;
      log.line({ step: "B", mode: session?.mode ?? null, tools: tools.join(","), cards: cards.length, notesLines: notes.trimEnd().split("\n").length, hello: hi !== null });
      expect(end.ok, `the turn ended with ${end.subtype}`).toBe(true);
      expect(session?.model ?? null, "Claude Code did not run KITESPAN_LIVE_MODEL").toBe(env.model);
      expect(cards.length, "a permission card opened in acceptEdits mode").toBe(0);
      expect(tools.some((n) => n === "Edit" || n === "MultiEdit" || n === "Write"), "Claude made no file tool call").toBe(true);
      expect(notes.trimEnd().split("\n"), "notes.txt is not its 3 lines and four").toEqual(["one", "two", "three", "four"]);
      expect(hi?.trim(), "hello.txt does not hold the word hi").toBe("hi");
      chat = c;
      turnB = { uuid, from };
    }, T_TURN + 20_000);

    test("C: the turn's card, live, from history and from the summary read: exactly hello.txt (new, +1) and notes.txt (+1), from git's marks, nothing left out", async () => {
      need(server && page && chat && turnB, "B");
      const S = server;
      const t0 = performance.now();
      const ev = (await waitEv(page, chat, turnB.from, (e) => e.k === "changes", 30_000, undefined, "the turn's changes card")) as Ev<"changes">;
      const waitMs = Math.round(performance.now() - t0);
      const card = changesCardOf(ev);
      need(card, "the card's own check (changesCardOf)");
      const want = [row("hello.txt", "A", 1, 0), row("notes.txt", "M", 1, 0)];
      // A second page: history gives the same card right after the turn's end, from the store.
      const second = (await hello(S, "changes-live-2")).page;
      let history: ChatEvent[] = [];
      try {
        history = (await attach(second, chat)).snapshot.history as ChatEvent[];
      } finally {
        second.close();
      }
      const at = history.findIndex((e) => e.k === "changes" && e.id === card.id);
      const afterEnd = at > 0 && history[at - 1]!.k === "turn_end";
      const r = await S.get(changesApiPath(chat, card.id));
      const summary = r.ok ? ((await r.json()) as ChangesSummary) : null;
      const lines = logLines(S, "changes");
      log.line({
        step: "C",
        id: card.id,
        how: card.how,
        total: card.total,
        added: card.added,
        removed: card.removed,
        files: card.files.length,
        waitMs,
        atMessage: card.at.includes(turnB.uuid),
        history: at >= 0,
        afterEnd,
        status: r.status,
        others: summary?.others ?? null,
        why: summary?.why ?? null,
        logLines: lines.length,
      });
      expect(card).toMatchObject({ how: "git", total: 2, added: 2, removed: 0 });
      expect(card.files).toEqual(want);
      expect(afterEnd, "history has no card right after the turn's end").toBe(true);
      expect(history[at]).toEqual(ev);
      expect(r.status).toBe(200);
      expect(summary).toEqual({ ...card, files: want, others: 0 });
      expect(lines.map((l) => [l.ok, l.count])).toEqual([[true, 2]]);
      cardB = card;
    }, 60_000);

    test("D: the diff read: notes.txt is one hunk whose one added line is four; hello.txt is new; a path not in the turn is not there; no log line names a file", async () => {
      need(server && chat && cardB, "C");
      const S = server;
      const read = async (path: string) => {
        const r = await S.get(changeFileApiPath(chat!, cardB!.id, path));
        return { status: r.status, noStore: (r.headers.get("cache-control") ?? "").includes("no-store"), body: (await r.json()) as Frame };
      };
      const notes = await read("notes.txt");
      const n = notes.body as FileDiff;
      const ns = signed(n);
      const four = n.hunks?.length === 1 && ns.added.length === 1 && ns.added[0]!.trim() === "four" && ns.removed.length === 0;
      const greet = await read("hello.txt");
      const h = greet.body as FileDiff;
      const hs = signed(h);
      const isNew = h.status === "A" && hs.added.length === 1 && hs.removed.length === 0;
      const missing = await read("missing.txt");
      const named = logText(S).some((l) => l.includes("notes.txt") || l.includes("hello.txt"));
      const noStore = notes.noStore && greet.noStore && missing.noStore;
      log.line({
        step: "D",
        notes: notes.status,
        hunks: n.hunks?.length ?? null,
        oldLines: n.hunks?.[0]?.oldLines ?? null,
        newLines: n.hunks?.[0]?.newLines ?? null,
        four,
        hello: greet.status,
        isNew,
        missing: missing.status,
        missingState: missing.body.state ?? null,
        noStore,
        logNamesFile: named,
      });
      expect(notes.status).toBe(200);
      expect(n).toMatchObject({ path: "notes.txt", status: "M", added: 1, removed: 0 });
      expect(four, "notes.txt's diff is not one hunk whose one added line is four").toBe(true);
      expect(n.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
      expect(greet.status).toBe(200);
      expect(h).toMatchObject({ path: "hello.txt", status: "A", added: 1, removed: 0 });
      expect(isNew, "hello.txt's diff is not a new file of one line").toBe(true);
      expect(missing).toMatchObject({ status: 404, body: { state: "no_file" } });
      expect(noStore).toBe(true);
      expect(named, "a line of kitespan's log names a changed file (a path of the turn's, or the message's own text)").toBe(false);
      diffsRead = true;
    }, 60_000);

    test("E: during.txt, written 2 s into the turn's command, is the turn's; user.txt, written once no tool runs, is left out and counted in others", async () => {
      need(server && page && chat && repo && diffsRead, "D");
      const [S, P, c, dir] = [server, page, chat, repo];
      const uuid = rid();
      const from = P.frames.length;
      const answer = cardAnswerer(P, c, allowOnly(["Bash"]));
      const t0 = performance.now();
      const deadline = Date.now() + T_TURN;
      const ack = await P.request({ t: "send", rid: uuid, chat: c, uuid, text: PROMPT_E, draftRev: null, uploads: [] });
      if (!ack.ok) throw new Error(`send was refused: ${ack.error?.code}`);
      const evs = () => P.events(c, from);
      const ended = (id: string) => evs().some((e) => (e.k === "tool_result" || e.k === "denied" || e.k === "tool_stopped") && e.id === id);
      /** A permission card holds the call: it opened and has not closed (its window is shut, changes/activity.ts). */
      const held = (id: string) => {
        const list = evs();
        return list.some((e) => e.k === "card_open" && e.card.id === id) && !list.some((e) => e.k === "card_close" && e.id === id);
      };
      const turnEnded = () => evs().some((e) => e.k === "turn_end");

      // 1. 2 s into the command's run window: its call came with its whole input, and no card holds it.
      let bash: string | null = null;
      let runSince: number | null = null;
      for (;;) {
        answer(from);
        if (turnEnded()) throw new Error("the turn ended before its Bash call ran for 2 s");
        const call = ofKind(evs(), "tool_call").find((x) => x.name === "Bash" && x.parent === null && x.input !== null && x.input !== undefined);
        if (call && !held(call.id) && !ended(call.id)) {
          bash = call.id;
          runSince ??= Date.now();
          if (Date.now() - runSince >= 2_000) break;
        } else runSince = null;
        if (Date.now() > deadline) throw new Error("timed out waiting for the turn's Bash call to run");
        await Bun.sleep(20);
      }
      writeFileSync(join(dir, "during.txt"), "Written by the test while the command ran.\n");
      const duringInCall = !ended(bash);

      // 2. The command has returned and no call runs or waits (100 ms with none): the user's own edit.
      let calmSince: number | null = null;
      for (;;) {
        answer(from);
        if (turnEnded()) throw new Error("the turn ended before the test could write user.txt while no tool ran: Claude's reply after the command came at once");
        if (ended(bash) && openCalls(evs()).length === 0) {
          calmSince ??= Date.now();
          if (Date.now() - calmSince >= 100) break;
        } else calmSince = null;
        if (Date.now() > deadline) throw new Error("timed out waiting for the turn's Bash call to return");
        await Bun.sleep(20);
      }
      writeFileSync(join(dir, "user.txt"), "Written by the test, as the user would, while no tool ran.\n");
      const userAt = P.frames.length;
      const userBeforeEnd = !turnEnded();

      const end = await waitTurnEnd(P, c, uuid, from, Math.max(10_000, deadline - Date.now()), answer);
      log.turn({ purpose: "E: a command, an edit, and the user's own files", model: env.model, chat: c, session: sessionOf(P.drawn(c))?.sessionId ?? null, ms: performance.now() - t0, ok: end.ok });
      const ev = await waitEv(P, c, from, (e) => e.k === "changes", 30_000, undefined, "the turn's changes card");
      const card = changesCardOf(ev);
      const r = card ? await S.get(changesApiPath(c, card.id)) : null;
      const summary = r?.ok ? ((await r.json()) as ChangesSummary) : null;
      const paths = card?.files.map((f) => f.path) ?? [];
      const list = evs();
      const background = ofKind(list, "task").some((t) => t.toolUseId === bash && ((t.ev === "started" && t.background) || (t.ev === "updated" && t.background === true)));
      log.line({
        step: "E",
        how: card?.how ?? null,
        total: card?.total ?? null,
        others: summary?.others ?? null,
        elsewhere: summary?.elsewhere ?? null,
        duringInCall,
        duringKept: paths.includes("during.txt"),
        notesKept: paths.includes("notes.txt"),
        userLeftOut: !paths.includes("user.txt"),
        userBeforeEnd,
        callsAfterUser: new Set(ofKind(P.events(c, userAt), "tool_call").map((x) => x.id)).size,
        cards: ofKind(list, "card_open").length,
        background,
      });
      expect(end.ok, `the turn ended with ${end.subtype}`).toBe(true);
      expect(duringInCall, "the command had returned before the test wrote during.txt").toBe(true);
      expect(userBeforeEnd, "the turn had ended before the test wrote user.txt").toBe(true);
      expect(card).toMatchObject({ how: "git", total: 2, added: 2, removed: 0 });
      expect(card?.files).toEqual([row("during.txt", "A", 1, 0), row("notes.txt", "M", 1, 0)]);
      expect(r?.status).toBe(200);
      expect(summary?.others, "user.txt is not counted in others").toBe(1);
      expect(summary?.elsewhere).toBeUndefined();
      keptApart = true;
    }, T_TURN + 60_000);

    test("F: a plain folder that is not a repository: a turn that creates a.txt with the Write tool gets the fallback card, Claude's own edits", async () => {
      need(server && page && keptApart, "E");
      const [S, P] = [server, page];
      plain = realpathSync(mkdtempSync(join(parent, PLAIN_PREFIX)));
      const dir = plain;
      const notGit = scratchGit(dir, ["rev-parse", "--is-inside-work-tree"]).code !== 0;
      const projectF = await S.addProject(dir);
      const uuid = rid();
      const t0 = performance.now();
      const ack = await P.request({ t: "new_chat", rid: rid(), project: projectF, uuid, text: PROMPT_F, picks, uploads: [] });
      if (!ack.ok) throw new Error(`new_chat was refused: ${ack.error?.code}`);
      const c = ack.result.chat as string;
      chats.push({ chat: c, cwd: dir });
      const from = P.frames.length;
      await attach(P, c);
      const end = await waitTurnEnd(P, c, uuid, from, T_TURN, cardAnswerer(P, c, allowOnly([])));
      log.turn({ purpose: "F: a new file with the Write tool in a plain folder", model: env.model, chat: c, session: sessionOf(P.drawn(c))?.sessionId ?? null, ms: performance.now() - t0, ok: end.ok });
      const ev = await waitEv(P, c, from, (e) => e.k === "changes", 30_000, undefined, "the turn's changes card");
      const card = changesCardOf(ev);
      need(card, "the card's own check (changesCardOf)");
      const r = await S.get(changesApiPath(c, card.id));
      const summary = r.ok ? ((await r.json()) as ChangesSummary) : null;
      const d = await S.get(changeFileApiPath(c, card.id, "a.txt"));
      const diff = d.ok ? ((await d.json()) as FileDiff) : null;
      const ds = diff ? signed(diff) : null;
      const ownHunk = diff?.edits === true && diff.status === "A" && ds !== null && ds.added.length === 1 && ds.added[0]!.trim() === "hi" && ds.removed.length === 0;
      log.line({ step: "F", notGit, how: card.how, why: summary?.why ?? null, count: card.total, files: card.files.length, others: summary?.others ?? null, diff: d.status, ownHunk });
      expect(end.ok, `the turn ended with ${end.subtype}`).toBe(true);
      expect(notGit).toBe(true);
      expect(card).toMatchObject({ how: "edits", total: 1, added: 1, removed: 0 });
      expect(card.files).toEqual([row("a.txt", "A", 1, 0)]);
      expect(summary).toMatchObject({ why: "not_git", others: 0 });
      expect(ownHunk, "a.txt's diff is not the Write's own hunk of one line").toBe(true);
    }, T_TURN + 60_000);
  });
});
