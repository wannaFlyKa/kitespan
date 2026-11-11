// A tool row's menu (DESIGN-T1 2.1): a long press on the row's head on touch, its "..." on touch, a right-click on a
// laptop. A row whose target is a file has the file menu (ui/fileMenu.ts); a Bash row copies its command and its
// output, a Grep or Glob row its pattern, a WebFetch row opens or copies its link, a WebSearch row copies its query, and
// an MCP row its output. Copy output writes the result as the page holds it, with no line numbers, signs or labels
// (DESIGN.md 7.10 rule 3). The page holds at most the first 6,000 characters of a result; a result the server cut
// carries `cut`, its whole length (T-26), and then the first line says so, the copy row says how much it copies, and
// "Download output" gets the whole text from the server. Rows with nothing to do but their tap (ToolSearch, a question
// or plan row) have no menu. Pure.
import { toolOutputPath } from "../../../shared/protocol";
import type { ToolItem } from "../../state/types";
import { mcpTool, targetOf } from "../fold";
import { fileMenu, type FileRow, type RowItem, type RowMenuSpec } from "../../ui/fileMenu";

/** The verb a row shows for each tool. A question or plan call has a row only when no card stands for it (fold.ts). */
export const VERB: Record<string, string> = { Read: "Read", Write: "Write", Edit: "Edit", MultiEdit: "Edit", NotebookEdit: "Edit", Grep: "Search", Glob: "Search", Bash: "Bash", WebFetch: "Fetch", WebSearch: "Web search", AskUserQuestion: "Question", ExitPlanMode: "Plan" };

/** The tools whose target is one file. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** A tool row as its menu reads it: `cut`, the whole result's length when the server cut it (T-26). */
export type MenuTool = ToolItem & { cut?: number };

/** The file a tool row names, whatever its status (an edit's diff path first); null when it names none. */
export function toolPath(item: ToolItem): string | null {
  if (!FILE_TOOLS.has(item.name)) return null;
  const path = (item.diff?.path ?? targetOf(item)).trim();
  return path || null;
}

/** The file a tool row offers to download: only when the call worked and its target is a file. */
export function fileTarget(item: ToolItem): string | null {
  return item.status === "ok" ? toolPath(item) : null;
}

const count = (n: number) => n.toLocaleString("en-US");

/** The cut line of a menu's first lines. */
export function cutLine(held: number, whole: number): string {
  return `Output cut at ${count(held)} of ${count(whole)} characters.`;
}

/** The output's rows: Copy output, or for a cut result the copy of what the page holds and the whole as a download. */
function outputRows(item: MenuTool, chatId: string): { rows: RowItem[]; note?: string } {
  const out = item.output ?? "";
  if (!out) return { rows: [] };
  const cut = typeof item.cut === "number" && item.cut > out.length ? item.cut : null;
  if (cut === null) return { rows: [{ id: "copy-output", label: "Copy output", act: { do: "copy", text: out } }] };
  return {
    note: cutLine(out.length, cut),
    rows: [
      { id: "copy-output", label: `Copy first ${count(out.length)} characters`, act: { do: "copy", text: out } },
      { id: "download-output", label: "Download output", act: { do: "save", url: toolOutputPath(chatId, item.id), what: "output" } },
    ],
  };
}

const httpLink = (s: string) => /^https?:\/\/\S+$/i.test(s);

export interface ToolMenuAt extends Pick<FileRow, "chatId" | "folder" | "open" | "attach"> {}

/** A tool row's menu, or null when the row has nothing to do but its tap. */
export function toolMenu(item: MenuTool, at: ToolMenuAt): RowMenuSpec | null {
  const path = toolPath(item);
  if (path) return { ...fileMenu({ ...at, place: "tool", path, acts: item.status === "ok", laptop: false }), kind: "file" };
  const target = targetOf(item);
  const { rows, note } = outputRows(item, at.chatId);
  const spec = (kind: string, title: string, head: string, first: RowItem[]): RowMenuSpec | null => {
    const all = [...first, ...rows];
    return all.length ? { kind, title, head, ...(note ? { note } : {}), groups: [all] } : null;
  };
  const mcp = mcpTool(item.name);
  if (mcp) return spec("mcp", mcp.tool, mcp.server, []);
  switch (item.name) {
    case "Bash": {
      const cmd = item.input || target;
      return spec("bash", "Bash", cmd, cmd ? [{ id: "copy-command", label: "Copy command", act: { do: "copy", text: cmd } }] : []);
    }
    case "Grep":
    case "Glob":
      return spec(item.name.toLowerCase(), VERB[item.name]!, target, target ? [{ id: "copy-pattern", label: "Copy pattern", act: { do: "copy", text: target } }] : []);
    case "WebFetch":
      return spec(
        "fetch",
        "Fetch",
        target,
        target ? [...(httpLink(target) ? [{ id: "open-link", label: "Open link", act: { do: "tab" as const, to: target } }] : []), { id: "copy-link", label: "Copy link", act: { do: "copy", text: target } }] : [],
      );
    case "WebSearch":
      return spec("websearch", "Web search", target, target ? [{ id: "copy-query", label: "Copy query", act: { do: "copy", text: target } }] : []);
    default:
      return null;
  }
}
