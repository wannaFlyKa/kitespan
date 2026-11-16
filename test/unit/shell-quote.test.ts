// shellQuote's word runs in the user's `$SHELL` (a `!` command's chips, server/chats/registry.ts; the line that Open
// in terminal types, server/shell/command.ts), so sh, bash, zsh and fish must each read it back as the name. Each
// shell that is installed here runs the word. fish's own run needs fish; without it, fish's documented quoting rule
// stands in (fishReads): a backslash outside quotes escapes the next character, and inside single quotes only \' and
// \\ are escapes.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../../shared/protocol";
import { shellWord } from "../../server/shell/command";

const HOME = realpathSync(mkdtempSync(join(tmpdir(), "shell-quote-")));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const NAMES = [
  "",
  "plain.txt",
  "my notes.md",
  "it's",
  "''",
  "'",
  'say "hi"',
  "a\\b",
  "\\",
  "\\\\",
  "a\\",
  "\\'",
  "'\\",
  "a\\';id;echo \\'b",
  "a\\nb",
  "line one\nline two",
  "tab\there",
  "$HOME",
  "$(touch x);y.txt",
  "`touch x`",
  "-rf",
  "--help",
  "~",
  "*.ts?[a]{b,c}",
  "a;b&c|d<e>f#g!h%i",
  "naïve café 日本語 🙂",
];

/**
 * What `printf %s <word>` prints in the shell, with an empty home folder so no startup file adds a line. `command`
 * makes fish run the program, which prints a word with a leading dash as it is.
 */
async function shellReads(shell: string, word: string): Promise<string> {
  const proc = Bun.spawn([shell, "-c", `command printf '%s' ${word}`], { env: { PATH: process.env.PATH ?? "", HOME }, cwd: HOME, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 || err !== "") throw new Error(`${shell} failed on ${word}: ${err}`);
  return out;
}

/**
 * The one word that fish reads from `word` by its documented rule, for the forms that shellQuote writes; null when a
 * character stands outside the quotes with no backslash before it (there fish would read shell code), or when a quote
 * stays open.
 */
function fishReads(word: string): string | null {
  let out = "";
  let quoted = false;
  for (let i = 0; i < word.length; i++) {
    const c = word[i]!;
    const next = word[i + 1];
    if (quoted) {
      if (c === "'") quoted = false;
      else if (c === "\\" && (next === "'" || next === "\\")) out += word[++i];
      else out += c;
    } else if (c === "'") quoted = true;
    else if (c === "\\" && (next === "'" || next === "\\")) out += word[++i];
    else return null;
  }
  return quoted ? null : out;
}

describe("a quoted word reads back as the name", () => {
  for (const name of ["sh", "bash", "zsh", "fish"]) {
    const shell = name === "sh" ? "/bin/sh" : Bun.which(name);
    test.skipIf(!shell)(`${name} prints each name from its quoted word${shell ? "" : " (not installed here)"}`, async () => {
      for (const n of NAMES) {
        expect([n, await shellReads(shell!, shellQuote(n))]).toEqual([n, n]);
        expect([n, await shellReads(shell!, shellWord(n))]).toEqual([n, n]);
      }
    });
  }

  test("fish, by its documented rule: no backslash and no quote is inside the quotes, so the word is the name", () => {
    for (const n of NAMES) {
      expect([n, fishReads(shellQuote(n))]).toEqual([n, n]);
      expect(shellQuote(n)).toMatch(/^(?:'[^'\\]*'|\\[\\'])+$/);
    }
    // The form with the backslash inside the quotes: fish ends the word early, and `;id;` is shell code.
    expect(fishReads("'a\\'\\'';id;echo \\'\\''b'")).toBeNull();
  });
});
