// U1's seed (FIX-U1 2; scripts/ui-check.ts changes-card; changes-seed.test.ts): the turns that change files, and the
// summaries that the route examples name.
//
// - The example chat's first turn ("Fix the flaky upload test") changed three files of the kitespan project, a git
//   repository whose fix is uncommitted (write.ts gitRepo): its summary is kept under the route examples' id
//   (shared/route.ts changesTurn and changesFile), from two real marks of that folder made the server's way (the
//   commit's tree, then the folder through a private index, the new objects in the chat's own changes folder), so
//   /c/<chat>/changes/<id> and /c/<chat>/changes/<id>/src/upload.ts open on the real server. The main and changes
//   scenes have it.
// - The changes scene adds two chats with no message yet: "Tidy the upload retries" in the kitespan project, whose
//   turns (CHANGES.texts) change files for real through the fake claude's files step, inside and outside the tools'
// windows,
//   and "Draft the release checklist" in the scratch project, a folder that is not a repository, whose turn falls back
//   to Claude's own edits. Its warm-up runs the two-file turn, so the card is there when a flow opens the chat.
//
// Every git here is the system git with no user or system config, run in the seed's own scratch folder only.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Step, Turn } from "../../fake-claude/install";
import { parseRawNumstat } from "../../../server/changes/patch";
import { CHANGES_ID, CHAT_ID } from "../../../shared/ids";
import { ROUTE_BY_NAME, parsePath } from "../../../shared/route";
import type { ChangedFile } from "../../../shared/changes";
import type { ChatSeed } from "./demo";

type Json = Record<string, unknown>;

/** The summary id that the route examples name (changesTurn and changesFile agree on it). */
function exampleTurn(): string {
  const turn = parsePath(ROUTE_BY_NAME.changesTurn!.example).params.turn;
  const file = parsePath(ROUTE_BY_NAME.changesFile!.example).params.turn;
  if (!turn || turn !== file) throw new Error("the changes examples name different summaries; the seed needs one");
  return turn;
}

export const CHANGES = {
  /** The example chat's first turn's summary. */
  example: exampleTurn(),
  /** The file the changesFile example opens. */
  exampleFile: parsePath(ROUTE_BY_NAME.changesFile!.example).params.path!,
  chats: { tidy: "tidytheuploadretrie2", release: "draftthereleasechec2" },
  titles: { tidy: "Tidy the upload retries", release: "Draft the release checklist" },
  /** The messages whose turns change files (the fixture picks each by its text). */
  texts: {
    /** An Edit of src/upload.ts and a formatter run (Bash) on its test; between them the user's own line in README.md. */
    two: "Tidy the retry loop and format its test.",
    /** One Bash run that edits, adds, renames and deletes files, and writes a binary file, a large one and a long one. */
    every: "Run the tidy script over the upload module.",
    /** Claude's own edits in a folder that is not a repository: an Edit and a Write that creates a file. */
    edits: "Add the UI check to the release checklist and start a to-do list.",
  },
} as const;

/** The turn's files, as each summary of the scene says them (the flows check the card's rows and words by them). */
export const CHANGES_FILES = {
  example: ["docs/UPLOAD-RETRIES.md", "src/upload.ts", "test/upload.test.ts"],
  two: ["src/upload.ts", "test/upload.test.ts"],
  every: ["assets/upload-icon.bin", "docs/UPLOAD-RETRIES.md", "logs/trace.log", "src/cli/send.ts", "src/generated/codes.ts", "src/retry.ts", "src/sync.ts"],
  edits: ["docs/RELEASE.md", "notes/todo.md"],
} as const;

/** The changes scene's two chats, beside demo.ts CHATS; no message yet (no session, no transcript). */
export const CHANGES_CHATS: ChatSeed[] = [
  { id: CHANGES.chats.tidy, project: "kitespan", sessionId: null, title: CHANGES.titles.tidy, from: "renamed", picks: {}, lastActivity: 5, created: 6 },
  { id: CHANGES.chats.release, project: "scratch", sessionId: null, title: CHANGES.titles.release, from: "renamed", picks: {}, lastActivity: 7, created: 8 },
];

/**
 * Keep the example chat's first turn's summary under `<state>/changes/<chat>/`, from two marks of `cwd` (the kitespan
 * project's repository): its commit's tree and the folder as it is. `at`: the page's row ids of the turn's first rows.
 * False when this host has no git (the seed then has no summary, and the examples show 5.4's line).
 */
