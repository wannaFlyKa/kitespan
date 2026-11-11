// U5 (DESIGN-U5 4 and 6; FIX-U5 2 "the text extraction per item kind"): what the message search keeps of a
// transcript's events: the user's words without their file references, Claude's replies on the main thread as the chat
// shows them (each Markdown mark that does not show taken out, a link's text and an image's alt kept), under the page's
// own row ids, each with who said it (the user or the agent); never thinking, tool input or output, `!` commands, local
// output, notices, compaction or subagent rows.
import { describe, expect, test } from "bun:test";
import { messageRef, type ChatEvent } from "../../shared/protocol";
import { collapseSpace, replySearchText, searchableMessages, userSearchText } from "../../server/search/text";

const U1 = "aaaaaaaa-0000-4000-8000-000000000001";
const U2 = "aaaaaaaa-0000-4000-8000-000000000002";

describe("each kind of event", () => {
  const events: ChatEvent[] = [
    { k: "user", uuid: U1, text: "Where is the zebra cache?", queued: false },
    { k: "block", key: "msg_01A:0", kind: "thinking", text: "thinking about the walrus", parent: null },
    { k: "block", key: "msg_01A:1", kind: "text", text: "Let me look for the **zebra** cache.", parent: null },
    { k: "tool_call", id: "toolu_01", name: "Bash", input: { command: "grep -r ostrich ." }, parent: null },
    { k: "tool_result", id: "toolu_01", text: "src/ostrich.ts: the ostrich line", isError: false, parent: null, report: null },
    { k: "block", key: "msg_01B:0", kind: "text", text: "A subagent's own words about a heron", parent: "toolu_02" },
    { k: "bash", uuid: U2, input: "echo penguin", state: "done", stdout: "penguin", stderr: "", code: 0, ms: 3, timedOut: false, capped: false },
    { k: "local_output", stream: "stdout", text: "Compacted: the flamingo" },
    { k: "compacted", trigger: "auto" },
    { k: "block", key: "msg_01C:0", kind: "text", text: "Found it: the zebra cache is in `src/cache.ts`.", parent: null },
  ];
  const kept = searchableMessages(events);

  test("the user's message and the main thread's replies, in order, under the page's row ids, each with who said it", () => {
    expect(kept).toEqual([
      { id: U1, by: "user", text: "Where is the zebra cache?" },
      { id: "msg_01A-1", by: "agent", text: "Let me look for the zebra cache." },
      { id: "msg_01C-0", by: "agent", text: "Found it: the zebra cache is in src/cache.ts." },
    ]);
  });
  test("thinking, tool input and output, ! commands, local output and subagent rows are left out", () => {
    const all = kept.map((m) => m.text).join(" ");
    for (const w of ["walrus", "ostrich", "heron", "penguin", "flamingo"]) expect(all).not.toContain(w);
  });
  test("an empty message is left out", () => {
    expect(searchableMessages([{ k: "user", uuid: U1, text: "   \n ", queued: false }, { k: "block", key: "k:0", kind: "text", text: "```\n```", parent: null }])).toEqual([]);
  });
});

describe("a provider's resource name", () => {
  test("is kept as [an ARN] in a user's message and in a reply, so no snippet carries one", () => {
    const arn = `arn:aws:bedrock:us-east-1:${"0".repeat(12)}:inference-profile/demo`;
    const kept = searchableMessages([
      { k: "user", uuid: U1, text: `Which model is ${arn} here?`, queued: false },
      { k: "block", key: "m:0", kind: "text", text: `It is \`${arn}\` (the default).`, parent: null },
    ]);
    expect(kept.map((m) => m.text)).toEqual(["Which model is [an ARN] here?", "It is [an ARN] (the default)."]);
    expect(JSON.stringify(kept)).not.toContain("arn:");
  });
});

describe("the user's words", () => {
  test("without the file references that the tiles stand for, in every form", () => {
    for (const path of ["/srv/demo/notes/plan.md", "/srv/demo/notes/plan with space.md"]) {
      expect(userSearchText(`Read this ${messageRef(path)} please`)).toBe("Read this please");
      expect(userSearchText(`Read this please ${messageRef(path)}`)).toBe("Read this please");
    }
    expect(userSearchText("mail me at a@b.example")).toBe("mail me at a@b.example");
  });
  test("white space collapsed; Markdown in a user's message stays as typed", () => {
    expect(userSearchText("  two\n\nlines  and **stars** ")).toBe("two lines and **stars**");
  });
});

describe("a reply as the chat shows it (DESIGN-U5 6)", () => {
  test("each mark that does not show is taken out", () => {
    expect(replySearchText("Some `code` and ``more``")).toBe("Some code and more");
    expect(replySearchText("**bold**, __strong__ and ~~gone~~")).toBe("bold, strong and gone");
    expect(replySearchText("# Title\n## Sub title\n###### Six")).toBe("Title Sub title Six");
    expect(replySearchText("> quoted\n> > twice")).toBe("quoted twice");
    expect(replySearchText("- one\n* two\n+ three\n1. four\n2) five\n- [x] done\n- [ ] open")).toBe("one two three four five done open");
    expect(replySearchText("```ts\nconst zebra = 1;\n```\n~~~\nplain\n~~~")).toBe("const zebra = 1; plain");
    expect(replySearchText("above\n\n---\n***\nbelow")).toBe("above below");
    expect(replySearchText("| a | b |\n|---|:-:|\n| c | d |")).toBe("a b c d");
    expect(replySearchText("a | b in prose")).toBe("a | b in prose");
  });
  test("a link keeps its text, an image its alt text; neither keeps its target", () => {
    expect(replySearchText("See [the docs](https://example.invalid/zebra) and ![a chart](chart.png).")).toBe("See the docs and a chart.");
  });
  test("a single star, an underscore in a name and a #hashtag mid-line stay", () => {
    expect(replySearchText("a *note* on snake_case and #42")).toBe("a *note* on snake_case and #42");
  });
  test("markup that shows as text stays text", () => {
    expect(replySearchText("<b>x</b> stays")).toBe("<b>x</b> stays");
  });
  test("white space runs are one space", () => {
    expect(collapseSpace("a \t\n  b")).toBe("a b");
  });
});
