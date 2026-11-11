// Two input rules of the Terminal pane (D38), pure and with no import, so the lazy xterm chunk (xterm.ts) holds them
// and nothing else of the app: Ctrl+backtick is the pane's toggle (DESIGN.md 6.11, Desktop's "Toggle terminal pane";
// Shell.tsx binds it, route.ts says where it goes), and a paste loses its controls before the terminal reads it. U4:
// Desktop's Close focused pane, which the terminal passes on to the page on macOS.

/** Ctrl+backtick, with no Cmd, Alt or Shift: the key under Esc on most layouts, or the key that types a backtick. */
export function isTerminalToggle(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  return e.code === "Backquote" || e.key === "`";
}

/** The page runs on macOS (or iOS with a hardware keyboard): Cmd is the shortcut key there (ui/shortcuts.ts IS_MAC). */
export const IS_MAC_KEYS = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * U4: Desktop's "Close focused pane", Cmd+backslash on macOS and Ctrl+backslash elsewhere, with no Shift or Alt: the
 * key that types a backslash, or the backslash key. It closes the half of the split side panel that holds the focus
 * (ui/shortcuts.ts). Off macOS the terminal keeps Ctrl+backslash, the shell's quit key.
 */
export function isCloseFocusedPane(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, mac: boolean): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (!(e.key === "\\" || e.code === "Backslash")) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Pasted text as the terminal may take it: the C0 controls but tab, line feed and carriage return, DEL, and the C1
 * controls go. A paste then never holds ESC, so it cannot hold its own bracketed-paste end marker (ESC [201~) and run
 * the lines after it, in the scripted shell or in a real one. The terminal brackets the clean text as a paste.
 */
export function cleanPaste(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
