// Route to screen. Every route name in shared/route.ts has exactly one screen here. The chat a route names is the one
// the store attaches (act.open: attach and detach only read), and no screen draws until the first chat list has come,
// so a link never shows its "not here" line (5.4), and no list says it is empty, before the list is known (5.1 rule
// 5). When the server has not answered by the dial deadline, the page shows only the connection line meanwhile.
import { useEffect, useState } from "react";
import { useRoute, type Route } from "./router";
import { act, useStore } from "./state/store";
import { useViewport } from "./layout/size";
import { installComposition } from "./composer/composition";
import { useKeyboardRelease } from "./composer/keyboard";
import { ChatScreen } from "./chat/ChatScreen";
import { Home, NewChat } from "./screens/Home";
import { ChatList } from "./screens/ChatList";
import { ProjectScreen, SessionPreview } from "./screens/ProjectScreen";
import { EnvironmentScreen } from "./screens/EnvironmentScreen";
import { Settings } from "./screens/Settings";
import { BrowserScreen } from "./browser/BrowserScreen";
import { startForDots } from "./browser/store";
import { FileDownload } from "./screens/FileDownload";
import { Uploads, useBesideChat } from "./screens/Uploads";
import { SearchPage } from "./search/SearchPage";
import { BackgroundScreen } from "./screens/BackgroundScreen";
import { Toasts } from "./ui/Toasts";
import { applyLook } from "./ui/look";
import { hasFiles } from "./ui/files";
import { useGlobalShortcuts } from "./ui/shortcuts";
import { RECONNECTING } from "./screens/common";
import type { AppSettings } from "./state/types";
import { WIRE } from "../shared/protocol";

const CHAT_ROUTES = new Set([
  "chat", "message", "tool", "agent", "workflow", "thinking", "permission", "question", "elicitation", "dialog", "plan",
  "send", "bash", "slashMenu", "slash", "add", "model", "effort", "mode", "stop", "rename", "archive", "delete", "terminal",
  // v0.6 touch (DESIGN 7.9): Open on phone, a dialog over the chat.
  "phone",
  "details", "environment", "context", "connectors", "outputs",
  // The Terminal pane (D38) is part of the chat screen at every size, so opening or closing it keeps the chat mounted.
  "shell",
  // v0.3 search (9.3): the chat's search pane is a side panel view, and the @ picker rises from the composer.
  "chatSearch", "mention",
  // R124 (row 124): the side chat takes the side panel's place (a sheet over the chat on the phone); R130: at one
  // exchange too.
  "sideChat", "sideExchange",
  // R127: Trust this folder's confirm, over the chat.
  "trust",
  // U1: a turn's changes and one file's diff, in the side panel's place (on the phone the chat at the turn's card).
  "changesTurn", "changesFile",
  // Iteration 7 (DESIGN-B1 4.1): the Browser beside the chat, the side panel's seventh kind (the phone's page over it).
  "chatBrowser", "chatBrowserTab",
]);

function Screen({ route }: { route: Route }) {
  // The uploads list and a file's page beside the chat are the chat screen (screens/Uploads.tsx useBesideChat): one
  // element type here at every such path, so opening or closing the Files pane never remounts the chat.
  const beside = useBesideChat(route);
  if (CHAT_ROUTES.has(route.name) || beside) return <ChatScreen route={route} />;
  switch (route.name) {
    case "home":
      return <Home route={route} />;
    case "new":
      return <NewChat route={route} />;
    case "chats":
      return <ChatList route={route} />;
    case "project":
    case "projectRename":
    case "projectRemove":
      return <ProjectScreen route={route} />;
    case "session":
      return <SessionPreview route={route} />;
    case "projectEnvironment":
      return <EnvironmentScreen route={route} />;
    case "settings":
    case "settingsSection":
    case "setting":
    case "settingsDevice":
    case "restart":
      return <Settings route={route} />;
    case "files":
      return <FileDownload route={route} />;
    case "uploads":
      return <Uploads route={route} />;
    case "search":
      return <SearchPage route={route} />;
    // R131: a background session's read-only view and its Stop confirm: a page over the chat at every size (the chat is
    // attached by its id, so the session's state is the chat's events), or the chat with 5.4's line.
    case "background":
    case "backgroundStop":
      return <BackgroundScreen route={route} />;
    case "browser":
    case "browserTab":
      return <BrowserScreen route={route} />;
  }
  return <Home route={route} notice="That link could not be read." />;
}

