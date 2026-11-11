// The reveal's benchmark in a real browser (row 79: under about 4 ms per frame for a 20,000-character reply). A long
// reply (test/fake-claude/long-reply.ts) streams in pieces at a fixed pace, as the fake claude's paced stream does;
// each piece is lexed from the last blocks (lexMarkdown) and each animation frame advances the pacer and draws the
// reply up to its cut, as AssistantText does, with the chat's own styles. A frame's cost is the pacer, React's
// render and commit, and the layout that follows (read at once, so it is counted in the frame); a piece's cost is
// its lex. The result goes to window.__result for scripts/bench-reveal.ts, which also reads the main thread's whole
// time (the fades' style and paint too) between window.__started and window.__done. Query: chars, pieces, ms, fade
// (0: no fade-in spans' animation, to see what the fades cost), lang (zh: the Chinese reply, whose unit is the word
// Intl.Segmenter finds; Q1 review) and kind (thinking: plain text, held and revealed as ThinkingRow does).
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "../../../web/styles/app.css";
import { MarkdownView, holdPartial, holdWord, lexMarkdown, revealText, type MarkdownModel, type RevealCut } from "../../../web/chat/Markdown";
import { advance, arrive, cutNow, finish, newPacer, settled } from "../../../web/chat/reveal";
import { longReply, longReplyZh, longThinking } from "../../fake-claude/long-reply";

const q = new URLSearchParams(location.search);
const CHARS = Number(q.get("chars") ?? 20000);
const PIECES = Number(q.get("pieces") ?? 400);
const MS = Number(q.get("ms") ?? 25);
if (q.get("fade") === "0") document.documentElement.dataset.motion = "reduce";
const ZH = q.get("lang") === "zh";
const THINKING = q.get("kind") === "thinking";

interface Sample {
  /** When (ms from the first piece). */
  t: number;
  /** The reply's length that came by then (characters of markdown). */
  got: number;
  ms: number;
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { n: s.length, mean: r(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)), p50: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1] ?? 0) };
};

const src = THINKING ? longThinking(CHARS, ZH ? "zh" : "en") : ZH ? longReplyZh(CHARS) : longReply(CHARS);
const piece = Math.ceil(src.length / PIECES);
const root = createRoot(document.getElementById("root")!);
const scroller = document.getElementById("scroller")!;
const frames: Sample[] = [];
const lexes: Sample[] = [];
let got = 0;
let model: MarkdownModel = lexMarkdown("", null);
/** Thinking: the text that shows while it streams (useHeldWord). */
let held = "";
let cut: RevealCut | null = null;
let t0 = 0;
let ended = 0;
let maxWords = 0;
const pacer = newPacer(0, performance.now());

// The reply's row as AssistantText draws it: is-live while it streams (S1: its top blocks are isolated then); or the
// thinking row's body as ThinkingRow draws it, open.
const draw = () =>
  root.render(
    THINKING ? (
      <div className="chat-item chat-item-thinking">
        <div className={`chat-think is-open${ended ? "" : " is-live"}`}>
          <div className="chat-row-body chat-think-body">{revealText(held, cut)}</div>
        </div>
      </div>
    ) : (
      <div className="chat-item chat-item-assistant">
        <div className={`chat-assistant${ended ? "" : " is-live"}`}>
          <div>
            <MarkdownView model={model} reveal={cut} />
          </div>
        </div>
      </div>
    ),
  );
/** What the pacer reveals: the reply's units, or the thinking text's characters. */
const total = () => (THINKING ? held.length : model.total);

function deliver() {
  if (got >= src.length) return;
  const now = performance.now();
  if (!t0) {
    t0 = now;
    (window as unknown as { __started: boolean }).__started = true;
  }
  got = Math.min(src.length, got + piece);
  const a = performance.now();
  // As useMarkdownModel (and useHeldWord) do: never less than the last piece showed.
  if (THINKING) held = holdWord(src.slice(0, got), held);
  else model = lexMarkdown(holdPartial(src.slice(0, got), model.text), model);
  lexes.push({ t: a - t0, got, ms: performance.now() - a });
  arrive(pacer, total(), now);
  if (got < src.length) setTimeout(deliver, MS);
  else {
    // The block ends: lexed whole once more (no held table line), and the rest shows at once.
    if (THINKING) held = src;
    else model = lexMarkdown(src, model);
    finish(pacer, total(), performance.now());
    ended = performance.now();
  }
}

function frame(now: number) {
  const a = performance.now();
  advance(pacer, now);
  cut = settled(pacer, now) ? null : cutNow(pacer, total(), now);
  flushSync(draw);
  // The chat follows the end, as ChatView's observer does; reading scrollHeight lays the page out in this frame.
  scroller.scrollTop = scroller.scrollHeight;
  frames.push({ t: a - t0, got, ms: performance.now() - a });
  maxWords = Math.max(maxWords, document.querySelectorAll(".chat-word-in").length);
  if (ended && !cut && now - ended > 400) return report();
  requestAnimationFrame(frame);
}

function report() {
  const md = document.querySelector(THINKING ? ".chat-think-body" : ".chat-md");
  const lastQuarter = frames.filter((f) => f.got >= src.length * 0.75);
  (window as unknown as { __result: unknown }).__result = {
    chars: src.length,
    lang: ZH ? "zh" : "en",
    kind: THINKING ? "thinking" : "reply",
    pieces: PIECES,
    pieceMs: MS,
    streamMs: Math.round(ended - t0),
    frames: stats(frames.map((f) => f.ms)),
    framesLastQuarter: stats(lastQuarter.map((f) => f.ms)),
    lexPerPiece: stats(lexes.map((l) => l.ms)),
    lexLastQuarter: stats(lexes.filter((l) => l.got >= src.length * 0.75).map((l) => l.ms)),
    maxFadingWords: maxWords,
    framesCounted: frames.length,
    shownAtEnd: md?.textContent?.length ?? 0,
    userAgent: navigator.userAgent,
  };
  (window as unknown as { __done: boolean }).__done = true;
}

draw();
setTimeout(() => {
  deliver();
  requestAnimationFrame(frame);
}, 300);
