// Settings > About for an installed kitespan (DESIGN-I1 3.6): a release install has a checkout's rows, with "Version
// <v>" under Update available (the newest release) and under Restart to apply (the version that the next start runs),
// a step line while its update runs, the failed line with Update again, and its own words for Check for updates; a
// Homebrew install has "Installed with Homebrew", whose line names `brew upgrade kitespan` as a code span that one tap
// selects whole, no Update, no Check for updates and no Check now, and Restart to apply with its version once `brew
// upgrade` moved the opt link. A checkout's rows do not change (update.test.ts). react-dom/server, a fake fetch.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UpdateReply } from "../../server/http/api-types";
import { failedLine, runningLine, UPDATE_WORDS } from "../../shared/update";
import { resetState } from "../../web/state/store";
import { MORE, MORE_RELEASE_CHECK, SectionBody } from "../../web/screens/Settings";
import { resetUpdateState, setUpdateState } from "../../web/update/state";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);

const LAPTOP = { touch: false, laptop: true, phone: false, narrow: false };
const PHONE = { touch: true, laptop: false, phone: true, narrow: true };
const about = (ctx: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SectionBody, { id: "about", ctx: { ...LAPTOP, ...ctx } }));
const row = (html: string, id: string) => {
  const at = html.indexOf(`data-testid="${id}"`);
  return at < 0 ? "" : html.slice(at, html.indexOf("</li>", at));
};
const facts = (p: Partial<UpdateReply> = {}): UpdateReply => ({ update: "none", build: "none", check: { at: null, ok: true, why: null, running: false }, job: { state: "idle" }, can: true, kind: "checkout", latest: null, next: null, ...p });
const release = (p: Partial<UpdateReply> = {}) => facts({ kind: "release", ...p });
const brew = (p: Partial<UpdateReply> = {}) => facts({ kind: "brew", can: false, ...p });

const gm = globalThis as unknown as { matchMedia?: unknown; window?: Record<string, unknown>; fetch: typeof fetch };
const own = { mm: !gm.matchMedia, win: !gm.window, fetch: gm.fetch };
const calls: string[] = [];
beforeAll(() => {
  gm.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  gm.window ??= { innerWidth: 1100, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  gm.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  gm.fetch = own.fetch;
  resetUpdateState();
  resetState();
});
beforeEach(() => {
  resetState({ ready: true });
  resetUpdateState();
  calls.length = 0;
});

describe("a release install's About (DESIGN-I1 3.6)", () => {
  test("Update available with the newest release's version and Update; the check's two rows stay", () => {
    for (const ctx of [LAPTOP, PHONE]) {
      setUpdateState({ facts: release({ update: "available", latest: "0.2.0" }) });
      const html = about(ctx);
      const r = row(html, "setting-update");
      expect(text(r)).toContain(`${UPDATE_WORDS.available} Version 0.2.0`);
      expect(ids(r)).toContain("update-open");
      expect(ids(html)).toEqual(expect.arrayContaining(["setting-check-for-updates", "setting-check-now", "setting-restart"]));
      expect(ids(html)).not.toContain("setting-homebrew");
    }
  });

  test("while its update runs, the step line alone; when it did not finish, the line with Update again", () => {
    setUpdateState({ facts: release({ update: "available", latest: "0.2.0", job: { state: "running", step: "fetch" } }) });
    let html = about();
    expect(text(row(html, "setting-update-step"))).toContain(runningLine("fetch"));
    expect(runningLine("fetch")).toBe("Updating kitespan: step 1 of 3, fetch.");
    expect(ids(html)).not.toContain("setting-update");
    setUpdateState({ facts: release({ job: { state: "failed", step: "install", line: failedLine("install") } }) });
    html = about();
    const r = row(html, "setting-update");
    expect(text(r)).toContain("The update did not finish at step 2 of 3, install.");
    expect(ids(r)).toContain("update-open");
  });

  test("the next start runs another version: Restart to apply with its version, above Restart", () => {
    setUpdateState({ facts: release({ build: "apply", next: "0.2.0", job: { state: "done" } }) });
    const html = about();
    expect(text(row(html, "setting-restart-to-apply"))).toContain("Restart to apply Version 0.2.0");
    expect(html.indexOf('data-testid="setting-restart-to-apply"')).toBeLessThan(html.indexOf('data-testid="setting-restart"'));
    expect(ids(html)).not.toContain("setting-update");
  });

  test("Check for updates' longer words say what a release install's check reads; a checkout's stay its own", () => {
    setUpdateState({ facts: release() });
    const more = text(row(about({ focusKey: "check-for-updates" }), "setting-check-for-updates"));
    expect(more).toContain(MORE_RELEASE_CHECK);
    expect(MORE_RELEASE_CHECK).toContain("A check downloads one small file of the latest release, and names no version, no machine and no account.");
    setUpdateState({ facts: facts() });
    expect(text(row(about({ focusKey: "check-for-updates" }), "setting-check-for-updates"))).toContain(String(MORE["check-for-updates"]));
  });

  test("before About's own read answers, a checkout's rows (origin's line from welcome); nothing is sent by a draw", () => {
    const html = about();
    expect(ids(html)).toEqual(expect.arrayContaining(["setting-check-for-updates", "setting-check-now"]));
    expect(calls).toEqual([]);
  });
});

describe("a Homebrew install's About (DESIGN-I1 3.6)", () => {
  test("Installed with Homebrew, the command as a code span that one tap selects; no Update, no check rows", () => {
    for (const ctx of [LAPTOP, PHONE]) {
      setUpdateState({ facts: brew() });
      const html = about(ctx);
      const r = row(html, "setting-homebrew");
      expect(text(r)).toContain(UPDATE_WORDS.brewLabel);
      expect(r).toContain('<code class="select-all">brew upgrade kitespan</code>');
      expect(text(r)).toContain("Update it with brew upgrade kitespan , then restart kitespan.");
      for (const id of ["setting-check-for-updates", "setting-check-now", "check-now", "update-open", "setting-update"]) expect([id, ids(html).includes(id)]).toEqual([id, false]);
      expect(ids(html)).toContain("setting-restart");
    }
  });

  test("after `brew upgrade` moved opt: Restart to apply with the new keg's version", () => {
    setUpdateState({ facts: brew({ build: "apply", next: "0.1.1" }) });
    const html = about();
    expect(text(row(html, "setting-restart-to-apply"))).toContain("Restart to apply Version 0.1.1");
    expect(ids(html)).toContain("setting-homebrew");
    expect(ids(html)).not.toContain("update-open");
  });

  test("a keg that is not whole: the line of an update that did not finish, with no Update (Homebrew updates it)", () => {
    setUpdateState({ facts: brew({ build: "unfinished", next: "0.1.2" }) });
    const r = row(about(), "setting-restart-to-apply");
    expect(text(r)).toContain(`Restart to apply ${UPDATE_WORDS.unfinished}`);
    expect(ids(r)).not.toContain("update-open");
  });
});
