// The prototype's safe markdown renderer (DESIGN.md 6.3): marked's tokens become escaped React elements, raw HTML stays
// text, only http, https and mailto links become links, images never load, and tables, task lists and code fences
// render. Rendered to static HTML with React's server renderer, so no browser is needed. Also the chat area's own
// parts: the transcript views, Claude Code's lines, the downloads a chat offers (D37), the waiting cards' links, titles
// and form switch, the open rows a conversation keeps per route, and chat.css, which uses only the looks' tokens
// (prototype design plan v3).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, decodeEntities, holdPartial, parseHighlight, safeHref } from "../../web/chat/Markdown";
import { ElicitationCardView } from "../../web/chat/cards/ElicitationCard";
import { QuestionCardView } from "../../web/chat/cards/QuestionCard";
import { archivedLinePath, routedCardOf } from "../../web/chat/cards/WaitingCard";
import { LINE_ANSWERED, LINE_LOST, LINE_NOT_WAITING, LINE_UNREAD, answerFirstLine, cardLinkLine, type CardLinkChat } from "../../web/chat/cards/labels";
import { findItem, foldItems, nextView, summarize, transcriptRows } from "../../web/chat/fold";
import { carryRows, chatRowsKey, entryTrail, openRowsKey } from "../../web/chat/openRows";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { DownloadButton, MessageFiles, baseName, fileTarget, hostPath, referencedUploads, relInFolder, splitRefs } from "../../web/chat/items/Files";
import { ItemView } from "../../web/chat/items/ItemView";
import { bubbleText } from "../../web/chat/items/Text";
import { delayLabel, elapsedLabel, tokensLabel } from "../../web/chat/items/format";
import { SIGN_IN_LINE } from "../../web/chat/items/Notes";
import { parse } from "../../web/router";
import { CHATS, UPLOADS, useScriptedCatalog, useScriptedState } from "./fixtures";
import type { Item, ToolItem, Upload } from "../../web/state/types";

useScriptedCatalog();
useScriptedState();

const html = (source: string, streaming = false) => renderToStaticMarkup(createElement(Markdown, { source, streaming }));

/** Every element name in the output, so a test can say which elements may appear at all. */
const tags = (out: string) => [...out.matchAll(/<([a-z][a-z0-9]*)\b/g)].map((m) => m[1]);

/** The visible text of the output (tags removed, the HTML escapes kept), for text that highlight spans split up. */
const text = (out: string) => out.replace(/<[^>]*>/g, "");