// Settings > Appearance > Look and Theme on the root element (data-look and data-theme): ui/look.ts.
export { applyLook } from "./ui/look";

/** Settings > Appearance on the root element: the text size (--text-scale) and Reduce motion (data-motion). */
export function applyAppearance(settings: Pick<AppSettings, "textSize" | "reduceMotion">, el: HTMLElement = document.documentElement) {
  if (settings.textSize === 1) el.style.removeProperty("--text-scale");
  else el.style.setProperty("--text-scale", String(settings.textSize));
  if (settings.reduceMotion === "on") el.dataset.motion = "reduce";
  else delete el.dataset.motion;
}

/**
 * What the page draws (5.1 rule 5): the screens once the first chat list has come ("app"); before it nothing
 * ("none"), and after the dial deadline only the connection line ("wait"). An id is judged only against the server's
 * list, never against the empty one from before its first answer.
 */
export function bootView(ready: boolean, late: boolean): "app" | "wait" | "none" {
  return ready ? "app" : late ? "wait" : "none";
}

/** The page while the server has not answered: the connection line only (the chat list's foot says the same, M4). */
export function BootWait() {
  return (
    <div className="boot-wait" role="status" data-testid="boot-wait">
      {RECONNECTING}
    </div>
  );
}

function useBootView(): "app" | "wait" | "none" {
  const ready = useStore((s) => s.ready);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setLate(true), WIRE.dialDeadlineMs);
    return () => clearTimeout(t);
  }, [ready]);
  return bootView(ready, late);
}

export function App() {
  const route = useRoute();
  const view = useBootView();
  const chatId = route.params.chat ?? null;
  useEffect(() => act.open(chatId), [chatId]);
  const look = useStore((s) => s.settings.look);
  const theme = useStore((s) => s.settings.theme);
  const textSize = useStore((s) => s.settings.textSize);
  const reduceMotion = useStore((s) => s.settings.reduceMotion);
  const vp = useViewport();
  // Cmd or Ctrl and the slash key, and Cmd or Ctrl+Shift and a square bracket (DESIGN.md 6.11): ui/shortcuts.ts.
  useGlobalShortcuts(route);
  // DESIGN.md 7.5 and 7.8 on touch: one tracker of the input method's marked text for every field's Return
  // (composer/composition.ts), and one release of the field when the on-screen keyboard settles closed
  // (composer/keyboard.ts).
  useEffect(() => installComposition(), []);
  useKeyboardRelease(vp.touch);
  useEffect(() => {
    applyLook({ look, theme });
  }, [look, theme]);
  useEffect(() => applyAppearance({ textSize, reduceMotion }), [textSize, reduceMotion]);
  // A file dropped where no drop zone takes it (the sidebar, the title bar) would make the browser open the file and
  // leave the app. The zones (the chat, the new-chat form) take their drops before the window sees them.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer) || e.defaultPrevented) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "none";
    };
    const dropped = (e: DragEvent) => {
      if (hasFiles(e.dataTransfer)) e.preventDefault();
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", dropped);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", dropped);
    };
  }, []);
  useEffect(() => {
    document.body.classList.toggle("touch", vp.touch);
    document.body.dataset.size = vp.size;
  }, [vp.touch, vp.size]);
  // A device that opened the Browser before keeps its socket, for the needs-you dot on the ways in (browser/store.ts).
  useEffect(() => {
    if (view === "app") startForDots();
  }, [view]);
  if (view === "none") return null;
  if (view === "wait") return <BootWait />;
  return (
    <>
      <Screen route={route} />
      <Toasts route={route} />
    </>
  );
}
