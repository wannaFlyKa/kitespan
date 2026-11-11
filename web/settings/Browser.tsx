// Settings > Browser (DESIGN-B1 4.14, D-3, S3, F1): after Notifications (/settings/browser).
//   - Browser: its state ("Running, Chrome <version>", "Starting", "Off", "Stopped", "Not found", or a port state's
//     line), with Start browser or Stop browser; Stop asks first (a ghost danger button).
//   - Browser program and Port: read-only, with where each came from. Only browser.json, which kitespan reads and never
//     writes, names them: a page that could name the program to run could run any program (D-3). browser.json's
//     problem line when it failed a check.
//   - Claude's browser tools: the owner's `claude mcp add` line for this port, in mono, with Copy (DESIGN 7.10). kitespan
//     never runs it and never changes Claude Code's configuration.
//   - Open chat links: this device's choice (local storage), the same as More > Open chat links here. Its words are
//     long, so where the section is narrow (the phone) it is Settings' choice menu, a sheet of rows on the phone, as
//     Settings' other long choices are; elsewhere a segmented control.
//   - Profile folder: read-only.
//   - Clear browsing data: it stops the browser, empties its whole profile (sign-ins included) and starts it again with
//     no tabs (S3), after a confirm that says so; nothing is cleared when the browser does not stop.
// GET /api/browser reads; each POST goes only on its own press, with the sender header (net/api.ts).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { BrowserHostView, BrowserReply } from "../../shared/browser";
import { ApiError, apiGet, apiSend } from "../net/api";
import { useBrowser } from "../browser/store";
import { CHAT_LINK_WORDS, chatLinks, onChatLinks, setChatLinks, type ChatLinks } from "../browser/nav";
import { hostWords } from "../browser/states";
import { Modal, useModalSheet } from "../dialogs/Modal";
import { Segmented } from "../ui/Segmented";
import { COPY_FAILED, writeClipboard } from "../ui/Copy";

export const BROWSER_SETTING_WORDS = {
  clearLine: "Sign-ins, cookies, history, site data and cache of the shared browser. Downloads stay.",
  clearAsk: "Clear browsing data?",
  clearRunning: "Every site signs out, for Claude too. The browser restarts with no tabs.",
  clearOff: "Every site signs out, for Claude too. Its saved tabs go.",
  clearing: "Clearing…",
  notStopped: "The browser did not stop, so nothing was cleared.",
  stopAsk: "Stop the browser?",
  stopLine: "Claude's browser tools fail until it starts again. Its tabs come back when it starts.",
  foot: "Set the browser program and the port in browser.json in kitespan's config folder.",
} as const;

/** The Browser row's value (DESIGN-B1 4.14): the state in a word, or a port state's whole line. */
export function browserRowValue(h: BrowserHostView | null): string {
  if (!h) return "…";
  switch (h.state) {
    case "running":
      return h.version ? `Running, Chrome ${h.version}` : "Running";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "off":
      return h.saved && h.saved > 0 ? "Stopped" : "Off";
    case "missing":
      return "Not found";
    case "crashed":
      return "Stopped";
    case "port_own":
    case "port_other":
      return hostWords(h)?.line ?? "";
  }
}

/** Settings' choice menu (screens/Settings.tsx ChoiceMenu), passed in by Settings, which imports this file. */
export type ChoiceMenuDraw = (m: { name: string; choices: { value: string; label: string }[]; value: string; labelId: string; testId: string; onPick: (v: string) => void }) => ReactNode;

function Row({ label, value, from, line, control, testId, mono }: { label: string; value?: ReactNode; from?: string; line?: ReactNode; control?: ReactNode | ((labelId: string) => ReactNode); testId: string; mono?: boolean }) {
  const id = useId();
  return (
    <li className="set-row" data-testid={testId}>
      <div className="set-row-main">
        <div className="set-row-text">
          <span className="set-label-line">
            <span className="set-label" id={id}>
              {label}
            </span>
          </span>
          {value !== undefined ? <span className={`set-help${mono ? " mono" : ""}`}>{value}</span> : null}
          {from ? <span className="set-help">{from}</span> : null}
          {line ? <span className="set-row-line">{line}</span> : null}
        </div>
        {control !== undefined ? <div className="set-control">{typeof control === "function" ? control(id) : control}</div> : null}
      </div>
    </li>
  );
}

