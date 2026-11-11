// R131 (owner row 131; DESIGN-R131 section 4): the matcher of Claude Code's launch line, shared/background.ts. The lines
// here are made the way the 2.1.318 binary makes them (function Xtt, read with grep, never run): "backgrounded", U+00B7
// with one space each side, the cyan 8-hex id, " · <name>" when the session has a name, the dim " (idle — send a prompt
// to start)" (U+2014) when it got no prompt, then four dim hint lines. Every line of a result's whole text counts,
// colour codes out, a carriage return allowed; near misses do not.
import { describe, expect, test } from "bun:test";
import { BG_ID_RE, BG_LAUNCH_RE, bgName, launchesIn, originFolder } from "../../shared/background";
import { BG_LIMITS, LIMITS } from "../../shared/protocol";

const ESC = String.fromCharCode(27);
const cyan = (s: string) => `${ESC}[36m${s}${ESC}[39m`;
const dim = (s: string) => `${ESC}[2m${s}${ESC}[22m`;
const plain = (s: string) => s;
/** Claude Code's idle suffix (`zlt`): "(idle — " + "send a prompt to start" + ")". */
const IDLE = `(idle — send a prompt to start)`;

/** The binary's template (2.1.318 `Xtt`), with colour on or off. */
function xtt(id: string, idle: string | undefined, name: string | undefined, colour = false): string {
  const c = colour ? cyan : plain;
  const d = colour ? dim : plain;
  const r = (s: string, a: string) => d(`  ${s.padEnd(26)}${a}`);
  return [
    `backgrounded · ${c(id)}${name ? ` · ${name}` : ""}${idle ? d(` ${idle}`) : ""}`,
    r("claude agents", "list sessions"),
    r(`claude attach ${id}`, "open in this terminal"),
    r(`claude logs ${id}`, "show recent output"),
    r(`claude stop ${id}`, "stop this session"),
  ].join("\n");
}

const ID = "3f9a1c2e";
const one = (name: string | null, idle = false) => [{ id: ID, name, idle }];

describe("the launch line, as the binary's template prints it", () => {
  test("the id alone", () => {
    expect(launchesIn(xtt(ID, undefined, undefined))).toEqual(one(null));
  });
  test("with a name", () => {
    expect(launchesIn(xtt(ID, undefined, "investigate-negative-qty"))).toEqual(one("investigate-negative-qty"));
  });
  test("with the idle suffix", () => {
    expect(launchesIn(xtt(ID, IDLE, undefined))).toEqual(one(null, true));
  });
  test("with a name and the idle suffix", () => {
    expect(launchesIn(xtt(ID, IDLE, "investigate"))).toEqual(one("investigate", true));
  });
  test("with colour on: the cyan id and the dim suffix and hints", () => {
    const text = xtt(ID, IDLE, "investigate", true);
    expect(text).toContain(`${ESC}[36m${ID}${ESC}[39m`);
    expect(launchesIn(text)).toEqual(one("investigate", true));
    expect(launchesIn(xtt(ID, undefined, undefined, true))).toEqual(one(null));
  });
  test("the docs' example, and the stderr start line before it", () => {
    expect(launchesIn(`Starting background service…\n${xtt("7c5dcf5d", undefined, "flaky-test-fix")}`)).toEqual([{ id: "7c5dcf5d", name: "flaky-test-fix", idle: false }]);
  });
  test("CRLF line ends", () => {
    expect(launchesIn(xtt(ID, IDLE, "investigate").replaceAll("\n", "\r\n"))).toEqual(one("investigate", true));
    expect(launchesIn(`backgrounded · ${ID}\r\n`)).toEqual(one(null));
  });
  test("two lines in one result, in their order; the same id twice is one entry", () => {
    const text = `${xtt("0a1b2c3d", undefined, "first")}\n${xtt("4e5f6a7b", IDLE, undefined)}\n${xtt("0a1b2c3d", undefined, "again")}`;
    expect(launchesIn(text)).toEqual([
      { id: "0a1b2c3d", name: "first", idle: false },
      { id: "4e5f6a7b", name: null, idle: true },
    ]);
  });
  test("a line after 7,000 characters of other output (past the 6,000-character cap)", () => {
    expect(LIMITS.toolResult).toBe(6_000);
    expect(launchesIn(`${"x".repeat(7_000)}\n${xtt(ID, undefined, "late")}`)).toEqual(one("late"));
  });
  test("a name that holds the middle dot; a name with control characters; a long name is cut", () => {
    expect(launchesIn(`backgrounded · ${ID} · cart · negative qty`)).toEqual(one("cart · negative qty"));
    expect(launchesIn(`backgrounded · ${ID} · inves${ESC}]0;x${String.fromCharCode(7)}tigate`)).toEqual(one("inves]0;xtigate"));
    expect(launchesIn(`backgrounded · ${ID} · ${"n".repeat(7_000)}`)).toEqual(one("n".repeat(LIMITS.name)));
    expect(launchesIn(`backgrounded · ${ID} · ${String.fromCharCode(7)}`)).toEqual(one(null));
  });
  test("at most 16 per result", () => {
    const ids = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(8, "a"));
    const got = launchesIn(ids.map((id) => `backgrounded · ${id}`).join("\n"));
    expect(BG_LIMITS.perResult).toBe(16);
    expect(got.map((l) => l.id)).toEqual(ids.slice(0, 16));
  });
});

