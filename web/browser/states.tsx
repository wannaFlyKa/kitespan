// The browser's states (DESIGN-B1 4.13, F1, F23): they replace the whole pane. Off with nothing saved ("never started")
// and off with tabs saved ("stopped") read from the host's `saved`; a missing program and a configured path that fails
// its checks; starting (its words after 300 ms; after a crash, its own); the two port states, each saying where
// Claude's browser tools connect; crashed six times; stopping. Each title, one line and its actions; Start browser and
// Try again act only on their own press (POST /api/browser/start); Open Settings and Change the port open Settings >
// Browser.
import { useEffect, useState, type ReactNode } from "react";
import type { BrowserHostView, BrowserReply } from "../../shared/browser";
import { apiSend } from "../net/api";
import { href } from "../router";
import { Link } from "../ui/primitives";
import { IconGlobe, IconGlobeOff } from "../ui/icons";

export interface StateWords {
  title: string;
  line?: string;
  /** The actions, in order: start (Start browser, primary), retry (Try again), settings (Open Settings), port (Change the port). */
  actions: ("start" | "retry" | "settings" | "port")[];
  icon: "globe" | "off" | null;
  /** Words that show only after 300 ms (a start that is quick shows nothing). */
  late?: boolean;
}

/** The words of a host state that replaces the pane; null for `running`. */
export function hostWords(h: BrowserHostView): StateWords | null {
  const p = h.port;
  switch (h.state) {
    case "running":
      return null;
    case "off":
      return h.saved && h.saved > 0
        ? { title: "The browser is stopped", line: "Its tabs come back when it starts.", actions: ["start"], icon: "globe" }
        : { title: "The browser is off", line: "Start a browser that you and Claude share. It keeps your sign-ins.", actions: ["start"], icon: "globe" };
    case "missing":
      return h.reason === "bad_path"
        ? { title: "The configured browser cannot run here", line: "Settings > Browser shows the path that kitespan tried.", actions: ["retry", "settings"], icon: "off" }
        : { title: "No browser on this host", line: "kitespan needs Google Chrome or Chromium. Install one, then try again.", actions: ["retry"], icon: "off" };
    case "starting":
      return h.attempt && h.attempt > 0 ? { title: "The browser stopped. Starting it again…", actions: [], icon: null } : { title: "Starting the browser…", actions: [], icon: null, late: true };
    case "port_own":
      return {
        title: `Port ${p} is in use`,
        line: `Port ${p} is used by another program of yours. Claude's browser tools connect to that program, not to kitespan's browser.`,
        actions: ["retry", "port"],
        icon: "off",
      };
    case "port_other":
      return {
        title: `Port ${p} is held by another account`,
        line: `Port ${p} is held by another account on this machine. Claude's browser tools would connect to its program. Do not use them until the port is free, or change the port.`,
        actions: ["retry", "port"],
        icon: "off",
      };
    case "crashed":
      return { title: "The browser stopped", line: "It stopped six times in ten minutes. Its tabs come back when it starts.", actions: ["start"], icon: "off" };
    case "stopping":
      return { title: "Stopping the browser…", actions: [], icon: null };
  }
}

/** Start the browser (Start browser, Try again): inside the press only. */
export function startBrowser(): Promise<BrowserReply> {
  return apiSend<BrowserReply>("POST", "/api/browser/start", {});
}

export function HostState({ host, head }: { host: BrowserHostView; head?: ReactNode }) {
  const w = hostWords(host);
  const [late, setLate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    setLate(false);
    if (!w?.late) return;
    const t = setTimeout(() => setLate(true), 300);
    return () => clearTimeout(t);
  }, [w?.late, host.state]);
  useEffect(() => setBusy(false), [host.state]);
  if (!w) return null;
  const start = () => {
    setBusy(true);
    setLine(null);
    startBrowser().then(
      () => setBusy(false),
      (e: Error) => {
        setBusy(false);
        setLine(e.message);
      },
    );
  };
  const action = (a: StateWords["actions"][number]) =>
    a === "start" ? (
      <button key={a} type="button" className="btn primary" disabled={busy} onClick={start} data-testid="browser-start">
        Start browser
      </button>
    ) : a === "retry" ? (
      <button key={a} type="button" className="btn" disabled={busy} onClick={start} data-testid="browser-retry">
        Try again
      </button>
    ) : (
      <Link key={a} to={href("settingsSection", { section: "browser" })} className="btn">
        {a === "settings" ? "Open Settings" : "Change the port"}
      </Link>
    );
  const shown = !w.late || late;
  return (
    <section className="bp" aria-label="Browser" data-testid="browser-pane" data-state={host.state}>
      {head}
      <div className="bp-empty" data-testid="browser-state">
        {shown && w.icon ? <span className="bp-empty-icon">{w.icon === "globe" ? <IconGlobe size={28} /> : <IconGlobeOff size={28} />}</span> : null}
        {shown ? <h2 className="bp-empty-title" role={w.actions.length ? undefined : "status"}>{w.title}</h2> : null}
        {shown && w.line ? <p className="bp-empty-line">{w.line}</p> : null}
        {line ? (
          <p className="notice" role="status">
            {line}
          </p>
        ) : null}
        {w.actions.length ? <div className="bp-empty-actions">{w.actions.map(action)}</div> : null}
      </div>
    </section>
  );
}
