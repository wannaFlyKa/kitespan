// Open on phone (DESIGN-T1 2.5; DESIGN 7.9 and 9.6; PT-9), /c/<chat>/phone: a code of the page the dialog was opened
// over, on the remote address, for another device's camera. A centred dialog on a tablet and a laptop; on the phone a
// sheet (its URL works there too, for a link shared to a phone), with Done at the top right. At each open it reads GET
// /api/settings again for the origins in force and the access adapter's link form (phoneLink.ts has the rules). The
// tile is black modules on white in every look and theme, an empty tile of the same size while the read is on its way
// (nothing moves when the code arrives), and it carries the exact text it encodes as data-text for the checks. Esc,
// Done, the scrim and Back close it to the page under it (5.1 rule 4), the one the code holds; the first focus is Done.
import { useEffect, useRef, useState } from "react";
import { closeTo, type EntryState, type Route } from "../router";
import type { Chat } from "../state/types";
import type { SettingsReply } from "../../server/http/api-types";
import { apiGet } from "../net/api";
import { COPY_FAILED, COPY_HINT, selectContents, writeClipboard } from "../ui/Copy";
import { breakable } from "../ui/breakable";
import { modulePx, type QrCode } from "../ui/qr";
import { Modal, useModalSheet } from "./Modal";
import { PHONE_WORDS, openerPath, phoneState, type PhoneState } from "./phoneLink";
import "../styles/phone.css";

/** How long Copy link says Copied, and Copy failed with its hint. */
const COPIED_MS = 2_000;
const FAILED_MS = 6_000;

/** The settings read: the page's own GET, or the tests' stand-in. */
type Read = () => Promise<Pick<SettingsReply, "access">>;
const readSettings: Read = () => apiGet<SettingsReply>("/api/settings");

export function OpenOnPhone({ chat, route, read = readSettings }: { chat: Chat; route: Route; read?: Read }) {
  // The opener as it was when the dialog opened: a reload keeps the entry's `from` (router.ts), so the code does too.
  const [path] = useState(() => openerPath(chat.id, route, typeof history === "undefined" ? undefined : (history.state as EntryState | null)?.from));
  const [state, setState] = useState<PhoneState>({ kind: "reading" });
  const [asked, setAsked] = useState(0);
  const sheet = useModalSheet();
  useEffect(() => {
    let live = true;
    setState({ kind: "reading" });
    read().then(
      (reply) => live && setState(phoneState(reply, typeof location === "undefined" ? null : location.origin, path)),
      () => live && setState({ kind: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [path, asked, read]);
  const close = () => closeTo(path);
  // The sheet form of Modal whose top-right word, Done here, takes the first focus (cancelFirst); a dialog marks its Done.
  return (
    <Modal title={PHONE_WORDS.title} testId="dialog-phone" onClose={close} confirm cancelFirst closeWord="Done" className="oop">
      <PhoneBody state={state} sheet={sheet} onClose={close} onRetry={() => setAsked((n) => n + 1)} />
    </Modal>
  );
}

/** The tile: the code at a whole number of pixels a module, or while it reads an empty tile of the same size. */
export function PhoneTile({ code, text }: { code: QrCode | null; text: string | null }) {
  if (!code || text === null) return <div className="oop-tile" aria-hidden="true" data-testid="phone-code-wait" />;
  const px = modulePx(code.size) * code.side;
  return (
    <div className="oop-tile" role="img" aria-label={PHONE_WORDS.tile} data-testid="phone-code" data-text={text} data-version={code.version}>
      <svg viewBox={`0 0 ${code.side} ${code.side}`} width={px} height={px} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
        <path d={code.path} />
      </svg>
    </div>
  );
}

/**
 * The dialog's body for each state (exported for the tests). On the sheet, Done is at the top right only. Every state
 * draws the same slots in the same order (the line or the tile, the link, the hint, one row of actions, the status), so
 * Done is one node from the read to the code and keeps the first focus that the dialog gave it.
 */
export function PhoneBody({ state, sheet, onClose, onRetry }: { state: PhoneState; sheet: boolean; onClose: () => void; onRetry: () => void }) {
  const link = state.kind === "code" || state.kind === "long" ? state.link : null;
  const copy = useLinkCopy(link);
  const done = sheet ? null : (
    <button type="button" className="btn" data-autofocus onClick={onClose} data-testid="phone-done">
      Done
    </button>
  );
  const top =
    state.kind === "none" || state.kind === "failed" || state.kind === "long" ? (
      <p className="oop-line" role={state.kind === "failed" ? "alert" : undefined} data-testid="phone-line">
        {state.kind === "none" ? PHONE_WORDS.none : state.kind === "failed" ? PHONE_WORDS.failed : PHONE_WORDS.long}
      </p>
    ) : (
      <PhoneTile code={state.kind === "code" ? state.code : null} text={state.kind === "code" ? state.text : null} />
    );
  const second =
    link !== null ? (
      <button type="button" className="btn oop-copy" onClick={copy.run} data-testid="phone-copy" aria-label={copy.word}>
        {/* Every word in the same cell, the others hidden, so the button keeps the width of its longest. */}
        {[PHONE_WORDS.copy, PHONE_WORDS.copied, COPY_FAILED].map((w) => (
          <span key={w} aria-hidden="true" data-on={w === copy.word || undefined}>
            {w}
          </span>
        ))}
      </button>
    ) : state.kind === "failed" ? (
      <button type="button" className="btn" onClick={onRetry} data-testid="phone-retry">
        {PHONE_WORDS.retry}
      </button>
    ) : null;
  return (
    <>
      {top}
      {link !== null ? (
        <p className="oop-link" dir="ltr" ref={copy.box} data-testid="phone-link">
          {breakable(link)}
        </p>
      ) : null}
      {copy.said === "failed" ? (
        <p className="oop-hint" role="alert">
          {COPY_HINT}
        </p>
      ) : null}
      {done || second ? (
        <div className="dialog-actions">
          {done}
          {second}
        </div>
      ) : null}
      {link !== null ? (
        <span className="visually-hidden" role="status">
          {copy.said === "copied" ? PHONE_WORDS.copied : ""}
        </span>
      ) : null}
    </>
  );
}

/**
 * Copy link: it writes the link (selectable page text, in mono; it wraps after its slashes first, T-31) inside the tap,
 * says Copied, or on a refusal selects the link and says Copy failed with its hint.
 */
function useLinkCopy(link: string | null) {
  const box = useRef<HTMLParagraphElement>(null);
  const [said, setSaid] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const run = () => {
    if (link === null) return;
    void writeClipboard(link).then((ok) => {
      if (timer.current) clearTimeout(timer.current);
      setSaid(ok ? "copied" : "failed");
      if (!ok) selectContents(() => box.current);
      timer.current = setTimeout(() => setSaid("idle"), ok ? COPIED_MS : FAILED_MS);
    });
  };
  const word = said === "copied" ? PHONE_WORDS.copied : said === "failed" ? COPY_FAILED : PHONE_WORDS.copy;
  return { box, said, run, word };
}