export function writeExampleChanges(state: string, chat: string, cwd: string, home: string, at: string[], now: number): boolean {
  const git = ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g));
  if (!git || !existsSync(join(cwd, ".git"))) return false;
  const dir = join(state, "changes", chat);
  const objects = join(dir, "objects");
  for (const d of [join(state, "changes"), dir, objects]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
  const index = join(dir, "index");
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LANG: "C",
    GIT_INDEX_FILE: index,
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(cwd, ".git", "objects"),
  };
  const run = (...args: string[]) => {
    const r = spawnSync(git, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.splitIndex=false", ...args], { env, encoding: "utf8", timeout: 20_000 });
    if (r.status !== 0) throw new Error(`the changes seed could not run git ${args[0]}: ${(r.stderr ?? "").trim().slice(0, 200)}`);
    return r.stdout;
  };
  const from = run("rev-parse", "HEAD^{tree}").trim();
  copyFileSync(join(cwd, ".git", "index"), index);
  run("add", "--all");
  const to = run("write-tree").trim();
  unlinkSync(index);
  const files: ChangedFile[] = parseRawNumstat(run("diff-tree", "-r", "-M", "-z", "--raw", "--numstat", from, to)).map((r) => {
    const binary = r.added === null || r.removed === null;
    const status = r.status === "A" || r.status === "D" || r.status === "R" ? r.status : "M";
    return { path: r.path, status, added: binary ? 0 : r.added!, removed: binary ? 0 : r.removed!, ...(r.from && status === "R" ? { from: r.from } : {}), ...(binary ? { binary: true as const } : {}) };
  });
  const rec = {
    id: CHANGES.example,
    at,
    how: "git",
    from,
    to,
    total: files.length,
    added: files.reduce((s, f) => s + f.added, 0),
    removed: files.reduce((s, f) => s + f.removed, 0),
    others: 0,
    files,
    made: new Date(now - 60 * 60_000).toISOString(),
  };
  const path = join(dir, "turns.json");
  writeFileSync(path, JSON.stringify({ v: 1, chat, turns: [rec] }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The fake claude's turns (seed/fixture.ts takes them into turnsByText)

/** Each run of a turn gets ids of its own (the fake fills in the message's uuid). */
const EACH = "$USER_UUID";
const result = (text: string): Step => ({ emit: { type: "result", subtype: "success", result: text } });
const toolResult = (id: string, content: string, side?: Json): Step => ({
  emit: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] }, parent_tool_use_id: null, ...(side ? { tool_use_result: side } : {}) },
});
/** A pause on each side of a tool's change, so its file's time falls well inside the tool's window. */
const INSIDE: Step = { sleep: 80 };
/** A pause on each side of the user's own change between two tools, well outside both windows. */
const OUTSIDE: Step = { sleep: 400 };

const RETRY_OLD = "    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));\n";
const RETRY_NEW = "    await sleep(retryDelay(attempt));\n";

/** src/upload.ts after the tidy (the seed's current file with its wait named). */
export function tidiedUpload(current: string): string {
  const named = current.replace(RETRY_OLD, RETRY_NEW);
  return `${named}\nconst sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\nconst retryDelay = (attempt: number) => 200 * 2 ** attempt;\n`;
}

/** test/upload.test.ts after the formatter: its imports sorted, one blank line between the tests' parts. */
export function formattedTest(current: string): string {
  const lines = current.split("\n");
  const imports = lines.filter((l) => l.startsWith("import ")).sort();
  const rest = lines.filter((l) => !l.startsWith("import "));
  return [...imports, ...rest].join("\n").replace('  const res = await uploadFile("http://upload.test/file", body);\n', '\n  const res = await uploadFile("http://upload.test/file", body);\n\n');
}

