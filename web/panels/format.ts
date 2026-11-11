// Small helpers for the side panel: display forms of the chat's data, the URLs of the panel's views, and the panel's
// view preferences (DESIGN.md 6.7: the fold state of Environment and Outputs and "Show more" live in local storage,
// not in the URL).
import { useSyncExternalStore } from "react";
import type { ConnectorInfo } from "../../shared/protocol";
import { href, type Route } from "../router";
import { halfBack, halfLink } from "../layout/split";
import type { Output } from "../state/types";

/** A path split after each slash, so a narrow column wraps it between names and not inside one. */
export function pathParts(path: string): string[] {
  return path.split(/(?<=\/)/);
}

/** "~/src/kitespan" gives { name: "kitespan", parent: "~/src" }, the Environment card's "<folder> · <parent>". */
export function folderParts(folder: string): { name: string; parent: string } {
  const trimmed = folder.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 0) return { name: trimmed || folder, parent: "" };
  return { name: trimmed.slice(cut + 1), parent: trimmed.slice(0, cut) };
}

export function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/** The folder part of a path, with its slash ("src/http/" for "src/http/retry.ts"), or "" at the top. */
export function dirName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut >= 0 ? path.slice(0, cut + 1) : "";
}

export function isNote(o: Output): boolean {
  return o.kind === "doc" || /\.(md|markdown)$/i.test(o.path);
}

/** A path relative to the chat's folder, joined to that folder ("~/src/kitespan" and "src/a.ts"). */
export function inFolder(folder: string | undefined, rel: string): string {
  if (!folder) return rel;
  return rel ? `${folder.replace(/\/+$/, "")}/${rel}` : folder;
}

/**
 * True when an output's path is inside the chat's folder. The chat keeps each output relative to that folder, so a
 * path that is still absolute (Plan mode's plan file, any file Claude writes elsewhere) or that climbs out with ".."
 * is outside it: the download routes never serve it, and no URL may hold it (5.1 rule 2).
 */
export function inChatFolder(rel: string): boolean {
  return !rel.startsWith("/") && !rel.startsWith("~") && !rel.split("/").includes("..");
}

/** The full path of an output, for Copy path: the folder joined to a path inside it, else the path itself. */
export function outputPath(folder: string | undefined, rel: string): string {
  return inChatFolder(rel) ? inFolder(folder, rel) : rel;
}

/** A relative path as the routes take it: no "./" in front, no slash at the end. */
export function cleanRel(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Token counts as Claude Code's /context prints them: 114k, 21.8k, 6.4k. */
export function kTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${trim(n / 1000)}k`;
  return String(n);
}
const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");

/**
 * The Connectors card's problem count (D51): nothing while every server is connected (or turned off, or still
 * connecting), else how many failed and how many need sign-in.
 */
export function connectorProblems(list: readonly Pick<ConnectorInfo, "status">[]): { failed: number; signIn: number } {
  return { failed: list.filter((c) => c.status === "failed").length, signIn: list.filter((c) => c.status === "needs-auth").length };
}

/** A server's status in the Connectors detail. */
export const STATUS_WORD: Record<ConnectorInfo["status"], string> = {
  connected: "Connected",
  failed: "Failed",
  "needs-auth": "Needs sign-in",
  pending: "Connecting...",
  disabled: "Disabled",
};

/** The transcript view (?view=) that every chat path carries, so the panel's links keep it. */
export function viewOf(route: Route): string | undefined {
  return typeof route.query.view === "string" ? route.query.view : undefined;
}

/**
 * The URL of a panel view for this chat, keeping the transcript view. U4: from a half of the split side panel, the
 * view goes into that half and the other half stays (layout/split.ts halfLink).
 */
export function viewUrl(name: string, chatId: string, route: Route, params: Record<string, string> = {}): string {
  return halfLink(route, href(name, { ...params, chat: chatId }, { view: viewOf(route) }));
}

/**
 * The URL of a view's back row ("< Context", "< Outputs"), keeping the transcript view. U4: from a half it goes back
 * in that half; when the other half shows the target's kind, the target alone (layout/split.ts halfBack).
 */
export function backUrl(name: string, chatId: string, route: Route): string {
  return halfBack(route, href(name, { chat: chatId }, { view: viewOf(route) }));
}

// View preferences, shared by every mounted panel and kept in local storage.
export interface SidePrefs {
  envOpen: boolean;
  outOpen: boolean;
  outMore: boolean;
}
const PREFS_KEY = "kitespan.side";
const PREFS_DEFAULT: SidePrefs = { envOpen: true, outOpen: true, outMore: false };
const prefListeners = new Set<() => void>();
let prefs: SidePrefs = readPrefs();

function readPrefs(): SidePrefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PREFS_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as Partial<SidePrefs>) : {};
    return {
      envOpen: typeof parsed.envOpen === "boolean" ? parsed.envOpen : PREFS_DEFAULT.envOpen,
      outOpen: typeof parsed.outOpen === "boolean" ? parsed.outOpen : PREFS_DEFAULT.outOpen,
      outMore: typeof parsed.outMore === "boolean" ? parsed.outMore : PREFS_DEFAULT.outMore,
    };
  } catch {
    return { ...PREFS_DEFAULT };
  }
}

/** A view preference: kept in local storage, never sent and never recorded. */
export function setSidePrefs(patch: Partial<SidePrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
  for (const l of prefListeners) l();
}

/** S1: one subscribe function for every hook, so React does not subscribe again after each render. */
function subscribePrefs(cb: () => void): () => void {
  prefListeners.add(cb);
  return () => prefListeners.delete(cb);
}
const prefsNow = () => prefs;

export function useSidePrefs(): SidePrefs {
  return useSyncExternalStore(subscribePrefs, prefsNow, prefsNow);
}
