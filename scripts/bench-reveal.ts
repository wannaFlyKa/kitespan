// The reveal's cost per frame (row 79: under about 4 ms for a reply of 20,000 characters). It builds the benchmark page
// (test/web/bench/reveal.html: one reply in the chat's column with the page's styles, streamed in pieces at a fixed
// pace and revealed frame by frame, as a live chat does) into a scratch folder, opens it in its own headless Chrome on
// a free port from 9341 to 9349 (stopped at the end), and prints each run's frame cost (the pacer, React's render and
// commit, and the layout) and each piece's lex, overall and over the reply's last quarter, when it is longest. It
// exits 1 when a run's 95th percentile frame over the last quarter is above --max-ms. Q1 review: --lang zh streams the
// Chinese reply (its unit is the word Intl.Segmenter finds), and --thinking a thinking block (plain text, revealed as
// ThinkingRow does), so the 4 ms bound is measured for those too.
//
// Usage: bun scripts/bench-reveal.ts [--chars 20000] [--pieces 400] [--ms 25] [--runs 3] [--max-ms 4] [--no-fade] [--lang en|zh] [--thinking] [--out <folder>]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cdp, sleep } from "./lib/cdp";
import { findChrome, freePort, launchChrome } from "./lib/chrome";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const opt = (name: string, dflt: number) => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(argv[i + 1]) : dflt;
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`bench-reveal: --${name} needs a positive number`);
    process.exit(2);
  }
  return v;
};
const CHARS = opt("chars", 20000);
const PIECES = opt("pieces", 400);
const MS = opt("ms", 25);
const RUNS = opt("runs", 3);
const MAX_MS = opt("max-ms", 4);
/** --no-fade: the same run with the fade-in spans' animation off (Reduce motion's styles), to see what the fades cost. */
const FADE = !argv.includes("--no-fade");
const langAt = argv.indexOf("--lang");
const LANG = langAt >= 0 ? argv[langAt + 1] : "en";
if (LANG !== "en" && LANG !== "zh") {
  console.error("bench-reveal: --lang is en or zh");
  process.exit(2);
}
const THINKING = argv.includes("--thinking");
const outAt = argv.indexOf("--out");
const own = outAt < 0;
const out = own ? mkdtempSync(join(tmpdir(), "bench-reveal-")) : resolve(argv[outAt + 1]!);

const build = await Bun.build({
  entrypoints: [join(ROOT, "test", "web", "bench", "reveal.html")],
  outdir: out,
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  sourcemap: "none",
});
if (!build.success) {
  for (const log of build.logs) console.error(log);
  process.exit(2);
}
writeFileSync(join(out, ".bench-reveal"), "a scratch build of bench-reveal.ts\n");

const binary = findChrome();
if (!binary) {
  console.error("bench-reveal: no Chrome for Testing found (set CHROME_PATH)");
  process.exit(2);
}
const port = freePort(9341, 9349);
if (!port) {
  console.error("bench-reveal: no free port from 9341 to 9349 for Chrome");
  process.exit(2);
}
const chrome = await launchChrome(binary, port, { extraArgs: ["--allow-file-access-from-files", "--window-size=1100,800"] });
let worst = 0;
try {
  const cdp = await Cdp.connect(chrome.wsUrl);
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const send = <T = any>(method: string, params: Record<string, unknown> = {}) => cdp.send<T>(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Performance.enable");
  const metrics = async () => Object.fromEntries((await send<{ metrics: { name: string; value: number }[] }>("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const ask = async (expr: string) => (await send<{ result: { value?: string } }>("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
  for (let run = 1; run <= RUNS; run++) {
    await send("Page.navigate", { url: `file://${join(out, "reveal.html")}?chars=${CHARS}&pieces=${PIECES}&ms=${MS}${FADE ? "" : "&fade=0"}&lang=${LANG}${THINKING ? "&kind=thinking" : ""}` });
    const t0 = Date.now();
    let result: any = null;
    let before: Record<string, number> | null = null;
    while (!before && Date.now() - t0 < 20_000) {
      if (await ask("window.__started ? 'yes' : ''")) before = await metrics();
      else await sleep(20);
    }
    while (!result && Date.now() - t0 < 120_000) {
      await sleep(100);
      const v = await ask("window.__done ? JSON.stringify(window.__result) : ''");
      if (v) result = JSON.parse(v);
    }
    const after = await metrics();
    if (!result) {
      console.error(`bench-reveal: run ${run} did not finish in 120 s`);
      process.exitCode = 2;
      break;
    }
    const f = result.frames;
    const q = result.framesLastQuarter;
    const l = result.lexLastQuarter;
    const per = (k: string) => (before ? Math.round((((after[k] ?? 0) - (before[k] ?? 0)) * 1000 * 100) / Math.max(1, result.framesCounted)) / 100 : NaN);
    console.log(
      `run ${run}: ${result.chars} characters (${result.lang}, ${result.kind}) in ${result.pieces} pieces, ${result.pieceMs} ms apart (${result.streamMs} ms); ` +
        `frame ms mean ${f.mean} p50 ${f.p50} p95 ${f.p95} max ${f.max} (${f.n} frames); ` +
        `last quarter mean ${q.mean} p50 ${q.p50} p95 ${q.p95} max ${q.max}; ` +
        `lex per piece, last quarter: mean ${l.mean} p95 ${l.p95} max ${l.max}; fading words at most ${result.maxFadingWords}; shown at the end ${result.shownAtEnd}; ` +
        `the main thread's whole time per frame (CDP Performance.getMetrics): task ${per("TaskDuration")} ms, script ${per("ScriptDuration")}, layout ${per("LayoutDuration")}, style ${per("RecalcStyleDuration")}`,
    );
    worst = Math.max(worst, q.p95);
  }
  console.log(`bench-reveal: worst 95th percentile frame over the last quarter: ${worst} ms (target ${MAX_MS} ms)`);
  cdp.close();
} finally {
  await chrome.stop();
  if (own) rmSync(out, { recursive: true, force: true });
}
if (!process.exitCode && worst > MAX_MS) process.exitCode = 1;