describe("raw HTML stays text", () => {
  const hostile = [
    "<script>alert(1)</script>",
    '<img src="x" onerror="alert(1)">',
    '<div onclick="alert(1)">hi</div>',
    '<iframe src="https://example.com"></iframe>',
    "<details open><summary>s</summary>x</details>",
    "<!-- a comment -->",
    '<a href="javascript:alert(1)">x</a>',
  ];
  for (const src of hostile)
    test(`block: ${src}`, () => {
      const out = html(src);
      expect(tags(out).every((t) => t === "div" || t === "p")).toBe(true);
      expect(out).toContain("&lt;");
      expect(out).not.toMatch(/<(script|img|iframe|details|summary|a)\b/);
    });
  test("inline HTML inside a paragraph shows as typed", () => {
    const out = html("Use <b>bold</b> and <span style=\"color:red\">red</span> here.");
    expect(out).toContain("Use &lt;b&gt;bold&lt;/b&gt; and &lt;span style=&quot;color:red&quot;&gt;red&lt;/span&gt; here.");
    expect(out).not.toMatch(/<(b|span)\b/);
  });
  test("code spans and fences keep markup as text", () => {
    const out = html("`<table>` and\n\n```html\n<script>alert(1)</script>\n```");
    expect(out).toContain("<code>&lt;table&gt;</code>");
    expect(out).not.toMatch(/<script\b/);
    expect(text(out)).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("links", () => {
  test("a javascript: link is not a link", () => {
    const out = html("[click me](javascript:alert(1)) and [data](data:text/html,hi) and [rel](./notes.md)");
    expect(out).not.toMatch(/<a\b/);
    expect(out).toContain("click me");
    expect(out).toContain("(javascript:alert(1))");
    expect(out).toContain("(./notes.md)");
  });
  test("http, https and mailto links open in a new tab with noopener noreferrer", () => {
    const out = html("[docs](https://example.com/docs) <mailto:team@example.com> and https://example.org/x");
    expect(out).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(out).toContain('href="mailto:team@example.com"');
    expect(out).toContain('href="https://example.org/x"');
    expect([...out.matchAll(/<a /g)].length).toBe(3);
  });
  test("safeHref allows only the three schemes", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("HTTP://example.com")).toBe("HTTP://example.com");
    expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    for (const bad of ["javascript:alert(1)", " javascript:x", "JaVaScRiPt:x", "data:text/html,x", "vbscript:x", "/local", "#top", "file:///etc/passwd", ""])
      expect(safeHref(bad)).toBeNull();
  });
  test("an image never loads: it shows as text", () => {
    const out = html("![a cat](https://example.com/cat.png) and ![](https://example.com/x.png)");
    expect(out).not.toMatch(/<img\b/);
    expect(out).toContain("[image: a cat]");
    expect(out).toContain("[image]");
  });
});

describe("blocks render", () => {
  test("a table keeps its alignment", () => {
    const out = html("| Run | Retries | Result |\n|:---|---:|:---:|\n| 1 | 0 | **pass** |\n| 2 | 3 | `ECONNRESET` |");
    expect(out).toContain('<div class="chat-md-table"');
    expect(out).toContain("<table>");
    expect(out).toContain('<th style="text-align:left">Run</th>');
    expect(out).toContain('<th style="text-align:right">Retries</th>');
    expect(out).toContain('<td style="text-align:center"><strong>pass</strong></td>');
    expect(out).toContain('<td style="text-align:center"><code>ECONNRESET</code></td>');
    expect([...out.matchAll(/<tr>/g)].length).toBe(3);
  });
  test("a task list has disabled checkboxes", () => {
    const out = html("- [x] a done task\n- [ ] an open task");
    expect(out).toContain('<ul class="chat-md-tasks"');
    expect([...out.matchAll(/<input type="checkbox"/g)].length).toBe(2);
    expect([...out.matchAll(/disabled=""/g)].length).toBe(2);
    expect([...out.matchAll(/checked=""/g)].length).toBe(1);
    expect(out).toContain("a done task");
  });
  test("a fenced code block has its language, a Copy icon button and highlight.js colours", () => {
    const out = html("```ts\nconst a: number = 1 < 2 ? 3 : 4; // note\n```");
    expect(out).toContain('<span class="chat-md-lang">ts</span>');
    expect(out).toContain('data-testid="copy-code"');
    expect(out).toContain('aria-label="Copy code"');
    expect(out).toContain("<span>Copy</span>"); // G-19: the icon and the word, as touch has no tooltip; its name stays Copy code
    expect(out).toContain("Copy");
    expect(out).toContain('<span class="hljs-keyword">const</span>');
    expect(text(out)).toContain("const a: number = 1 &lt; 2 ? 3 : 4; // note");
    expect(out).toContain('<span class="hljs-comment">// note</span>');
  });
  test("a fence in an unknown language shows plain escaped code", () => {
    const out = html("```nosuchlang\n<b>x</b>\n```");
    expect(out).not.toContain("hljs-");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
  test("headings, ordered lists with their start, nested lists, quotes, rules and strikethrough", () => {
    const out = html("# One\n\n### Three\n\n4. four\n5. five\n   - nested\n\n> quoted\n\n---\n\n~~gone~~ *em* **strong**");
    expect(out).toContain('<h2 class="chat-md-h chat-md-h1"');
    expect(out).toContain('<h4 class="chat-md-h chat-md-h3"');
    expect(out).toContain('<ol start="4"');
    expect(out).toMatch(/<li>five<ul><li>nested<\/li><\/ul><\/li>/);
    expect(out).toMatch(/<blockquote[^>]*><p>quoted<\/p><\/blockquote>/);
    expect(out).toContain("<hr");
    expect(out).toContain("<del>gone</del> <em>em</em> <strong>strong</strong>");
  });
  test("only the expected elements ever appear", () => {
    const out = html("# h\n\ntext **b** *i* ~~d~~ `c` [l](https://example.com)\n\n- [x] t\n\n1. o\n\n> q\n\n---\n\n| a |\n|---|\n| b |\n\n```js\nlet x = 1\n```\n\n<div>raw</div>");
    const allowed = new Set(["h2", "p", "strong", "em", "del", "code", "a", "ul", "ol", "li", "input", "blockquote", "hr", "div", "table", "thead", "tbody", "tr", "th", "td", "span", "pre", "button", "svg", "rect", "path"]);
    for (const t of tags(out)) expect(allowed.has(t!)).toBe(true);
  });
});

describe("text helpers", () => {
  test("entities decode once and render escaped", () => {
    expect(decodeEntities("AT&amp;T &lt;b&gt; &copy; &#35; &#x41; &bogus;")).toBe("AT&T <b> © # A &bogus;");
    const out = html("AT&amp;T &lt;script&gt;");
    expect(out).toContain("AT&amp;T &lt;script&gt;");
    expect(out).not.toContain("&amp;amp;");
  });
  test("a streaming reply holds a trailing table until its separator row arrives", () => {
    expect(holdPartial("Intro\n\n| A | B |")).toBe("Intro\n");
    expect(holdPartial("Intro\n\n| A | B |\n|---|")).toBe("Intro\n");
    // Row 79: a row (the separator too) shows once its line has ended, so a cell never grows in place.
    expect(holdPartial("Intro\n\n| A | B |\n|---|---|")).toBe("Intro\n");
    expect(holdPartial("Intro\n\n| A | B |\n|---|---|\n")).toBe("Intro\n\n| A | B |\n|---|---|\n");
    expect(holdPartial("Intro\n\n| A | B |\n|---|---|\n| 1 |")).toBe("Intro\n\n| A | B |\n|---|---|\n");
    expect(holdPartial("Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n")).toBe("Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n");
    expect(html("Intro\n\n| A | B |", true)).not.toContain("|");
  });
  test("highlight output is kept only when it is highlight.js's own spans", () => {
    expect(parseHighlight('<span class="hljs-keyword">let</span> x')).not.toBeNull();
    expect(parseHighlight('<span class="hljs-title function_">f</span>')).not.toBeNull();
    expect(parseHighlight('<span class="hljs-keyword" onclick="x">let</span>')).toBeNull();
    expect(parseHighlight('<img src=x onerror="alert(1)">')).toBeNull();
    expect(parseHighlight('<span class="evil">x</span>')).toBeNull();
    expect(parseHighlight('<span class="hljs-string">a</span></span>')).toBeNull();
    expect(parseHighlight("a & b")).toBeNull();
  });
});

// The transcript views fold tool calls the same way the chat draws them (DESIGN.md 6.3), so they are checked here too.
// The spike's streaming cases that the prototype's port had no test for (R-spike-port.md C2; the spike's md-unit.ts
// lines 51-54): what a reply looks like while it streams, and once it is done.
describe("a streaming reply (the spike's four cases)", () => {
  test("text after a finished table shows", () => {
    const out = html("text\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nafter the table", true);
    expect(out).toContain("<table>");
    expect(out).toContain("<td>1</td>");
    expect(text(out)).toContain("after the");
  });
  test("an open fence draws as code", () => {
    const out = html("x\n```py\nprint(1)\nprint(2", true);
    expect(out).toContain('class="chat-md-code"');
    expect(out).toMatch(/<code[^>]*>[\s\S]*print[\s\S]*<\/code>/);
    expect(text(out)).toContain("py");
  });
  // Row 79 (W19e) replaces the spike's "open emphasis stays as text": an open mark at the live end waits for its
  // closing mark, so "**" never shows and then turns into bold; a mark that cannot open (spaces around it) is text.
  test("open emphasis waits for its closing mark; a mark with spaces around it is text", () => {
    const out = html("Some **bold", true);
    expect(out).not.toContain("<strong>");
    expect(text(out)).not.toContain("**");
    expect(text(out)).toContain("Some");
    expect(html("Some **bold** words ", true)).toContain("<strong>bold</strong>");
    expect(text(html("2 * 3 = 6 and more", true))).toContain("2 * 3 = 6 and");
  });
  test("the finished text renders in full: a header row with no separator is text, not held", () => {
    const half = "Intro\n\n| A | B |";
    expect(text(html(half, true))).not.toContain("|");
    expect(text(html(half, false))).toContain("| A | B |");
    expect(html(half, false)).not.toContain("<table>");
  });
});

describe("transcript views (fold.ts)", () => {
  const tool = (id: string, name: string, summary: string, status: "ok" | "error" | "running" | "denied" = "ok"): Item => ({ kind: "tool", id, name, summary, status });
  const items: Item[] = [
    { kind: "user", id: "u1", text: "Fix it" },
    { kind: "thinking", id: "t1", seconds: 3, text: "Read first." },
    tool("r1", "Read", "src/a.ts"),
    tool("r2", "Read", "src/b.ts"),
    tool("r3", "Read", "src/a.ts"),
    tool("g1", "Grep", "x in src"),
    tool("b1", "Bash", "bun test", "error"),
    { kind: "assistant", id: "a1", markdown: "Found it." },
    tool("e1", "Edit", "src/a.ts"),
    { kind: "todo", id: "td1", items: [{ text: "x", status: "completed" }] },
    { kind: "agent", id: "ag1", agentType: "Explore", description: "d", status: "done", toolUses: 1, seconds: 2, rows: [tool("n1", "Read", "src/c.ts")] },
  ];
  test("Normal folds each run of tool calls between other rows and leaves thinking out", () => {
    const e = foldItems(items, "normal");
    expect(e.map((x) => (x.type === "summary" ? `sum:${x.items.map((i) => i.id).join(",")}` : x.item.id))).toEqual(["u1", "sum:r1,r2,r3,g1,b1", "a1", "sum:e1,td1", "ag1"]);
  });
  test("Thinking shows thinking, Verbose shows every row, and a link reveals one thinking block in Normal", () => {
    expect(foldItems(items, "thinking").some((x) => x.type === "item" && x.item.id === "t1")).toBe(true);
    expect(foldItems(items, "verbose").every((x) => x.type === "item")).toBe(true);
    expect(foldItems(items, "normal", new Set(["t1"])).some((x) => x.type === "item" && x.item.id === "t1")).toBe(true);
  });
  test("summaries are worded by kitespan, with the tags of the calls inside", () => {
    expect(summarize(items.slice(2, 7))).toEqual({ label: "Read 2 files, searched for 1 pattern, ran 1 command", running: false, tags: ["Error"] });
    expect(summarize([tool("e1", "Edit", "a"), { kind: "todo", id: "t", items: [] }]).label).toBe("Edited 1 file, updated the to-do list");
    expect(summarize([tool("r", "Read", "a"), tool("b", "Bash", "x", "running")])).toEqual({ label: "Read 1 file, running a command", running: true, tags: [] });
    expect(summarize([tool("b", "Bash", "x (in the background)", "running")]).label).toBe("Running a command in the background");
    expect(summarize([tool("m", "docs-search", "q"), tool("m2", "docs-search", "q2", "denied")])).toEqual({ label: "Used docs-search 2 times", running: false, tags: ["Denied"] });
  });
  test("a row is found inside subagent blocks, with its parents", () => {
    expect(findItem(items, "n1")).toEqual({ item: tool("n1", "Read", "src/c.ts"), parents: ["ag1"] });
    expect(findItem(items, "nope")).toBeNull();
  });
  test("Ctrl+O cycles Normal, Thinking (only after thinking) and Verbose", () => {
    expect(nextView("normal", true)).toBe("thinking");
    expect(nextView("thinking", true)).toBe("verbose");
    expect(nextView("verbose", true)).toBe("normal");
    expect(nextView("normal", false)).toBe("verbose");
  });
});

// Claude Code's own lines (DESIGN.md 6.3): what replaces what, which view shows what, and how each row reads.
describe("Claude Code's lines (fold.ts)", () => {
  const ids = (list: readonly Item[]) => list.map((i) => i.id);
  const user = (id: string): Item => ({ kind: "user", id, text: "go" });
  const reply = (id: string): Item => ({ kind: "assistant", id, markdown: "ok" });
  const retry = (id: string, attempt: number): Item => ({ kind: "retry", id, attempt, max: 10, delayMs: 2000, error: "overloaded" });

  test("a refusal's retracted rows leave the transcript", () => {
    const items: Item[] = [user("u1"), reply("a1"), { kind: "refusal", id: "rf", text: "Declined.", fallback: { model: "sonnet-5.5", scope: "session" }, retracted: ["a1"] }, reply("a2")];
    expect(ids(transcriptRows(items))).toEqual(["u1", "rf", "a2"]);
  });
  test("a newer info line for the same tool use replaces the older one", () => {
    const items: Item[] = [
      { kind: "info", id: "i1", level: "notice", text: "first", toolUseId: "t1" },
      { kind: "info", id: "i2", level: "notice", text: "other call", toolUseId: "t2" },
      { kind: "info", id: "i3", level: "warning", text: "second", toolUseId: "t1" },
      { kind: "info", id: "i4", level: "notice", text: "no call" },
    ];
    expect(ids(transcriptRows(items))).toEqual(["i2", "i3", "i4"]);
  });
  test("only the newest status shows, and only when it says something", () => {
    const failed: Item = { kind: "status", id: "s1", status: null, compact: "failed", error: "timed out" };
    expect(ids(transcriptRows([failed, reply("a")]))).toEqual(["s1", "a"]);
    expect(ids(transcriptRows([failed, { kind: "status", id: "s2", status: "requesting" }]))).toEqual([]);
    expect(ids(transcriptRows([{ kind: "status", id: "s3", status: "compacting" }]))).toEqual(["s3"]);
    expect(ids(transcriptRows([{ kind: "status", id: "s4", status: null, compact: "success" }]))).toEqual([]);
  });
  test("a newer retry replaces the older one, and the reply's text ends it; a turn without a reply keeps its last", () => {
    expect(ids(transcriptRows([user("u"), retry("r1", 1), retry("r2", 2)]))).toEqual(["u", "r2"]);
    expect(ids(transcriptRows([user("u"), retry("r1", 1), reply("a")]))).toEqual(["u", "a"]);
    expect(ids(transcriptRows([user("u"), retry("r1", 1), { kind: "error", id: "e", text: "failed" }, user("u2"), reply("a")]))).toEqual(["u", "r1", "e", "u2", "a"]);
  });
  test("hook rows and info-level lines show only in Verbose, never split a run of calls, and a link reveals one", () => {
    const tool = (id: string): Item => ({ kind: "tool", id, name: "Read", summary: id, status: "ok" });
    const items: Item[] = [tool("r1"), { kind: "hook", id: "h", event: "PreToolUse", name: "check" }, { kind: "info", id: "i", level: "info", text: "detail" }, tool("r2"), { kind: "info", id: "n", level: "notice", text: "note" }];
    const shape = (view: "normal" | "thinking" | "verbose", reveal?: Set<string>) => foldItems(items, view, reveal).map((e) => (e.type === "summary" ? `sum:${e.items.map((i) => i.id).join(",")}` : e.item.id));
    expect(shape("normal")).toEqual(["sum:r1,r2", "n"]);
    expect(shape("thinking")).toEqual(["sum:r1,r2", "n"]);
    expect(shape("verbose")).toEqual(["r1", "h", "i", "r2", "n"]);
    expect(shape("normal", new Set(["h"]))).toEqual(["sum:r1", "h", "sum:r2", "n"]);
  });
  test("summaries tag a call that auto mode denied, read the background flag and carry the running call's time", () => {
    const denied: Item = { kind: "tool", id: "p", name: "Bash", summary: "git push", status: "auto-denied" };
    expect(summarize([denied]).tags).toEqual(["Denied by auto mode"]);
    expect(summarize([{ kind: "tool", id: "e", name: "Bash", summary: "x", status: "error" }, denied]).tags).toEqual(["Error", "Denied by auto mode"]);
    expect(summarize([{ kind: "tool", id: "b", name: "Bash", summary: "bun run docs", status: "running", background: true, elapsedSeconds: 95 }])).toEqual({ label: "Running a command in the background", running: true, elapsed: 95, tags: [] });
  });
  test("the number formats", () => {
    expect([elapsedLabel(0), elapsedLabel(12), elapsedLabel(60), elapsedLabel(95)]).toEqual(["0 s", "12 s", "1 min", "1 min 35 s"]);
    expect([tokensLabel(950), tokensLabel(1000), tokensLabel(1900), tokensLabel(18400), tokensLabel(210400)]).toEqual(["950", "1k", "1.9k", "18.4k", "210k"]);
    expect([delayLabel(0), delayLabel(400), delayLabel(4000)]).toEqual(["0 s", "1 s", "4 s"]);
  });
});

describe("Claude Code's lines (rendered)", () => {
  /** A row as the read-only preview draws it (no chat around it: the Verbose view, nested rows open). */
  const row = (item: Item) =>
    renderToStaticMarkup(createElement(ItemView, { item, chatId: "", readOnly: true }))
      .replace(/<[^>]*>/g, "")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");

  test("every row of the scripted chats draws something", () => {
    const rows = CHATS.flatMap((c) => transcriptRows(c.items)).filter((i) => i.kind !== "user");
    const empty = rows.filter((i) => row(i).trim() === "").map((i) => `${i.kind}:${i.id}`);
    expect(empty).toEqual([]);
  });
  test("the error row: the reason, then what to do; a sign-in error says how to sign in again", () => {
    expect(row({ kind: "error", id: "e1", text: "API error: overloaded." })).toBe("API error: overloaded.Send a message to continue.");
    const signIn = row({ kind: "error", id: "e2", text: "API error: the credentials expired.", signIn: true });
    expect(signIn).toContain(SIGN_IN_LINE);
    expect(signIn).not.toContain("Send a message to continue.");
  });
  test("the status, retry, refusal and info lines", () => {
    expect(row({ kind: "status", id: "s", status: "compacting" })).toBe("Compacting the conversation...");
    expect(row({ kind: "status", id: "s", status: null, compact: "failed", error: "Timed out." })).toBe("Compaction failed. Timed out.");
    expect(row({ kind: "status", id: "s", status: "requesting" })).toBe("");
    expect(row({ kind: "retry", id: "r", attempt: 3, max: 10, delayMs: 2500, error: "rate_limit" })).toBe("Retrying (3 of 10) in 3 s, rate limit");
    expect(row({ kind: "refusal", id: "f", text: "The model declined this request." })).toBe("The model declined this request.");
    expect(row({ kind: "info", id: "w", level: "warning", text: "Only part was read." })).toBe("Warning Only part was read.");
    expect(row({ kind: "info", id: "n", level: "notice", text: "A hook checked it." })).toBe("A hook checked it.");
  });
  test("the plugin install rows", () => {
    expect(row({ kind: "plugin", id: "p1", status: "started" })).toBe("Installing plugins...");
    expect(row({ kind: "plugin", id: "p2", status: "installed", name: "tools" })).toBe("Installed tools");
    expect(row({ kind: "plugin", id: "p3", status: "failed", name: "lint", error: "Not found." })).toBe("Could not install lint. Not found.");
    expect(row({ kind: "plugin", id: "p4", status: "completed" })).toBe("Plugins installed");
  });
  test("memory recall, hook rows and the reconnect dividers", () => {
    expect(row({ kind: "memory", id: "m", items: [{ scope: "personal", path: "~/.claude/CLAUDE.md" }, { scope: "organization", path: "https://example.com/policy", text: "Be careful." }] })).toBe("Recalled from memory 2 memories");
    expect(row({ kind: "hook", id: "h", event: "PostToolUse", name: "format", output: "done" })).toBe("PostToolUse hook format");
    expect(row({ kind: "reconnect", id: "c1", phase: "loading" })).toBe("Loading recent output...");
    expect(row({ kind: "reconnect", id: "c2", phase: "missing" })).toBe("Some output produced while you were disconnected may be missing here.");
  });
  test("live thinking shows its estimate; a running call its time; a call auto mode denied its tag; a queued command Queued", () => {
    expect(row({ kind: "thinking", id: "t", seconds: 4, text: "x", live: true, tokenEstimate: 1900 })).toBe("Thinking... about 1.9k tokens");
    expect(row({ kind: "thinking", id: "t", seconds: 4, text: "x", tokenEstimate: 1900 }).trim()).toBe("Thought for 4s");
    expect(row({ kind: "tool", id: "b", name: "Bash", summary: "bun test", status: "running", elapsedSeconds: 12 })).toContain("12 s");
    expect(row({ kind: "tool", id: "b", name: "Bash", summary: "bun run docs", status: "running", background: true })).toContain("In the background");
    expect(row({ kind: "tool", id: "g", name: "Bash", summary: "git push", status: "auto-denied" })).toContain("Denied by auto mode");
    const queued = row({ kind: "bash", id: "q", command: "ls", stdout: "", stderr: "", code: 0, ms: 0, queued: true });
    expect(queued).toContain("Queued");
    expect(queued).not.toContain("exit");
  });
  test("a subagent shows its tokens, its type's description and its prompt; a workflow agent its retried attempt", () => {
    const agent = row({ kind: "agent", id: "a", agentType: "Explore", typeDescription: "Fast read-only search", description: "Find callers", prompt: "List every caller.", status: "done", rows: [], toolUses: 3, tokens: 18400, seconds: 20 });
    expect(agent).toContain("3 tools, 18.4k tokens, 20 s");
    expect(agent).toContain("Fast read-only search");
    expect(agent).toContain("Prompt List every caller.");
    const wf = row({ kind: "workflow", id: "w", name: "gate", description: "d", status: "done", phases: [{ title: "Checks", agents: [{ label: "size", status: "done", attempt: 2, task: "t" }, { label: "lint", status: "done", attempt: 1 }] }] });
    expect(wf).toContain("size Attempt 2 Done");
    expect(wf).not.toContain("Attempt 1");
  });
});

// ---- downloads (D37, BUILD-BRIEF section 7): a tool row whose target is a file, and an uploaded file a message refers to
describe("downloads in the transcript", () => {
  const tool = (name: string, summary: string, status: ToolItem["status"] = "ok", extra: Partial<ToolItem> = {}): ToolItem => ({ kind: "tool", id: `t_${name}`, name, summary, status, ...extra });
  const up = (id: string, path: string, state: Upload["state"] = "done"): Upload => ({ id, chatId: "c1", name: baseName(path), size: 48_213, type: "text/plain", path, folder: "temp", dir: path.slice(0, path.lastIndexOf("/")), at: "2026-10-30T00:00:00Z", state, progress: 1 });

  test("a tool row names a file when the call worked and its tool reads or writes one file", () => {
    expect(fileTarget(tool("Read", "src/upload.ts"))).toBe("src/upload.ts");
    expect(fileTarget(tool("Write", "src/query/tokenize.ts"))).toBe("src/query/tokenize.ts");
    expect(fileTarget(tool("Edit", "upload", "ok", { diff: { path: "src/upload.ts", removed: [], added: [] } }))).toBe("src/upload.ts");
    for (const name of ["Bash", "Grep", "Glob", "WebFetch", "docs-search"]) expect(fileTarget(tool(name, "src/upload.ts"))).toBeNull();
    for (const status of ["error", "running", "denied", "auto-denied"] as const) expect(fileTarget(tool("Write", "src/a.ts", status))).toBeNull();
  });
  test("a relative path is inside the project's folder; an absolute or home path stays as it is", () => {
    expect(hostPath("src/upload.ts", "~/src/kitespan")).toBe("~/src/kitespan/src/upload.ts");
    expect(hostPath("./docs/RELEASE.md", "~/scratch/demo/")).toBe("~/scratch/demo/docs/RELEASE.md");
    expect(hostPath("/tmp/x.log", "~/src/kitespan")).toBe("/tmp/x.log");
    expect(hostPath("~/notes.md", "~/src/kitespan")).toBe("~/notes.md");
    expect(hostPath("src/a.ts")).toBe("src/a.ts");
  });
  test("a message's references to finished uploads, with spaces in a name, each at a word boundary", () => {
    const log = up("u1", "/tmp/kitespan-uploads-dev/u-aaaaaa/server log.txt");
    const png = up("u2", "/tmp/kitespan-uploads-dev/u-bbbbbb/pasted.png");
    const busy = up("u3", "/tmp/kitespan-uploads-dev/u-cccccc/big.bin", "uploading");
    const text = `Read @${log.path} and @${png.path}, then @${busy.path} again: @${log.path}`;
    const parts = splitRefs(text, [png, log, busy]);
    expect(parts).toEqual(["Read ", { ref: `@${log.path}`, upload: log }, ` and @${png.path}, then @${busy.path} again: `, { ref: `@${log.path}`, upload: log }]);
    expect(referencedUploads(parts)).toEqual([log]);
    const both = splitRefs(`@${png.path} @${log.path} `, [log, png]);
    expect(referencedUploads(both).map((u) => u.id)).toEqual(["u2", "u1"]);
    expect(both.map((p) => (typeof p === "string" ? p : "REF")).join("")).toBe("REF REF ");
  });
  test("a reference is never a part of a longer path or word, and the longer of two paths wins", () => {
    const a = up("a", "/tmp/u-1/notes");
    const ab = up("ab", "/tmp/u-1/notes v2.txt");
    expect(referencedUploads(splitRefs(`see @/tmp/u-1/notes.bak`, [a]))).toEqual([]);
    expect(referencedUploads(splitRefs(`mail@/tmp/u-1/notes`, [a]))).toEqual([]);
    expect(splitRefs(`@${ab.path}`, [a, ab])).toEqual([{ ref: `@${ab.path}`, upload: ab }]);
    expect(splitRefs("no references here", [a])).toEqual(["no references here"]);
    expect(splitRefs("", [a])).toEqual([]);
  });

  const g = globalThis as Record<string, unknown>;
  const noop = () => {};
  function laptopWindow() {
    g.window = { innerWidth: 1280, innerHeight: 800, addEventListener: noop, removeEventListener: noop };
    g.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
  }
  const ctx = (chatId: string): Transcript => ({ chatId, view: "verbose", readOnly: false, isOpen: () => false, toggle: () => {} });
  const inChat = (item: Item, chatId: string) => renderToStaticMarkup(createElement(TranscriptProvider, { value: ctx(chatId) }, createElement(ItemView, { item, chatId })));

  test("a tool row on a file offers Download with the file's name; other rows do not", () => {
    const read = inChat({ kind: "tool", id: "tu_r", name: "Read", summary: "src/upload.ts", status: "ok", output: "48 lines" }, "demoolxxxxxxxxxxxxxx");
    expect(read).toContain('data-testid="download-tu_r"');
    expect(read).toContain('aria-label="Download upload.ts"');
    expect(read).toContain('class="icon-btn chat-dl"');
    expect(inChat({ kind: "tool", id: "tu_b", name: "Bash", summary: "bun test", status: "ok" }, "demoolxxxxxxxxxxxxxx")).not.toContain("download-");
    expect(inChat({ kind: "tool", id: "tu_w", name: "Write", summary: "src/a.ts", status: "denied" }, "demoolxxxxxxxxxxxxxx")).not.toContain("download-");
  });
  test("a message that refers to an upload shows its tile above the bubble, and the bubble leaves the reference out (M1)", () => {
    laptopWindow(); // the message reads the viewport (layout/size.ts), which has no server form
    const log = UPLOADS.demoolxxxxxxxxxxxxxx!.find((u) => u.state === "done")!;
    const text = `Look at @${log.path} please`;
    const out = inChat({ kind: "user", id: "m1", text }, "demoolxxxxxxxxxxxxxx");
    expect(out).toContain(`data-testid="download-${log.id}"`);
    expect(out).toContain(`aria-label="Download ${log.name}, 48 KB"`);
    expect(out.indexOf("chat-files")).toBeLessThan(out.indexOf("chat-bubble"));
    expect(out).not.toContain("chat-ref");
    expect(out).not.toContain(`@${log.path}`);
    expect(out).toMatch(/<div class="chat-bubble"[^>]*>Look at please<\/div>/);
    // The server adds the references at the end (D50): a message that is only files is the tiles alone, no bubble.
    const only = inChat({ kind: "user", id: "m4", text: `@${log.path}` }, "demoolxxxxxxxxxxxxxx");
    expect(only).toContain(`data-testid="download-${log.id}"`);
    expect(only).not.toContain("chat-bubble");
    expect(only).toContain("chat-user is-files");
    const sent = inChat({ kind: "user", id: "m5", text: `Read these\nplease @${log.path}` }, "demoolxxxxxxxxxxxxxx");
    expect(sent).toMatch(/<div class="chat-bubble"[^>]*>Read these\nplease<\/div>/);
    // Outside the chat that holds the upload (another chat, the read-only preview) it is plain text.
    expect(inChat({ kind: "user", id: "m2", text }, "asko2xxxxxxxxxxxxxxx")).not.toContain("chat-file");
    expect(inChat({ kind: "user", id: "m2", text }, "asko2xxxxxxxxxxxxxxx")).toContain(text);
    expect(renderToStaticMarkup(createElement(ItemView, { item: { kind: "user", id: "m3", text }, chatId: "", readOnly: true }))).toContain(text);
  });
  test("bubbleText closes up the spaces where a reference was left out", () => {
    const u = up("u1", "/tmp/u-1/a b.txt");
    const at = (t: string) => bubbleText(splitRefs(t, [u]));
    expect(at(`hello @${u.path}`)).toBe("hello");
    expect(at(`@${u.path} hello`)).toBe("hello");
    expect(at(`Read @${u.path} and @${u.path} then stop`)).toBe("Read and then stop");
    expect(at(`line one\n@${u.path}`)).toBe("line one");
    expect(at(`@${u.path} @${u.path}`)).toBe("");
    expect(at("no file  here  ")).toBe("no file  here  ");
  });

  // A click on Download asks the server's download route (a HEAD probe), then hands the URL to the browser; it records
  // nothing (a download is a read). A path outside the chat's folder asks nothing and shows the 5.4 line.
  const realFetch = g.fetch;
  afterEach(() => {
    delete g.document;
    delete g.window;
    delete g.matchMedia;
    g.fetch = realFetch;
  });
  function fakePage() {
    const saved: string[] = [];
    const asked: string[] = [];
    const anchor = { style: {}, href: "", download: "", rel: "", click() { saved.push(this.href); }, remove() {} };
    g.document = { createElement: () => anchor, body: { appendChild() {} } };
    g.window = { __kitespanFrames: [] };
    g.fetch = (async (url: string, init: RequestInit) => {
      asked.push(`${init.method} ${url}`);
      return Response.json({ exists: true, kind: "file", name: "x", size: 12 });
    }) as unknown as typeof fetch;
    return { saved, asked, frames: () => (g.window as { __kitespanFrames: unknown[] }).__kitespanFrames };
  }
  test("Download probes the chat's file or upload route, then saves it, and records nothing", async () => {
    const page = fakePage();
    const button = DownloadButton({ chatId: "c1", path: "/work/kitespan/src/upload.ts", folder: "/work/kitespan", testId: "x" }) as ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    const tiles = MessageFiles({ uploads: [up("u9", "/tmp/kitespan-uploads-dev/u-dddddd/flaky-run.log")] }) as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    tiles.props.children[0]!.props.onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(page.asked).toEqual(["GET /api/chats/c1/exists/src/upload.ts", "GET /api/chats/c1/uploads/u9/exists"]);
    expect(page.saved).toEqual(["/api/chats/c1/files/src/upload.ts", "/api/chats/c1/uploads/u9/file"]);
    expect(page.frames()).toEqual([]);
    expect(MessageFiles({ uploads: [] })).toBeNull();
    expect(relInFolder("src/a.ts", "/work/kitespan")).toBe("src/a.ts");
    expect(relInFolder("/work/kitespan/src/a.ts", "/work/kitespan/")).toBe("src/a.ts");
    expect(relInFolder("/work/other/a.ts", "/work/kitespan")).toBeNull();
    expect(relInFolder("/work/kitespan-old/a.ts", "/work/kitespan")).toBeNull();
  });
});

// ---- chat.css uses only the looks' tokens (prototype design plan v3 sections 1 and 2), so each look restyles the chat
describe("chat.css uses only tokens", () => {
  const STYLES = join(import.meta.dir, "..", "..", "web", "styles");
  const css = readFileSync(join(STYLES, "chat.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** Every declaration of the sheet, with its selector (nested @media blocks included). */
  const decls: { sel: string; prop: string; value: string }[] = [];
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth > 0; j++) depth += text[j] === "{" ? 1 : text[j] === "}" ? -1 : 0;
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media")) walk(body);
      else if (!head.startsWith("@keyframes"))
        for (const d of body.split(";")) {
          const at = d.indexOf(":");
          if (at > 0) decls.push({ sel: head.replace(/\s+/g, " "), prop: d.slice(0, at).trim(), value: d.slice(at + 1).trim() });
        }
      i = j;
    }
  };
  walk(css);

  test("no literal colour, shadow colour, radius, font or font size", () => {
    expect(decls.length).toBeGreaterThan(600); // the walk read the whole sheet
    const bad: string[] = [];
    for (const { sel, prop, value } of decls) {
      const v = value.replace(/var\([^)]*\)/g, "");
      const at = `${sel} { ${prop}: ${value} }`;
      if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black|gray|grey)\b/i.test(v)) bad.push(`${at} (colour)`);
      if (/radius/.test(prop) && !/^(0|inherit|var\(--r-[a-z-]+\)|calc\(var\(--r-[a-z-]+\) \/ \d\))$/.test(value)) bad.push(`${at} (radius)`);
      if ((prop === "font-family" || prop === "font") && !/^(var\(--font-[a-z]+\)|inherit)$/.test(value)) bad.push(`${at} (font)`);
      // Sizes come from the --fs tokens; an em size is a ratio of the token-sized text around it.
      if (prop === "font-size" && !/^(var\(--fs-[a-z0-9-]+\)|\d*\.?\d+em|inherit)$/.test(value)) bad.push(`${at} (font size)`);
      if (prop === "font-weight" && !/^var\(--(weight-strong|fw-regular)\)$/.test(value)) bad.push(`${at} (weight)`);
      if (prop === "box-shadow" && /\d+px \d+px [1-9]/.test(v)) bad.push(`${at} (an elevation shadow that is not --shadow-N)`);
    }
    expect(bad).toEqual([]);
  });
  test("every token it reads is defined in tokens.css", () => {
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
    const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    // U3: --rail-x is a place that the turn rail sets on itself and its card (beside the text), not a token,
    // as --chat-pad is a local one; --under-bar is layout.css's height of the glass title bar over the conversation.
    // S1: --chat-reveal is chat.css's own registered number (0 hidden, 1 shown) for a row's Copy and Take back.
    const local = new Set(["--chat-pad", "--rail-x", "--under-bar", "--chat-reveal"]);
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    expect([...used].filter((t) => !defined.has(t) && !local.has(t))).toEqual([]);
  });
  test("plan v3 section 4: the bubble, the prose, code, the cards and the blocks take the look's tokens", () => {
    const get = (sel: string, prop: string) => decls.find((d) => d.sel === sel && d.prop === prop)?.value;
    expect([get(".chat-bubble", "background"), get(".chat-bubble", "border-radius"), get(".chat-bubble", "color")]).toEqual(["var(--bubble-bg)", "var(--r-bubble)", "var(--bubble-text)"]);
    expect([get(".chat-md", "font-family"), get(".chat-md", "font-size")]).toEqual(["var(--font-prose)", "var(--fs-prose)"]);
    expect([get(".chat-md-code", "background"), get(".chat-md-code pre", "font-family")]).toEqual(["var(--code-bg)", "var(--font-mono)"]);
    for (const sel of [".chat-card", ".chat-task"]) expect([get(sel, "background"), get(sel, "box-shadow"), get(sel, "border-radius")]).toEqual(["var(--elevated)", "0 0 0 1px var(--hairline), var(--shadow-1)", "var(--r-card)"]);
    // No outlined control: the row buttons are base.css .btn, and nothing in the chat draws a border darker than a
    // hairline except the Other answer's field line.
    const strong = decls.filter((d) => /^border/.test(d.prop) && d.value.includes("--hairline-strong")).map((d) => d.sel);
    expect(strong).toEqual([".chat-opt-input"]);
  });
});

