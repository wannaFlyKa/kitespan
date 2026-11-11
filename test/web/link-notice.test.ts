// The router's 5.4 line (DESIGN.md 5.4): one line per problem. A pre-fill over its cap gets the screen's own line at
// the field ("That link's text is too long to fill in ..."), so the router's "Part of that link could not be read."
// stays away for it; any other bad value, and a bad path, still get the router's line. On a chat's screen, a path
// whose target is not there (a card that does not wait on it) shows that target's line alone (chatLinkLine).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../../web/router";
import { chatLinkLine, linkNoticeLine } from "../../web/ui/LinkNotice";

const PART = "Part of that link could not be read.";
const WHOLE = "That link could not be read.";

/** The line for a URL, with location set to it as the page has it. */
function lineFor(u: string): string | null {
  const url = new URL(u, "http://127.0.0.1:7941");
  const g = globalThis as unknown as { location?: URL };
  g.location = url;
  try {
    return linkNoticeLine(parse(url));
  } finally {
    delete g.location;
  }
}

const long = encodeURIComponent("a".repeat(5001));
const longTitle = encodeURIComponent("b".repeat(121));

describe("the router's 5.4 line", () => {
  test("a link read in full has no line", () => {
    expect(lineFor("/c/demoolxxxxxxxxxxxxxx")).toBeNull();
    expect(lineFor("/c/idleo6xxxxxxxxxxxxxx/send?text=Run%20the%20tests%20again")).toBeNull();
  });
  for (const [what, u] of [
    ["send text", `/c/idleo6xxxxxxxxxxxxxx/send?text=${long}`],
    ["bash cmd", `/c/idleo6xxxxxxxxxxxxxx/bash?cmd=${long}`],
    ["slash args", `/c/idleo6xxxxxxxxxxxxxx/slash/compact?args=${long}`],
    ["new-chat text", `/new?text=${long}`],
    ["rename title", `/c/demoolxxxxxxxxxxxxxx/rename?title=${longTitle}`],
    ["setting value", `/settings/chats/live-max?value=${longTitle}`],
  ] as const)
    test(`a ${what} over its cap leaves the line to the field`, () => {
      expect(lineFor(u)).toBeNull();
    });
  test("an over-cap pre-fill with another bad value keeps the router's line", () => {
    expect(lineFor(`/c/idleo6xxxxxxxxxxxxxx/send?text=${long}&view=bogus`)).toBe(PART);
  });
  test("a pre-fill that is bad but not over its cap keeps the router's line", () => {
    expect(lineFor("/c/idleo6xxxxxxxxxxxxxx/send?text=a%01b")).toBe(PART);
  });
  test("a text value that is not a pre-fill keeps the router's line", () => {
    expect(lineFor(`/new?project=${encodeURIComponent("p".repeat(33))}`)).toBe(PART);
    expect(lineFor("/c/demoolxxxxxxxxxxxxxx?view=bogus")).toBe(PART);
  });
  test("a bad path inside an app family gets the whole-link line", () => {
    expect(lineFor("/c/demoolxxxxxxxxxxxxxx/contxt")).toBe(WHOLE);
  });
});

describe("one 5.4 line at most on a chat's screen (principle 0)", () => {
  const NOT_WAITING = "That request is not waiting in this chat.";
  const at = (u: string) => {
    const url = new URL(u, "http://127.0.0.1:7941");
    const g = globalThis as unknown as { location?: URL };
    g.location = url;
    try {
      return parse(url);
    } finally {
      delete g.location;
    }
  };
  test("a card path with a bad value, for a card that is not waiting: the card's line alone", () => {
    for (const u of ["/c/demoolxxxxxxxxxxxxxx/permission/toolu_01AbCdEf?answer=bad", "/c/demoolxxxxxxxxxxxxxx/plan/toolu_01AbCdEf?answer=bogus"]) {
      const route = at(u);
      expect(route.dropped).toBeTruthy();
      expect(chatLinkLine(route, NOT_WAITING, true)).toBe(NOT_WAITING);
      // On an archived chat the composer's place says "This chat is archived." for the path: no line here.
      expect(chatLinkLine(route, null, true)).toBeNull();
    }
  });
  test("a target that is there keeps the router's line for a bad part of the link; a link read in full has none", () => {
    expect(chatLinkLine(at("/c/demoolxxxxxxxxxxxxxx/permission/toolu_01AbCdEf?answer=bad"), null, false)).toBe(PART);
    expect(chatLinkLine(at("/c/demoolxxxxxxxxxxxxxx?view=bogus"), null, false)).toBe(PART);
    expect(chatLinkLine(at("/c/demoolxxxxxxxxxxxxxx/contxt"), null, false)).toBe(WHOLE);
    expect(chatLinkLine(at("/c/demoolxxxxxxxxxxxxxx"), null, false)).toBeNull();
  });
  test("the conversation draws the one line; the chat screen draws none of its own", () => {
    const web = join(import.meta.dir, "..", "..", "web");
    const screen = readFileSync(join(web, "chat", "ChatScreen.tsx"), "utf8");
    expect(screen).not.toContain("linkNoticeLine");
    const view = readFileSync(join(web, "chat", "ChatView.tsx"), "utf8");
    expect(view).toContain("chatLinkLine(route, line, ");
  });
});
