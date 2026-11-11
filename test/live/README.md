# The opt-in live tests

These tests run real turns with your own Claude Code (the `claude` on your PATH), through a real `bin/kitespan`, in a
scratch project. Each turn is a real model call, so it costs what a turn costs you. They are opt-in: without
`KITESPAN_LIVE=1` (or, for one release, its old name: see The environment) each file is one skipped test, so a plain
`bun test` never runs them.

| File | What it checks | Turns (models) |
|---|---|---|
| `smoke.test.ts` | DESIGN 8.6: a plain turn; a thinking turn at the row's top effort; a `!` command and Claude's reply rule; a permission card answered Allow once, then the tool runs; two pages on one chat with one `claude` process; Archive ends an idle chat's process within about 8 s; Delete removes the chat and its transcript; an uploaded text file and image reach Claude | 6 to 9 on `KITESPAN_LIVE_MODEL` (the thinking turn tries up to 3 times; the `!` reply runs only when your reply rule says so); 2 more on `KITESPAN_LIVE_STRONG_MODEL` when it is set (a subagent turn and a workflow turn, each with its own agents) |
| `raw.test.ts` | DESIGN 8.7: one turn through kitespan and one `claude -p` turn on the same CLI; the system blocks equal the `claude -p` turn's, the tool names and betas equal an interactive session's, and the model, effort and thinking are the same | 2 on `KITESPAN_LIVE_MODEL`, plus the interactive reference turn that you record by hand once per CLI version |
| `terminal.test.ts` | Done check 9: the Terminal pane types the plain resume command on a sleeping chat and the fork command on a live one, never Enter; the resumed `claude` answers from the chat's history; the forked session gets a new id while the chat keeps its own | 5 on `KITESPAN_LIVE_MODEL` (3 through kitespan, 2 in the pane) |
| `resume.test.ts` | Done checks 2, 3 and 6 (the live checks LV-R1, LV-R2, LV-S1, LV-S2 and LV-S3): a kill -9 of the server while a chat idles, and while its turn runs (the finishing hold); Restart when they finish and Restart now during a turn; End it here and copy, with the command in the chat's Terminal pane; an update and Restart to apply in a scratch clone | 10 on `KITESPAN_LIVE_MODEL` |
| `update.test.ts` | Row 108, the self update, in a scratch clone of this checkout's `HEAD` whose origin is another scratch clone with one new commit that changes the page's script: Update available with the Update action; the Update button's request and the step line on two pages; Restart to apply while the running server still serves its own build; Restart now, and the successor serves the new `HEAD`'s build with other script names; a local change refused with its one line | 0 (no model turn; it still needs `KITESPAN_LIVE_PROJECT` and `KITESPAN_LIVE_MODEL`, as every live file does) |
| `send-now.test.ts` | Row 111, Send now (the lead's probe, LIVE-NOTES items 15 to 17), one chat per case: A, a message sent during a Bash call and no press goes into the same turn when the call ends, and its Queued mark goes before that turn's end; B, Send now during a Bash call (pressed from two pages at once, as soon as the call's card is answered) moves the call to the background with Claude Code's background line, one press acts and the other does nothing, Claude reads the message in the same turn long before the command ends, and the command's end then starts a turn of its own; C, Send now while Claude only writes stops the turn as Stop does, and the message runs next as its own turn. Each queued message is listed by one turn's end only | 5 on `KITESPAN_LIVE_MODEL` (A 1, B 2, C 2); a permission card for a Bash call is answered Allow once, every other tool is denied |
| `side-chat.test.ts` | Rows 124 and 125, the side chat (the lead's probe, it5-ui/live/LIVE-NOTES.md items 1 to 8): A, a side question while a Bash call of the main turn runs is answered, on both pages, and the main turn goes on untouched (its end names its own message only, its reply holds its marker word, and no message, line or turn of the side question shows); B, a follow-up that needs the earlier side answer reads it from the thread's history; C, none of the side questions or answers is in the session's transcript; D, Stop on a long side question: its ack says stopped, it leaves the thread, and the next side question answers; E, a side question on a sleeping chat (Archive, then Unarchive, after its first turn) starts its Claude Code with no turn and must name a code word from that turn (the design's main risk: the case logs whether it read the conversation); F, `/btw` sent as a message is refused and runs no turn | 2 turns on `KITESPAN_LIVE_MODEL` (A 1, E 1) and 6 side questions (A 1, B 2, D 2 of which Stop cuts one, E 1); a permission card for a Bash call is answered Allow once, every other tool is denied |
| `trust.test.ts` | Rows 126, 127 and 129, Trust this folder (the lead's probe, it5-ui/live/LIVE-NOTES.md items 10 to 12): A, in a new git repository nested in a new scratch folder beside `KITESPAN_LIVE_PROJECT`, `claude --bg` refuses with Claude Code's line, which names the folder's real path; B, that refusal in a kitespan chat (a short session of Claude Code's own form, filed under the scratch project, whose Bash call holds A's output; Continue here, no turn): the row carries the folder, Trust this folder's one `trust_folder` answers trusted with the states trusting and trusted on the page, kitespan's log holds one line with the path and the answer, and a second press answers already; C, Claude Code recorded the trust itself (`projects[<folder>].hasTrustDialogAccepted`, read by that key and its boolean only); D, `claude --bg` there now starts (no prompt), and the test stops and removes it; E, the home folder and the root are refused (`home`, `holds_home`). It logs the CLI's version and whether the trust start loads no settings file (`TRUST_SETTING_SOURCES_OFF`, the lead's one live check) | 0 (no model turn; it still needs `KITESPAN_LIVE_PROJECT` and `KITESPAN_LIVE_MODEL`, as every live file does) |
| `background.test.ts` | Row 131, the background sessions that a chat starts (FIX-R131 section 3): A, in a new plain folder inside `KITESPAN_LIVE_PROJECT` (so the project's trust covers it), `claude --bg -n <name> --model <row>` with a one-line prompt prints Claude Code's launch line, which kitespan's matcher reads; B, that line in a kitespan chat (a short session of Claude Code's own form, filed under the scratch project, whose Bash call holds A's output; Continue here, no turn): the row carries the launch; C, the line's state on the page goes to Completed (the states seen are logged); D, the view reads the worker's transcript under its own folder's slug (its prompt and reply, its stamp, `same` for the same stamp) and logs the permission mode that the transcript's tail gives; E, Stop through kitespan answers stopped, the page says Stopped, and kitespan's log holds one line with the short id and the answer; F, `claude agents --json --all` lists it as stopped, with the fields kitespan reads (only that row's field names are logged); G, the test stops and removes it | 1 on `KITESPAN_LIVE_MODEL`, in the background session (no turn in kitespan) |
| `changes.test.ts` | Round U1, the changed-files card at a turn's end (DESIGN-U1 4, 5 and 9), in acceptEdits mode: A, a new git repository beside `KITESPAN_LIVE_PROJECT` with one commit of `notes.txt` (3 lines), added as a project; B, a new chat there whose first turn appends a line to `notes.txt` and writes `hello.txt` with the file tools, with no card; C, that turn's card, live (the `changes` event), for a second page from history (right after the turn's end) and from the summary read: exactly `hello.txt` (new, +1) and `notes.txt` (+1), `how` git, `others` 0, and one `changes` log line with its count; D, the diff read: `notes.txt` is one hunk whose one added line is "four", `hello.txt` is new, a path not in the turn answers `no_file`, every answer is no-store, and no log line names a changed file; E, a turn that runs `sleep 8` and then edits `notes.txt`, while the test writes `during.txt` 2 s into the command (the turn's, as DESIGN-U1 4.3 counts a change while a command runs) and `user.txt` once the command has returned and no tool runs: the card holds `during.txt` and `notes.txt`, and the summary counts `user.txt` in `others` (1); F, a plain folder beside the project that is not a repository: a turn that creates `a.txt` with the Write tool gets the fallback card (`edits`, why `not_git`) and the Write's own hunk | 3 on `KITESPAN_LIVE_MODEL` (B, E and F); a permission card for E's Bash call is answered Allow once, every other card is denied |
| `browser.test.ts` | Iteration 7, the browser pane (DESIGN-B1 7.5, the lead's live run B3): Claude Code drives kitespan's one shared browser through your own `playwright` MCP server, in the tab that the pane shows. First it refuses to run while anything listens on port 9340, or when `claude mcp get playwright` does not show that entry at user scope, on the pinned `@playwright/mcp@0.0.84`, with `--cdp-endpoint http://127.0.0.1:9340`. Then Start through `POST /api/browser/start` (kitespan's own Chrome, a new profile in the temporary state folder), the test's own pages on 127.0.0.1, and one pane socket on `/ws/browser` that views every tab. Before and after each turn, the browser on 9340 must still be that Chrome (and while the turn runs, its listener, each second), or the case sends no prompt, or fails. Each case is a new chat whose short prompt names the Playwright tools: A, Claude opens a page in the tab that the pane showed after Start, clicks its button and says the word that the click showed (the page's script fetches it from the test's page server, so only a click can show it): the reply holds the word, the chat's events hold `mcp__playwright__` calls, Claude is acting lights and goes out, Claude's tab is the pane's tab (the tab that the pane showed after Start, or kitespan's hidden spare that joined the list once Claude used it, with the server's follow to the pane's socket; the log line's `how` says which: `shown` or `followed`), the page server saw the script's fetch (`Sec-Fetch-Mode: cors`, which a navigation never sends), and the pane's socket gets frames of that tab after the click, of the document that the click ran in; then the click's acting entry names that tab, and the tab list marks the tab as the chat's; B, a download that Claude's click starts: kitespan's downloads list holds it (name and size), and the file is in kitespan's downloads folder with mode 0600 and the page server's bytes; C, `browser_resize` to 900 x 700: the tab's size shows 900 x 700, set by Claude, and still does 12 s later; D, Claude's click on a file field: the pane's socket gets the file chooser frame, which says that the chooser is Claude's (`by: claude`), and the card that the page draws for it is Claude's (titled "Claude opened a file field", with Leave it to Claude as its plain button); then in B, C and D the tab list marks Claude's tab as that case's chat, never an older one (each case archives its chat before the next starts, so this checks that a chat's end takes its mark away; that the newest of two live chats wins is a unit test's). At the end: Delete for each chat (each must pass), Stop browser through `POST /api/browser/stop`, no Playwright server process of the test's still runs, and nothing listens on port 9340 | 4 on `KITESPAN_LIVE_MODEL` (A, B, C, D), in Manual mode; a permission card is answered Allow once only for `browser_navigate`, `browser_click`, `browser_resize`, `browser_snapshot`, `browser_wait_for`, a `browser_file_upload` with no paths, and `ToolSearch`; every other card is denied |
| `notify.test.ts` | Row 130, notifications (FIX-R130 1, the lead's live check): one real push to a subscription that you made by hand in a browser, through the browser's own push service: the newest device of `KITESPAN_LIVE_PUSH_STATE` (or `KITESPAN_LIVE_PUSH_DEVICE`) gets one push from the server's own sender (encrypted to the subscription, the VAPID token, your proxy variables, a 10 s deadline), and its push service takes it (2xx). You then see one notification, "Claude finished", whose click opens kitespan at Home | 0 (no model turn; it still needs `KITESPAN_LIVE_PROJECT` and `KITESPAN_LIVE_MODEL`, as every live file does) |
| `todo.test.ts` | Done check 10: a turn on an older model records a three-step to-do list (with the task tools or with TodoWrite), and the page's to-do row holds the three items, live and for a page that comes later | 1 on `KITESPAN_LIVE_TODO_MODEL` |
| `worktree.test.ts` | Done checks 7 and 8 (the live checks W14, LV-W1 to LV-W4, LV-W8, E9 and LV-E4): two chats in a project with Worktree on get two worktrees in the project's `.claude/worktrees` and two branches, and run in them with the project's config, with the main checkout's git status clean; a deny rule in the main checkout reaches a worktree session; in acceptEdits mode a Write in the worktree opens no card; a kill -9 and a resume in the worktree; the resume command in the Terminal pane without and with `--project-config-root` (one line for L28); Archive and Delete of worktree chats; a worktree that is gone and Make it again from its branch; an environment variable that a Bash call reads, whose value goes nowhere else, and a new value after a change | 10 on `KITESPAN_LIVE_MODEL` |

kitespan also asks Claude Code once for each new chat's title (Claude Code's own title request), as it does for you.

## The environment

| Variable | Meaning |
|---|---|
| `KITESPAN_LIVE=1` | Run the live tests. |
| `KITESPAN_LIVE_PROJECT` | Required. The absolute path of a scratch folder. Every turn runs there. A folder in a git repository with uncommitted changes is refused. The tests never commit there. |
| `KITESPAN_LIVE_MODEL` | Required. The model row for every turn: the CLI's own row value (the `value` of the row in `supportedModels()`), for the cheapest model that your CLI offers. A bare alias such as `haiku` is refused: when the alias is not in your enforced model list, the CLI runs the default model without a word. |
| `KITESPAN_LIVE_STRONG_MODEL` | Optional. The row for the subagent and workflow turns of `smoke.test.ts`. Without it, those two tests are skipped. |
| `KITESPAN_LIVE_TODO_MODEL` | Required by `todo.test.ts`. The row of a model that has the to-do tools by default (Opus 4.7, Sonnet 4.6, Haiku 4.5 or earlier). |
| `KITESPAN_LIVE_RAW_REFERENCE` | Required by `raw.test.ts`. The session id of one interactive `claude` turn that you recorded by hand (see below). |
| `KITESPAN_LIVE_PUSH_STATE` | Required by `notify.test.ts`. The absolute path of the state folder (`$XDG_STATE_HOME/kitespan`) of the kitespan where you turned Notifications on in a browser. |
| `KITESPAN_LIVE_PUSH_DEVICE` | Optional, for `notify.test.ts`: the id of the device to send to (Settings > Notifications' URL of a device row names it); default: the newest. |
| `KITESPAN_LIVE_PORT` | The port of the test server, from 7941 to 7949 (default 7946), or 7940 for the demo run. The test refuses a port that is in use: it never talks to a server that it did not start. |

For one release, each of these variables is also read under the name it had before the rename (the same name with
the old product name as its prefix) while the new name is unset, with one line on stderr that names it. So an old
variable that turns the live tests on, left set in a shell, still runs real turns: unset it.

Each file starts its own `bin/kitespan` on that port, with a temporary kitespan state, config and data folder, your own
HOME and your PATH. It stops the server by its pid when it ends, and removes the temporary folder. `terminal.test.ts`
starts the server with `ANTHROPIC_MODEL` set to `KITESPAN_LIVE_MODEL`, so that the `claude` that the pane's command
starts runs that row too.

## Commands

Run them from the repository folder, one file at a time:

```sh
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> bun test ./test/live/smoke.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> KITESPAN_LIVE_RAW_REFERENCE=<session id> bun test ./test/live/raw.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> bun test ./test/live/terminal.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> KITESPAN_LIVE_TODO_MODEL=<older row> bun test ./test/live/todo.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> bun test ./test/live/resume.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> bun test ./test/live/worktree.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> bun test ./test/live/update.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> bun test ./test/live/send-now.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> bun test ./test/live/trust.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> bun test ./test/live/background.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> bun test ./test/live/changes.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> bun test ./test/live/browser.test.ts
KITESPAN_LIVE=1 KITESPAN_LIVE_PROJECT=/path/to/scratch KITESPAN_LIVE_MODEL=<row> KITESPAN_LIVE_PUSH_STATE=/path/to/state/kitespan bun test ./test/live/notify.test.ts
```

Add `KITESPAN_LIVE_STRONG_MODEL=<row>` to the smoke command for the subagent and workflow turns. `bun run test:live`
runs all fourteen files in one go.

Each real turn prints one line: its time, model, purpose, chat, session and duration. A line never holds the text of a
message or a reply.

## Before the first run

- The scratch folder must be one that Claude Code already trusts: `terminal.test.ts` stops when the `claude` in the
  pane asks whether to trust the folder. Open `claude` in the folder once and answer it.
- `raw.test.ts` compares against one interactive turn that you record by hand, on the same CLI version and the same
  model, in the scratch folder, in your own default permission mode, and without `--allow-dangerously-skip-permissions`:
  run `claude --model <row>` in the folder, send `Reply with the single word OK.`, wait for the reply, and `/exit`.
  Its session id is the name of the newest `.jsonl` file in `~/.claude/projects/<the folder's real path, with each
  character that is not a letter or a digit as ->/`. Record a new one after each Claude Code update: the test
  refuses a reference from another version, model or permission mode, and says so.

## resume.test.ts

- It ends its own server with SIGKILL twice and starts a new one on the same folders, and it asks for three restarts
  through `POST /api/restart`. Each successor is the one that the server before started; the test takes it over by its
  pid (from the old server's last line, or the one process whose command line names the test's own temporary folder)
  and stops it at the end.
- Its Bash turns sleep 25 s and 20 s; a permission card for them is answered Allow once.
- End it here and copy: the test types the copied command, `cd <folder> && claude --resume <session id>`, in the chat's
  Terminal pane and quits that `claude` with `/exit`, so the scratch folder must be one that Claude Code trusts.
- The update step clones this checkout's `HEAD` (its commits only) twice into a temporary folder: the clone that
  updates, and its origin, with one empty commit made there. Nothing is pushed. The clones and the clone's
  `bun install --frozen-lockfile --omit=optional` are made when the file loads; when that install fails, as it does
  offline when Bun's install cache lacks a package, the step is skipped and its name says why.

## worktree.test.ts

- It makes its fixture, a new git repository with one commit, in a new folder in the scratch folder, and removes it
  at the end. Its git runs with no system or global git config of yours. The fixture's own `.claude/settings.json`
  denies one marker command (`echo kitespan-deny-marker`); `.claude/` is in the fixture's `.git/info/exclude`.
- kitespan makes its worktrees in the fixture's `.claude/worktrees`, so they go with the fixture at the end. The
  server's data folder (`XDG_DATA_HOME`), where kitespan keeps its records of worktrees in the making, is temporary too.
  Claude Code files each worktree chat's transcript under `~/.claude/projects/<the worktree's path, dashed>`. The test deletes both chats by Delete, also after a step that
  failed, so the transcripts go. Claude Code's empty folders for the two worktree paths under `~/.claude/projects`
  stay.
- It ends its own server with SIGKILL once and starts a new one on the same folders.
- LV-W2 sets one chat to acceptEdits mode for one turn, then back to your own mode.
- LV-W4 types `claude --resume` into a chat's Terminal pane twice and quits with `/exit`. If Claude Code asks whether
  to trust the worktree's folder (the fixture is a new repository, and a worktree's trust is its main checkout's), the
  test does not answer (Ctrl+C) and the L28 line says so. The test prints that line as it is, for L28.
- Its variable is `KITESPAN_LIVE_MARK`, with a new random value each run, set through the env API. The test never
  prints the value: it compares the chat's process environment and SHA-256 hashes, and a leak check names only the
  place. (A name that reads like a secret gets the Bash call denied by Claude Code's auto-mode check.)
- A permission card for a Bash call (or the Write call of one turn) is answered Allow once; every other card is
  denied (LV-W2's turn denies every card).

## update.test.ts

- It clones this checkout's `HEAD` (its commits only) twice into a temporary folder: the clone that updates, and its
  origin, with one new commit there that adds a line to the page's script. Nothing is pushed. The clones, the clone's
  `bun install --frozen-lockfile --omit=optional` and its build are made when the file loads; when that install fails,
  as it does offline when Bun's install cache lacks a package, the test is skipped and its name says why.
- Its git and Bun, and the clone's server for its own git, run with no system or global git config of yours. The
  update runs only in the clone, through the clone's own server.
- It asks for one restart (Restart now, `POST /api/restart`, with no turn running) and stops the successor by its pid
  at the end.

## trust.test.ts

- It runs the PATH `claude` three times with no terminal and no prompt (`claude --version`, then `claude --bg` before and
  after the trust), and `claude stop` and `claude rm` for the background session that the second `claude --bg` starts.
  No model turn runs: the trust start only initializes.
- `KITESPAN_LIVE_PROJECT`'s parent folder must not be in a git repository: the test makes its scratch folder there
  (`kitespan-trust-live-*`, with a new repository `inner` in it, made with no system or global git config of yours) and
  removes it at the end.
- It writes one short session of Claude Code's own form under `~/.claude/projects/<the scratch project's path,
  dashed>/` (it moves with `CLAUDE_CONFIG_DIR`), whose Bash calls hold the refusal, and continues it in kitespan; Delete
  removes the chat and that file at the end.
- It reads Claude Code's global config file only for `projects[<the scratch folder>].hasTrustDialogAccepted`, and logs
  that boolean alone. The trust record of the scratch folder stays there after the run: kitespan never writes that file,
  and a record of a folder that is gone does nothing.

## background.test.ts

- It runs the PATH `claude` with no terminal: `claude --version`, `claude --bg -n kitespan-bg-live --model <row>` with
  the prompt "Reply with the single word OK." (one model turn, in the background session), `claude agents --json --all`,
  and at the end `claude stop` and `claude rm` for that session. kitespan's own server runs `claude agents --json --all`
  and `claude stop <id>` the same way (the pinned binary, the clean start environment, the home folder).
- `KITESPAN_LIVE_PROJECT` must be a folder that Claude Code trusts, so that a plain folder inside it is trusted too: the
  test makes its scratch folder there (`kitespan-bg-live-*`, not a repository of its own) and removes it at the end.
- It writes one short session of Claude Code's own form under `~/.claude/projects/<the scratch project's path,
  dashed>/`, whose Bash call holds the launch output, and continues it in kitespan; Delete removes the chat and that
  file at the end. It removes the worker's own transcript by its exact path too; Claude Code's folder for the scratch
  folder's path under `~/.claude/projects` stays.
- It reads Claude Code's list only for the row of its own session, and logs that row's field names and state, and the
  count of rows; never another session's fields.

## changes.test.ts

- `KITESPAN_LIVE_PROJECT`'s parent folder must not be in a git repository: the test makes its two scratch folders there,
  a repository (`kitespan-changes-live-repo-*`, with one commit by a fixed test identity, made with no system or global
  git config of yours) and a plain folder (`kitespan-changes-live-plain-*`), and removes both at the end. Claude Code
  runs its turns there through the SDK, which shows no trust question.
- Each chat starts in acceptEdits mode on `KITESPAN_LIVE_MODEL`, so Claude's file tools edit with no card. E's Bash call
  (`sleep 8`) is allowed once when a card asks; every other card is denied.
- In E the test itself writes two files into the repository, as the user would: `during.txt` 2 s into the command's
  run, and `user.txt` once the command has returned and no tool call runs or waits. When Claude's reply comes before
  the test could write `user.txt`, the case fails and says so.
- It reads kitespan's own log for its `changes` lines and to check that no line names a changed file; it logs counts,
  ids, states and booleans, never a file's content or a diff line.
- Delete removes each chat, its changes folder (`changes/<chat id>` in kitespan's state folder) and its transcript; a
  transcript that a failed step left goes by its session's own file, and Claude Code's folder for each scratch path
  under `~/.claude/projects` goes when nothing else is in it.

## browser.test.ts

- It needs Claude Code's `playwright` MCP server at user scope, with the shared browser's debugging port. Add it once,
  in your own terminal, with the line that Settings > Browser shows:
  `claude mcp add -s user playwright -- npx @playwright/mcp@0.0.84 --cdp-endpoint http://127.0.0.1:9340 --no-webmcp --output-dir ~/.cache/playwright-mcp-output`.
  The test never adds, changes or removes an MCP server. A local-scope `playwright` entry for the scratch folder wins
  over the user-scope one, so the test checks the entry from that folder.
- Before it starts anything, it refuses to run while any program listens on port 9340, on any address: the browser
  there must be the one that the test starts, because the Playwright server connects to whatever holds the port. The
  test never adopts or drives a browser that it did not start.
- Then it runs the PATH `claude` once with no terminal: `claude mcp get playwright` in the scratch folder (no model
  turn). Claude Code checks the server's connection, so the Playwright server starts for a moment, while nothing listens
  on 9340. The test refuses to run unless the entry is at user scope and runs `@playwright/mcp@0.0.84` (the pinned
  version, `BROWSER_MCP_VERSION` in `shared/browser.ts`: kitespan reads that version's result text) with
  `--cdp-endpoint http://127.0.0.1:9340`; for another version it names both. It logs only those facts, never the
  command's output, which lists the entry's environment values. It notes the Playwright server processes that the
  check starts under that `claude` (by their command line and start), and ends one that still runs 10 s after the
  check, by its pid.
- While the test runs, do not use the playwright browser tools in any other Claude Code session. They connect to the
  test's Chrome on 9340 and can change the tabs that the cases check.
- The server's config folder is temporary too: the test writes its own `browser.json` there (port 9340,
  `loopbackOnly`), so no page or request of the browser leaves 127.0.0.1. kitespan picks the browser program as it
  does for you (your Chrome or Chromium on PATH, else Chrome for Testing in its cache) and starts it with a new profile
  in the temporary state folder, never your own profile. The test checks that kitespan started it (it did not adopt
  one), and that the one listener on 9340 is that Chrome, on that profile.
- Before each turn, and again after it, the test checks that the browser on 9340 is still that Chrome: kitespan says
  running and started, its record (`host.json`) still has the process's start ticks and a command line that names the
  test's profile and port, and every listener on 9340 is held by that process tree. When the check fails before a turn,
  the case sends no prompt; after a turn, the case fails. While a turn runs, the test checks the listener each second
  and before each Allow once: when a listener on 9340 is not that Chrome's, it denies every card and stops the chat.
- Its pages come from its own page server on 127.0.0.1, on a port that the system picks: a word page, a download page,
  a size page and a file field page. Each page shows a small counter that changes 4 times a second (hidden from
  Claude's snapshot), so the pane keeps getting frames. The page server records each request's `Sec-Fetch-Mode` and
  `Sec-Fetch-Dest`, so case A tells the word page's own fetch (`cors`, `empty`) from a navigation to the word's address.
- It opens one pane socket on `/ws/browser` with kitespan's Origin, as the page does, views every tab that shows, and
  acks each frame. It sends no input to a page, so no file chooser is the pane's here. The server decides whose a
  chooser is when it opens: case D's is Claude's (`by: claude`) because a browser call of D's chat runs on that tab
  (or on a tab not yet known) at that moment. The test checks that frame, and the card that the page draws for it: its
  owner, its title and its plain button (`web/browser/fileWords.ts`, the rules that `FileCard` uses).
- Claude's Playwright server takes as its current tab the first page that its browser lists (DESIGN-B1 D-6). Case A
  asserts that this is the tab that the pane showed after Start; when the server picks another tab, case A fails and
  says so.
- Each chat runs in Manual mode on `KITESPAN_LIVE_MODEL`. A permission card is answered Allow once only for the
  Playwright tools that the prompts need (`browser_navigate`, `browser_click`, `browser_resize`, `browser_snapshot`,
  `browser_wait_for`, and `browser_file_upload` with no paths) and `ToolSearch`, which loads them. Every other card is
  denied, so `browser_evaluate`, `browser_run_code_unsafe` and any tool that a later version adds never run.
- After each case the test archives the chat, so its Claude Code and its Playwright server end before the next case.
  While the turn runs, the test notes the Playwright server processes under the chat's `claude` (by their command line
  and start); each must end within 15 s of the archive, and the test ends one that does not by its pid, and fails at
  the end.
- At the end it deletes every chat (with its transcript) and fails when a Delete did not pass; a transcript that a
  failed Delete left goes by its session's own file. Then it stops the browser through `POST /api/browser/stop`, stops
  the server by its pid, removes the temporary folder (the profile and the downloads with it), and checks that no
  Playwright server process that it noted still runs and that nothing listens on 9340. If kitespan's browser still runs
  after all that, the test ends it by kitespan's own record of its start, after a check that its command line names the
  test's profile.
- The Playwright server writes its snapshot files into its own output folder (`--output-dir`); those stay.

## notify.test.ts

- First, by hand: start a kitespan with all three of its folders in a scratch folder (for example
  `XDG_STATE_HOME=/path/to/scratch/state XDG_CONFIG_HOME=/path/to/scratch/config XDG_DATA_HOME=/path/to/scratch/data bin/kitespan --port 7943`;
  a base left at its default is your own install's, and the first start of a renamed build moves that install's
  folders from the old name once), open `http://127.0.0.1:7943/settings/notifications` in Chrome (or the home-screen app on a phone, through your own
  forward), and turn Notifications on this device on with your own tap. That makes the server's key and stores the
  browser's subscription; the browser's maker runs the push service it names (Google's for Chrome, Apple's for Safari
  and the home-screen app on iOS, Mozilla's for Firefox).
- The file starts no server: it reads that state folder's `push-key.json` and `push-devices.json` (the server's own
  checks: this user's 0600 files) and sends one push with the server's own code. It is the one live file that calls a
  host other than 127.0.0.1: the push service of that subscription, through your proxy variables when they are set.
- It prints one line: the device's id, which push service, the host, the status and the time. Never the endpoint's
  path (a capability), a key, the payload or the device's name. A 403 from Apple's push service is the first sign that
  Apple does not take kitespan's VAPID `sub` (shared/push.ts `PUSH_CONTACT`), and the file says so.
- Then look at the device: one notification, "Claude finished"; its click opens kitespan at Home. Turn the device off
  in Settings afterwards if you like (Turn off, or the switch on that device).

## What a run never does

- It never touches a port or a process that it did not start.
- It sends real turns only in the scratch folder, in the worktrees of `worktree.test.ts`'s fixture, or in the two
  scratch folders that `changes.test.ts` makes beside it, and never commits there (each fixture's one commit is made by
  the test before any turn).
- It logs counts, ids and exit codes, never content.
- It never writes your Claude Code settings files (only the fixture's own `.claude/settings.json`).
