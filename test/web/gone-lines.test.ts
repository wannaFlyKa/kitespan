// The lines of DESIGN.md 5.4 (a link to something that is gone, lost or bad), each pinned to a route that shows it.
// The deep-link check (DESIGN.md 5.5 step 5) compares the page's line with the table's, word for word, so a line that
// is close is a failure: "That file is not in this chat." once stood where 5.4 says "That file is not in this chat's
// folder." The test checks three things: each route example parses to its route; the panels area's own lines render
// on their routes (react-dom/server), with no Download on a file that is not there; and every "That ... is not ..."
// sentence in the page's source is one of the 5.4 lines, and every 5.4 line is in the source.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import { CHATS } from "./fixtures";
import { FILE_GONE, FileBody } from "../../web/panels/file";
import { CONNECTOR_GONE, Detail } from "../../web/panels/details";

/** DESIGN.md 5.4, the Line column, with one route example per row (the route's name after the arrow). */
const LINES: { line: string; examples: [url: string, route: string][] }[] = [
  {
    line: "That chat is not here. It may have been deleted.",
    examples: [
      ["/c/nopeggxxxxxxxxxxxxxx", "chat"],
      ["/c/nopeggxxxxxxxxxxxxxx/uploads", "uploads"],
      ["/c/nopeggxxxxxxxxxxxxxx/files/src/a.ts", "files"],
    ],
  },
  { line: "That project is not here.", examples: [["/p/nopeggxxxx", "project"]] },
  { line: "That session is not in this project's folder.", examples: [["/p/demoolxxxx/session/00000000-0000-4000-8000-000000000000", "session"]] },
  { line: "That message is not in this chat.", examples: [["/c/demoolxxxxxxxxxxxxxx/m/nope", "message"]] },
  { line: "That request was already answered.", examples: [] },
  { line: "That request was lost when Claude Code restarted. Send a message to continue.", examples: [] },
  { line: "That request is not waiting in this chat.", examples: [["/c/demoolxxxxxxxxxxxxxx/permission/nope", "permission"]] },
  { line: "That choice is not available in this chat.", examples: [["/c/demoolxxxxxxxxxxxxxx/model?pick=nope", "model"]] },
  { line: "That connector is not in this chat.", examples: [["/c/demoolxxxxxxxxxxxxxx/connectors?server=nope", "connectors"]] },
  { line: "That file is not in this chat's folder.", examples: [["/c/demoolxxxxxxxxxxxxxx/files/src/nope.ts", "files"]] },
  // U1 (DESIGN-U1 8.1): a file that is not in the turn's changes, and a summary that is gone (the changes view's place).
  { line: "That file is not in this turn's changes.", examples: [["/c/demoolxxxxxxxxxxxxxx/changes/k3m7q2x4ab/src/nope.ts", "changesFile"]] },
  { line: "These changes are no longer kept.", examples: [["/c/demoolxxxxxxxxxxxxxx/changes/k3m7q2x4ab", "changesTurn"]] },
  { line: "Bypass permissions is off. You can allow it in Settings > Chats.", examples: [["/c/demoolxxxxxxxxxxxxxx/mode?pick=bypassPermissions", "mode"]] },
  { line: "Start a new chat to use Bypass permissions.", examples: [] },
  { line: "That link's text is too long to fill in (the limit is 5,000 characters, or 120 for a title or a setting).", examples: [] },
  { line: "That setting does not exist.", examples: [["/settings/general/nope", "settingsSection"]] },
  { line: "That link could not be read.", examples: [["/c/demoolxxxxxxxxxxxxxx/contxt", "chat"]] },
  { line: "Part of that link could not be read.", examples: [] },
  { line: "There is no kitespan page at this address.", examples: [] },
  // Iteration 7 (DESIGN-B1 4.13, in 5.4's form): a browser tab that a link names and that is gone.
  { line: "That tab is not open any more.", examples: [] },
];
/**
 * R127: the Trust this folder confirm's answer to a press whose folder changed since Claude Code refused it (DESIGN-R127
 * 10): a refused request's line in the confirm, not a 5.4 line for a link.
 */
const PRESS_LINES = ["That path is not a folder now."];
const EXACT = new Set([...LINES.map((l) => l.line), ...PRESS_LINES]);

const url = (path: string) => new URL(path, "http://127.0.0.1");
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("each 5.4 route example opens the route that shows its line", () => {
  for (const { line, examples } of LINES)
    for (const [path, name] of examples)
      test(`${path} is the ${name} route (${line})`, () => {
        expect(parse(url(path)).name).toBe(name);
      });
});

describe("the panels area's own 5.4 lines, rendered on their routes", () => {
  const chat = CHATS.find((c) => c.id === "demoolxxxxxxxxxxxxxx")!;

  // The download page asks the route's existence probe first (panels/download.ts); the body is drawn for the probe's
  // answer: a gone path gives the 5.4 line, a passing probe gives Download.
  test("a file path that is not in the chat's folder: the exact line, and no Download", () => {
    expect(FILE_GONE).toBe("That file is not in this chat's folder.");
    for (const place of ["column", "pane", "sheet", "page"] as const) {
      const html = renderToStaticMarkup(createElement(FileBody, { chat, path: "src/nope.ts", place, state: { phase: "done", ok: false, status: 404, line: FILE_GONE } }));
      expect(text(html)).toContain("That file is not in this chat's folder.");
      expect(html).not.toContain('data-testid="file-download-button"');
    }
  });

  test("a file that is in the chat's folder shows Download and no 5.4 line", () => {
    const path = chat.outputs[0]!.path;
    const html = renderToStaticMarkup(createElement(FileBody, { chat, path, place: "pane", state: { phase: "done", ok: true, probe: { kind: "file", name: path, size: 900, entries: null } } }));
    expect(html).toContain('data-testid="file-download-button"');
    expect(html).not.toContain('data-testid="link-notice"');
  });

  test("a server value that is not one of the chat's: the exact line, and no row marked", () => {
    expect(CONNECTOR_GONE).toBe("That connector is not in this chat.");
    const html = renderToStaticMarkup(createElement(Detail, { name: "connectors", chat, route: parse(url("/c/demoolxxxxxxxxxxxxxx/connectors?server=nope")) }));
    expect(text(html)).toContain("That connector is not in this chat.");
    expect(html).not.toContain("data-marked");
  });
});

describe("the source says the 5.4 lines word for word", () => {
  const root = join(import.meta.dir, "..", "..", "web");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(root);
  const sources = files.map((f) => ({ f, src: readFileSync(f, "utf8") }));
  // The 404 page is the server's own (server/http/static.ts).
  const server = readFileSync(join(root, "..", "server", "http", "static.ts"), "utf8");

  test("every 5.4 line is in the page or the server, whole", () => {
    const all = sources.map((s) => s.src).join("\n") + server;
    const missing = LINES.map((l) => l.line).filter((line) => !all.includes(line));
    expect(missing).toEqual([]);
  });

  test('every "That ... is not ..." sentence is a 5.4 line, not a near one', () => {
    const near: string[] = [];
    for (const { f, src } of sources)
      for (const m of src.matchAll(/That [a-z]+ (?:is|was) not [^"`<{}\n]*?\.(?= |"|`|<|\n|$)(?: It may have been deleted\.)?/g))
        if (!EXACT.has(m[0])) near.push(`${f.slice(root.length + 1)}: ${m[0]}`);
    expect(near).toEqual([]);
  });
});
