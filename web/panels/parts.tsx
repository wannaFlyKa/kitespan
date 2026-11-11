// The side panel's shared parts: the reads that fill its cards, the download probe and button state, the Claude Code
// facts that Environment and Settings both show, and the one-line path of a file.
import { useCallback, useEffect, useRef, useState } from "react";
import { CLAUDE_MINIMUM_WORDS, type ClaudeBelow } from "../../shared/protocol";
import { act, useStore } from "../state/store";
import { CLAUDE_BINARY } from "../state/catalog";
import type { Chat } from "../state/types";
import { download, probe, type ProbeState } from "./download";
import { baseName, dirName } from "./format";
import { breakable } from "../ui/breakable";

/**
 * The cards' reads (DESIGN.md 6.7): Context and Connectors are read (`get`, which changes nothing and never starts a
 * sleeping chat) when the panel opens, after each turn, after a model switch, when the chat's Claude Code starts or
 * stops, and after the socket comes back. `enabled`: U4, where both halves of the split are side panel views, one reads.
 */
export function usePanelReads(chat: Chat, enabled = true) {
  const open = useStore((s) => s.net === "open");
  const turnOpen = chat.turn !== null;
  const asleep = chat.serverState === "sleeping";
  const model = chat.liveModel ?? chat.model;
  useEffect(() => {
    if (!open || !enabled) return;
    void act.load(chat.id, "context");
    void act.load(chat.id, "connectors");
  }, [chat.id, open, turnOpen, asleep, model, enabled]);
}

/** Read the connectors again a moment after a Reconnect, so the row shows the new status. */
export function reloadConnectorsSoon(chatId: string, ms = 1200) {
  setTimeout(() => void act.load(chatId, "connectors"), ms);
}

/** The existence probe of a download route (panels/download.ts), again whenever the URL changes. */
export function useProbe(url: string, what: "file" | "upload"): ProbeState {
  const [state, setState] = useState<ProbeState>({ phase: "probing" });
  useEffect(() => {
    let live = true;
    setState({ phase: "probing" });
    void probe(url, what).then((r) => {
      if (live) setState({ phase: "done", ...r });
    });
    return () => {
      live = false;
    };
  }, [url, what]);
  return state;
}

/** A Download button's press (the existence probe first, then the browser's download) and the line it shows when that fails. */
export function useDownload(url: string, what: "file" | "upload"): { press: () => void; busy: boolean; line: string | null } {
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const press = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setLine(null);
    void download(url, what).then((r) => {
      if (!live.current) return;
      setBusy(false);
      setLine(r.ok ? null : r.line);
    });
  }, [url, what, busy]);
  return { press, busy, line };
}

export interface ClaudeFacts {
  /** The binary pin passed (4.7); null until the server said. */
  ok: boolean | null;
  path: string | null;
  realpath: string | null;
  version: string | null;
  /** The drift line (4.10), or null. */
  drift: string | null;
  /** Below kitespan's minimum Claude Code version (rows 118, 119), or null. */
  belowMinimum: ClaudeBelow | null;
  sdk: string;
}

/**
 * A version as the label "Version" shows it: `claude --version` prints "2.1.312 (Claude Code)", and the CLI's own name
 * after the number repeats the row's label, so it goes.
 */
export function claudeVersion(raw: string | null | undefined): string | null {
  const v = raw?.replace(/\s*\(Claude Code\)\s*$/i, "").trim();
  return v || null;
}

/** The claude on PATH as the server reports it (/api/settings, `welcome`), with the version the chat's Claude Code reported. */
export function useClaudeFacts(chat?: Chat): ClaudeFacts {
  const host = useStore((s) => s.host?.claude);
  const welcome = useStore((s) => s.server.claude);
  return {
    ok: host?.ok ?? welcome?.ok ?? null,
    path: host?.path ?? null,
    realpath: host?.realpath ?? null,
    version: claudeVersion(chat?.version ?? host?.version ?? welcome?.version),
    // The settings read probes again at each page load, so after `claude update` its answer (no line) wins over the
    // welcome's, which holds the server's last probe.
    drift: (host ? host.drift : welcome?.drift) ?? null,
    belowMinimum: (host ? host.belowMinimum : welcome?.belowMinimum) ?? null,
    sdk: CLAUDE_BINARY.sdk,
  };
}

/**
 * The minimum version's line (rows 118, 119; shared/protocol.ts has the words): for a stock build the command as a
 * code span that one tap or click selects whole, for a company's own build the company's way, with no command.
 */
export function MinimumWords({ below }: { below: ClaudeBelow }) {
  return (
    <>
      {CLAUDE_MINIMUM_WORDS.lead(below)}{" "}
      {below.stock ? (
        <>
          Run <code className="select-all">{CLAUDE_MINIMUM_WORDS.command}</code>.
        </>
      ) : (
        CLAUDE_MINIMUM_WORDS.company
      )}
    </>
  );
}

/**
 * A path on one line (D51): its folder part dimmed before the name. In a narrow row the folder part gives way first,
 * so the name stays readable: it is cut at its start, so the slash before the name stays ("...http/retry.ts"), and
 * it goes whole to a line under the name when not even a short cut fits (panels.css). A name wider than the row wraps
 * at its own punctuation first (breakable, T-31), so it is never cut. The whole path is the title. The folder part
 * sits in a bdi, so its cut from the start (right to left) keeps its own left-to-right order.
 */
export function PathLine({ path, className = "" }: { path: string; className?: string }) {
  const dir = dirName(path);
  return (
    <span className={`side-pl ${className}`.trim()} title={path}>
      {dir ? (
        <span className="side-pl-dir">
          <bdi>{dir}</bdi>
        </span>
      ) : null}
      <span className="side-pl-name">{breakable(baseName(path))}</span>
    </span>
  );
}