export function BrowserSettings({ narrow = false, menu }: { narrow?: boolean; menu?: ChoiceMenuDraw }) {
  const live = useBrowser();
  const sheet = useModalSheet();
  const [reply, setReply] = useState<BrowserReply | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [ask, setAsk] = useState<"stop" | "clear" | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | "clear" | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [links, setLinks] = useState<ChatLinks>(chatLinks());
  const mcp = useRef<HTMLSpanElement>(null);
  useEffect(() => onChatLinks(() => setLinks(chatLinks())), []);
  useEffect(() => {
    let on = true;
    apiGet<BrowserReply>("/api/browser").then(
      (r) => on && setReply(r),
      (e: ApiError) => on && setFailed(e.message),
    );
    return () => {
      on = false;
    };
  }, []);
  // The live host state from the pane's socket, when this page has one; else the read's.
  const host = live.opened && live.host ? live.host : (reply?.host ?? null);
  const running = host?.state === "running" || host?.state === "starting";
  const send = (what: "start" | "stop" | "clear") => {
    setBusy(what);
    setLine(what === "clear" ? BROWSER_SETTING_WORDS.clearing : null);
    apiSend<BrowserReply>("POST", `/api/browser/${what}`, {}).then(
      (r) => {
        setReply(r);
        setBusy(null);
        setLine(null);
      },
      (e: ApiError) => {
        setBusy(null);
        setLine(e.status === 409 ? BROWSER_SETTING_WORDS.notStopped : e.message);
      },
    );
  };
  if (failed && !reply) return <p className="notice">{failed}</p>;
  const from = (f: "config" | "found" | "default" | null) => (f === "config" ? "From browser.json" : f === "found" ? "Found on this host" : f === "default" ? "The default" : "");
  return (
    <>
      <div className="set-block">
        <ul className="group set-group" data-testid="settings-browser">
          <Row
            label="Browser"
            testId="setting-browser-state"
            value={browserRowValue(host)}
            control={
              running ? (
                <button type="button" className="btn ghost danger" disabled={busy !== null} onClick={() => setAsk("stop")} data-testid="browser-stop">
                  Stop browser
                </button>
              ) : host && host.state !== "stopping" ? (
                <button type="button" className="btn primary" disabled={busy !== null} onClick={() => send("start")} data-testid="browser-start">
                  Start browser
                </button>
              ) : undefined
            }
          />
          <Row label="Browser program" testId="setting-browser-program" mono value={reply ? (reply.program.path ?? "Not found") : "…"} from={reply ? from(reply.program.from) || undefined : undefined} line={reply?.problem ?? undefined} />
          <Row label="Port" testId="setting-browser-port" value={reply ? String(reply.port.value) : "…"} from={reply ? from(reply.port.from) || undefined : undefined} />
          <Row
            label="Claude's browser tools"
            testId="setting-browser-mcp"
            value={
              reply ? (
                <span ref={mcp} className="mono bp-mcp">
                  {reply.mcp}
                </span>
              ) : (
                "…"
              )
            }
            line={copy === "failed" ? COPY_FAILED : undefined}
            control={
              reply ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    writeClipboard(reply.mcp).then((ok) => {
                      setCopy(ok ? "copied" : "failed");
                      if (!ok && mcp.current) {
                        const r = document.createRange();
                        r.selectNodeContents(mcp.current);
                        getSelection()?.removeAllRanges();
                        getSelection()?.addRange(r);
                      }
                    })
                  }
                  data-testid="browser-copy-mcp"
                >
                  {copy === "copied" ? "Copied" : "Copy"}
                </button>
              ) : undefined
            }
          />
          <Row
            label="Open chat links"
            testId="setting-browser-links"
            control={(labelId) => {
              const choices = (["ask", "pane", "tab"] as const).map((v) => ({ value: v, label: CHAT_LINK_WORDS[v] }));
              const pick = (v: ChatLinks) => {
                setChatLinks(v);
                setLinks(v);
              };
              return narrow && menu ? (
                menu({ name: "Open chat links", choices, value: links, labelId, testId: "browser-links", onPick: (v) => pick(v as ChatLinks) })
              ) : (
                <Segmented label="Open chat links" value={links} onChange={pick} options={choices} testId="browser-links" />
              );
            }}
          />
          <Row label="Profile folder" testId="setting-browser-profile" mono value={reply?.profile ?? "…"} />
          <Row
            label="Clear browsing data"
            testId="setting-browser-clear"
            value={BROWSER_SETTING_WORDS.clearLine}
            line={line ?? undefined}
            control={
              <button type="button" className="btn primary danger" disabled={busy !== null || !host} onClick={() => setAsk("clear")} data-testid="browser-clear">
                Clear browsing data
              </button>
            }
          />
        </ul>
        <p className="set-help set-foot-line">{BROWSER_SETTING_WORDS.foot}</p>
      </div>
      {ask === "stop" ? (
        <Modal title={BROWSER_SETTING_WORDS.stopAsk} testId="browser-stop-confirm" onClose={() => setAsk(null)} confirm>
          <p>{BROWSER_SETTING_WORDS.stopLine}</p>
          <div className="dialog-actions">
            {!sheet ? (
              <button type="button" className="btn" data-autofocus onClick={() => setAsk(null)}>
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              className="btn ghost danger"
              onClick={() => {
                setAsk(null);
                send("stop");
              }}
              data-testid="browser-stop-go"
            >
              Stop browser
            </button>
          </div>
        </Modal>
      ) : null}
      {ask === "clear" ? (
        <Modal title={BROWSER_SETTING_WORDS.clearAsk} testId="browser-clear-confirm" onClose={() => setAsk(null)} confirm>
          <p>{running ? BROWSER_SETTING_WORDS.clearRunning : BROWSER_SETTING_WORDS.clearOff}</p>
          <div className="dialog-actions">
            {!sheet ? (
              <button type="button" className="btn" data-autofocus onClick={() => setAsk(null)}>
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              className="btn primary danger"
              onClick={() => {
                setAsk(null);
                send("clear");
              }}
              data-testid="browser-clear-go"
            >
              Clear browsing data
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