// ---- the waiting cards and their links (DESIGN.md 5.4 and 6.3)
describe("waiting cards and their links", () => {
  const at = (u: string) => parse(new URL(u, "http://127.0.0.1:1"));
  const chat = (id: string) => CHATS.find((c) => c.id === id)!;
  const TEXT = "Answer this request first. Then the composer comes back with your link's text.";

  test("a composer link opened while a card waits promises the link's text only when the link carries some", () => {
    const line = (u: string) => answerFirstLine(at(u));
    expect(line("/c/demoolxxxxxxxxxxxxxx/send?text=Run%20the%20tests")).toBe(TEXT);
    expect(line("/c/demoolxxxxxxxxxxxxxx/bash?cmd=ls")).toBe(TEXT);
    expect(line("/c/demoolxxxxxxxxxxxxxx/slash/compact?args=keep%20the%20plan")).toBe(TEXT);
    expect(line("/c/demoolxxxxxxxxxxxxxx/send")).toBe("Answer this request first. Then the composer comes back.");
    // Over the cap the router drops the text, so nothing comes back with it.
    expect(line(`/c/demoolxxxxxxxxxxxxxx/send?text=${"a".repeat(5001)}`)).toBe("Answer this request first. Then the composer comes back.");
    expect(line("/c/demoolxxxxxxxxxxxxxx/bash")).toBe("Answer this request first. Then the composer comes back in Bash mode.");
    for (const u of ["/c/demoolxxxxxxxxxxxxxx/slash", "/c/demoolxxxxxxxxxxxxxx/slash/compact", "/c/demoolxxxxxxxxxxxxxx/slash/doctor?args=x", "/c/demoolxxxxxxxxxxxxxx/slash/nope?args=x"])
      expect(line(u)).toBe("Answer this request first. Then the / menu opens.");
    expect(line("/c/demoolxxxxxxxxxxxxxx/add")).toBe("Answer this request first. Then the + menu opens.");
    expect(line("/c/demoolxxxxxxxxxxxxxx/model?pick=opus-5.5")).toBe("Answer this request first. Then the model picker opens.");
    expect(line("/c/demoolxxxxxxxxxxxxxx/effort")).toBe("Answer this request first. Then the model picker opens.");
    expect(line("/c/plano3xxxxxxxxxxxxxx/mode?pick=bypassPermissions")).toBe("Answer this request first. Then the permission mode picker opens.");
    expect(line("/c/demoolxxxxxxxxxxxxxx/mention?q=upl")).toBe("Answer this request first. Then the @ picker opens.");
    // The @ picker's path is a composer path: on an archived chat it shows the archived line (9.3, 8.4); the search
    // pane is a side panel view and is not.
    expect(archivedLinePath(at("/c/demoolxxxxxxxxxxxxxx/mention?q=upl"))).toBe(true);
    expect(archivedLinePath(at("/c/demoolxxxxxxxxxxxxxx/search?q=upl"))).toBe(false);
  });

  test("a card path finds its waiting card only on the path of the card's own kind", () => {
    expect(routedCardOf(chat("demoolxxxxxxxxxxxxxx"), at("/c/demoolxxxxxxxxxxxxxx/permission/rq_bash1"))?.id).toBe("rq_bash1");
    expect(routedCardOf(chat("demoolxxxxxxxxxxxxxx"), at("/c/demoolxxxxxxxxxxxxxx/question/rq_bash1"))).toBeUndefined();
    expect(routedCardOf(chat("asko2xxxxxxxxxxxxxxx"), at("/c/asko2xxxxxxxxxxxxxxx/question/rq_ask1?pick=Unit%20tests"))?.kind).toBe("question");
    expect(routedCardOf(chat("asko2xxxxxxxxxxxxxxx"), at("/c/asko2xxxxxxxxxxxxxxx/permission/rq_ask1?answer=once"))).toBeUndefined();
    expect(routedCardOf(chat("demoolxxxxxxxxxxxxxx"), at("/c/demoolxxxxxxxxxxxxxx/send?text=x"))).toBeUndefined();
  });

  test("a card path that does not wait gets 5.4's own line: answered, lost, not waiting, or unreadable", () => {
    const demo = chat("demoolxxxxxxxxxxxxxx");
    const waiting = demo.pending[0]!;
    if (waiting.kind !== "permission") throw new Error("demoolxxxxxxxxxxxxxx waits on a permission");
    expect(cardLinkLine(demo, "permission", waiting.id)).toBeNull();
    // An id the chat never had names no cause: no restart happened, and a real card may wait below.
    expect(cardLinkLine(demo, "permission", "rq_nope")).toEqual({ line: LINE_NOT_WAITING });
    expect(cardLinkLine(chat("asko2xxxxxxxxxxxxxxx"), "question", "rq_nope")).toEqual({ line: LINE_NOT_WAITING });
    expect(LINE_NOT_WAITING).toBe("That request is not waiting in this chat.");
    // A waiting card on the path of another kind.
    expect(cardLinkLine(demo, "question", waiting.id)).toEqual({ line: LINE_UNREAD });
    // An answered card leaves a record: the line, and the record the chat scrolls to.
    const record = { kind: "card" as const, id: "k_test1", card: { ...waiting, answered: "once" as const } };
    const answered: CardLinkChat = { items: [...demo.items, record], pending: [] };
    expect(cardLinkLine(answered, "permission", waiting.id)).toEqual({ line: LINE_ANSWERED, record });
    expect(cardLinkLine(answered, "plan", waiting.id)).toEqual({ line: LINE_UNREAD });
    // Lost only when the chat knows the request ended with its Claude Code process.
    const lost: CardLinkChat = { ...chat("oldo5xxxxxxxxxxxxxxx"), lostRequests: ["rq_lost1"] };
    expect(cardLinkLine(lost, "permission", "rq_lost1")).toEqual({ line: LINE_LOST });
    expect(cardLinkLine(lost, "question", "rq_lost1")).toEqual({ line: LINE_LOST });
    expect(cardLinkLine(lost, "permission", "rq_lost2")).toEqual({ line: LINE_NOT_WAITING });
    // Every lost request the scripted chats list shows the lost line.
    for (const c of CHATS as CardLinkChat[]) for (const id of c.lostRequests ?? []) expect(cardLinkLine(c, "permission", id)).toEqual({ line: LINE_LOST });
  });

  test("the elicitation form's on/off field is the shared switch, named by its label", () => {
    const c = chat("elico7xxxxxxxxxxxxxx");
    const card = c.pending.find((k) => k.kind === "elicitation")!;
    if (card.kind !== "elicitation") throw new Error("elico7xxxxxxxxxxxxxx waits on an elicitation");
    const out = renderToStaticMarkup(createElement(ElicitationCardView, { chat: c, card, cardRef: { current: null } }));
    const flag = card.fields!.find((f) => f.type === "boolean")!;
    expect(out).toContain('role="switch"');
    expect(out).toContain(`aria-labelledby="elicit-${card.id}-${flag.name}"`);
    expect(out).toContain(`id="elicit-${card.id}-${flag.name}">${flag.label}</span>`);
    expect([...out.matchAll(/type="checkbox"/g)].length).toBe(1); // only the switch's own checkbox
  });

  test("a question card's title is its header alone; with several questions the step is a quiet line of its own", () => {
    const c = chat("asko2xxxxxxxxxxxxxxx");
    const card = c.pending.find((k) => k.kind === "question")!;
    if (card.kind !== "question") throw new Error("asko2xxxxxxxxxxxxxxx waits on a question");
    expect(card.questions.length).toBe(2);
    const render = (k: typeof card) => renderToStaticMarkup(createElement(QuestionCardView, { chat: c, card: k, cardRef: { current: null } }));
    const two = render(card);
    expect(two).toContain(`>${card.questions[0]!.header}</h2>`);
    expect(text(two)).toContain("Question 1 of 2");
    expect(two.indexOf('data-testid="question-step"')).toBeLessThan(two.indexOf("chat-q-text"));
    expect(two).not.toContain("·");
    const one = render({ ...card, questions: [card.questions[0]!] });
    expect(one).toContain(`>${card.questions[0]!.header}</h2>`);
    expect(one).not.toContain("question-step");
  });
});