describe("near misses are not launch lines", () => {
  const no = (text: unknown) => expect(launchesIn(text)).toEqual([]);
  test("ASCII dots, or a hyphen", () => {
    no(`backgrounded . ${ID}`);
    no(`backgrounded - ${ID} - name`);
  });
  test("7 or 9 hex digits, upper case, a letter past f", () => {
    no("backgrounded · 3f9a1c2");
    no("backgrounded · 3f9a1c2e0");
    no("backgrounded · 3F9A1C2E");
    no("backgrounded · 3f9a1c2g");
  });
  test("the line inside other text", () => {
    no(`ok: backgrounded · ${ID}`);
    no(`echo "backgrounded · ${ID} · name" > notes.txt`.replace("echo", "$ echo"));
    no(`  backgrounded · ${ID}`);
  });
  test("the interactive /background exit message, and the lines that start no session", () => {
    no(`backgrounded · ${ID} (worktree handed off)`);
    no(`Session ${ID} is already running — \`claude attach ${ID}\` to join it`);
    no("Starting background service…");
    no(`note: session ${ID} is already running in the background, so this started a copy as 4e5f6a7b. \`claude attach ${ID}\` opens the original.`);
  });
  test("an empty name part, and anything that is not a string", () => {
    no(`backgrounded · ${ID} · `);
    no(null);
    no(42);
    no("");
  });
});

describe("the helpers", () => {
  test("BG_ID_RE is Claude Code's own id rule; the pattern is whole-line and multiline", () => {
    expect(BG_ID_RE.test(ID)).toBe(true);
    expect(BG_ID_RE.test("3f9a1c2e ")).toBe(false);
    expect(BG_LAUNCH_RE.flags).toContain("m");
  });
  test("bgName: control characters out, cut at 120, empty is null", () => {
    expect(bgName("  shop\u0007 fix ")).toBe("shop fix");
    expect(bgName("a".repeat(200))).toBe("a".repeat(120));
    expect(bgName("\u0001")).toBeNull();
    expect(bgName(7)).toBeNull();
  });
  test("originFolder: the part before /.claude/worktrees/, as Claude Code's own origin rule", () => {
    expect(originFolder("/srv/you/shop/.claude/worktrees/fix-qty")).toBe("/srv/you/shop");
    expect(originFolder("/srv/you/shop/.claude/worktrees/fix-qty/sub")).toBe("/srv/you/shop");
    expect(originFolder("/srv/you/shop/worktrees/fix-qty")).toBeNull();
    expect(originFolder("/.claude/worktrees/x")).toBeNull();
  });
});