/** The turns, by their message's text; `files` are the seed's current kitespan files (demo.ts PROJECT_FILES). */
export function changesTurns(files: Record<string, string>): Record<string, Turn> {
  const upload = files["src/upload.ts"]!;
  const test = files["test/upload.test.ts"]!;
  const sync = files["src/sync.ts"]!;
  const tidy = `toolu_tidy_${EACH}`;
  const format = `toolu_format_${EACH}`;
  const script = `toolu_script_${EACH}`;
  const release = `toolu_release_${EACH}`;
  const todo = `toolu_todo_${EACH}`;
  const TODO = "# To do\n\n- Run the UI check on the phone sizes.\n- Note the release in CHANGELOG.md.\n";
  const OLD_RELEASE = "3. bun run build\n";
  const NEW_RELEASE = "3. bun run build\n4. bun run ui-check\n";
  return {
    [CHANGES.texts.two]: {
      steps: [
        { say: { id: EACH, text: "I'll name the retry wait first.", tools: [{ id: tidy, name: "Edit", input: { file_path: "$CWD/src/upload.ts", old_string: RETRY_OLD, new_string: RETRY_NEW } }] } },
        INSIDE,
        { files: [{ write: "src/upload.ts", text: tidiedUpload(upload) }] },
        INSIDE,
        toolResult(tidy, "The file $CWD/src/upload.ts has been updated.", {
          filePath: "$CWD/src/upload.ts",
          oldString: RETRY_OLD,
          newString: RETRY_NEW,
          originalFile: upload,
          structuredPatch: [{ oldStart: 12, oldLines: 1, newStart: 12, newLines: 1, lines: [`-${RETRY_OLD.trimEnd()}`, `+${RETRY_NEW.trimEnd()}`] }],
          userModified: false,
          replaceAll: false,
        }),
        // The user's own line, between the two tools: the turn's summary counts it apart (not in the card).
        OUTSIDE,
        { files: [{ append: "README.md", text: "\nReviewed on the phone.\n" }] },
        OUTSIDE,
        { say: { id: `msg2_${EACH}`, text: "Now the formatter on the test.", tools: [{ id: format, name: "Bash", input: { command: "bunx prettier --write test/upload.test.ts", description: "Format the upload test" } }] } },
        INSIDE,
        { files: [{ write: "test/upload.test.ts", text: formattedTest(test) }] },
        INSIDE,
        toolResult(format, "test/upload.test.ts 31ms", { stdout: "test/upload.test.ts 31ms", stderr: "", interrupted: false }),
        { say: { id: `msg3_${EACH}`, text: "The retry wait has a name now, and the test is formatted." } },
        result("The retry wait has a name now, and the test is formatted."),
      ],
    },
    [CHANGES.texts.every]: {
      steps: [
        { say: { id: EACH, text: "I'll run the tidy script.", tools: [{ id: script, name: "Bash", input: { command: "bun scripts/tidy-upload.ts", description: "Tidy the upload module" } }] } },
        INSIDE,
        {
          files: [
            { write: "src/sync.ts", text: `${sync}\nexport const syncAll = (url: string, list: ReadableStream<Uint8Array>[]) => Promise.all(list.map((s) => sync(url, s)));\n` },
            { write: "src/retry.ts", text: "export const MAX_TRIES = 3;\n\nexport function retryDelay(attempt: number): number {\n  return 200 * 2 ** attempt;\n}\n" },
            { mv: ["src/cli/push.ts", "src/cli/send.ts"] },
            { rm: "docs/UPLOAD-RETRIES.md" },
            { write: "assets/upload-icon.bin", bytes: 2048, binary: true },
            { write: "logs/trace.log", bytes: 9 * 1024 * 1024 },
            { write: "src/generated/codes.ts", lines: 3500, prefix: "// status code" },
          ],
        },
        INSIDE,
        toolResult(script, "tidied 7 files", { stdout: "tidied 7 files", stderr: "", interrupted: false }),
        { say: { id: `msg2_${EACH}`, text: "The tidy script changed seven files." } },
        result("The tidy script changed seven files."),
      ],
    },
    [CHANGES.texts.edits]: {
      steps: [
        {
          say: {
            id: EACH,
            text: "I'll add the step and write the list.",
            tools: [
              { id: release, name: "Edit", input: { file_path: "$CWD/docs/RELEASE.md", old_string: OLD_RELEASE, new_string: NEW_RELEASE } },
              { id: todo, name: "Write", input: { file_path: "$CWD/notes/todo.md", content: TODO } },
            ],
          },
        },
        INSIDE,
        { files: [{ write: "docs/RELEASE.md", text: `# Release checklist\n\n1. bun install --frozen-lockfile\n2. bun test\n${NEW_RELEASE}` }, { write: "notes/todo.md", text: TODO }] },
        INSIDE,
        toolResult(release, "The file $CWD/docs/RELEASE.md has been updated.", {
          filePath: "$CWD/docs/RELEASE.md",
          oldString: OLD_RELEASE,
          newString: NEW_RELEASE,
          originalFile: null,
          structuredPatch: [{ oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [" 1. bun install --frozen-lockfile", " 2. bun test", " 3. bun run build", "+4. bun run ui-check"] }],
          userModified: false,
          replaceAll: false,
        }),
        toolResult(todo, "File created successfully at: $CWD/notes/todo.md", { type: "create", filePath: "$CWD/notes/todo.md", content: TODO, structuredPatch: [], originalFile: null }),
        { say: { id: `msg2_${EACH}`, text: "The checklist runs the UI check now, and the to-do list has two items." } },
        result("The checklist runs the UI check now, and the to-do list has two items."),
      ],
    },
  };
}

// Fix the shapes once, at load.
for (const id of Object.values(CHANGES.chats)) if (!CHAT_ID.test(id)) throw new Error(`not a chat id: ${id}`);
if (!CHANGES_ID.test(CHANGES.example)) throw new Error(`not a summary id: ${CHANGES.example}`);