describe("the conversation's open rows (openRows.ts)", () => {
  const at = (u: string) => parse(new URL(u, "http://127.0.0.1:1"));

  test("a row route keeps its own key; a picker, menu, dialog, card, composer link or side detail shares the chat's", () => {
    for (const u of ["/c/runo4xxxxxxxxxxxxxxx/tool/tu_run_r1", "/c/runo4xxxxxxxxxxxxxxx/agent/tu_run_ag1", "/c/demoolxxxxxxxxxxxxxx/workflow/tu_wf1", "/c/demoolxxxxxxxxxxxxxx/thinking/m_think1", "/c/demoolxxxxxxxxxxxxxx/m/m_table"])
      expect(openRowsKey(at(u), at(u).params.chat!)).toBe(new URL(u, "http://x").pathname);
    expect(openRowsKey(at("/c/runo4xxxxxxxxxxxxxxx/tool/tu_run_r1?view=verbose"), "runo4xxxxxxxxxxxxxxx")).toBe("/c/runo4xxxxxxxxxxxxxxx/tool/tu_run_r1");
    const shared = ["/c/runo4xxxxxxxxxxxxxxx", "/c/runo4xxxxxxxxxxxxxxx?view=verbose", "/c/runo4xxxxxxxxxxxxxxx/model?pick=opus-5.5", "/c/runo4xxxxxxxxxxxxxxx/effort", "/c/runo4xxxxxxxxxxxxxxx/mode", "/c/runo4xxxxxxxxxxxxxxx/add", "/c/runo4xxxxxxxxxxxxxxx/slash", "/c/runo4xxxxxxxxxxxxxxx/slash/compact", "/c/runo4xxxxxxxxxxxxxxx/send?text=hi", "/c/runo4xxxxxxxxxxxxxxx/bash", "/c/runo4xxxxxxxxxxxxxxx/stop", "/c/runo4xxxxxxxxxxxxxxx/rename", "/c/runo4xxxxxxxxxxxxxxx/terminal", "/c/runo4xxxxxxxxxxxxxxx/details", "/c/runo4xxxxxxxxxxxxxxx/context", "/c/runo4xxxxxxxxxxxxxxx/environment", "/c/runo4xxxxxxxxxxxxxxx/connectors", "/c/runo4xxxxxxxxxxxxxxx/outputs", "/c/runo4xxxxxxxxxxxxxxx/uploads", "/c/runo4xxxxxxxxxxxxxxx/files/src/upload.ts", "/c/runo4xxxxxxxxxxxxxxx/permission/rq_x"];
    for (const u of shared) expect(openRowsKey(at(u), "runo4xxxxxxxxxxxxxxx")).toBe("/c/runo4xxxxxxxxxxxxxxx");
  });

  test("a picker opened over a block, and the chat it closes to, keep their rows apart from the chat's earlier entry", () => {
    const block = "/c/runo4xxxxxxxxxxxxxxx/tool/tu_run_ag1_g1";
    // Home, the chat, a block, the model picker, then Esc replaces the picker with the chat (the trail stays).
    expect(openRowsKey(at("/c/runo4xxxxxxxxxxxxxxx"), "runo4xxxxxxxxxxxxxxx", entryTrail({ from: "/", back: ["/"] }))).toBe("/c/runo4xxxxxxxxxxxxxxx");
    const over = openRowsKey(at("/c/runo4xxxxxxxxxxxxxxx/model"), "runo4xxxxxxxxxxxxxxx", entryTrail({ from: block, back: [block, "/c/runo4xxxxxxxxxxxxxxx", "/"] }));
    expect(over).toBe(`/c/runo4xxxxxxxxxxxxxxx over ${block}`);
    expect(openRowsKey(at("/c/runo4xxxxxxxxxxxxxxx"), "runo4xxxxxxxxxxxxxxx", [block, "/c/runo4xxxxxxxxxxxxxxx", "/"])).toBe(over);
    // A menu opened from there leads back to the same block through the chat's own routes.
    expect(openRowsKey(at("/c/runo4xxxxxxxxxxxxxxx/add"), "runo4xxxxxxxxxxxxxxx", ["/c/runo4xxxxxxxxxxxxxxx", block, "/c/runo4xxxxxxxxxxxxxxx", "/"])).toBe(over);
    // A picker over the chat itself, a trail that leaves the chat, and a script's bare from all share the chat's key.
    expect(openRowsKey(at("/c/runo4xxxxxxxxxxxxxxx/model"), "runo4xxxxxxxxxxxxxxx", ["/c/runo4xxxxxxxxxxxxxxx", "/"])).toBe("/c/runo4xxxxxxxxxxxxxxx");
    expect(openRowsKey(at("/c/runo4xxxxxxxxxxxxxxx/model"), "runo4xxxxxxxxxxxxxxx", ["/c/demoolxxxxxxxxxxxxxx", "/c/demoolxxxxxxxxxxxxxx/tool/tu_x"])).toBe("/c/runo4xxxxxxxxxxxxxxx");
    expect(entryTrail({ from: "/c/runo4xxxxxxxxxxxxxxx" })).toEqual(["/c/runo4xxxxxxxxxxxxxxx"]);
    expect(entryTrail(null)).toEqual([]);
    expect(chatRowsKey("runo4xxxxxxxxxxxxxxx", [block])).toBe(over);
  });

  test("leaving a row route keeps what the reader changed there and the rows its URL opened, unless the reader closed them", () => {
    const from = new Map([
      ["tu_a", false],
      ["tu_b", true],
      ["tu_c", false],
    ]);
    const next = carryRows(from, ["tu_c", "tu_d", "summary_1"]);
    expect([...next]).toEqual([
      ["tu_a", false],
      ["tu_b", true],
      ["tu_c", false],
      ["tu_d", true],
      ["summary_1", true],
    ]);
    expect([...from].length).toBe(3); // the row route's own state is not changed
    expect([...carryRows(undefined, ["tu_x"])]).toEqual([["tu_x", true]]);
  });
});
