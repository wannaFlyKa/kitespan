// U1 (DESIGN-U1 3 and 9): git's two outputs that the changes code reads, parsed with no git and no disk, so a test can
// feed them as they are.
//
// - The summary: `diff-tree -r -M -z --raw --numstat --relative <start> <end>`. With -z, git prints every raw record
//   first (`:<old mode> <new mode> <old id> <new id> <status>` NUL, then the path NUL, or for a rename or a copy the old
//   path NUL and the new path NUL), then every numstat record (`<added>TAB<removed>TAB<path>` NUL, or for a rename
//   `<added>TAB<removed>TAB` NUL, the old path NUL and the new path NUL). A binary file's counts are `-` and `-`.
// - One file's patch: `diff-tree -p -M -U3`, a unified diff. Its hunks are read by their line counts, so a line of the
//   file that looks like a header (`+diff --git`, `-@@`) is never taken for one.

import type { DiffHunk } from "../../shared/changes";

/** One record of the summary: git's status letter, the path (the new one for a rename) and its counts. */
export interface RawChange {
  /** git's letter: M, A, D, R, C, T (a type change), U or X; a rename's or a copy's score is left off. */
  status: string;
  path: string;
  /** A rename's or a copy's old path. */
  from?: string;
  oldMode: string;
  newMode: string;
  oldId: string;
  newId: string;
  /** null: binary (`-`), or no numstat record. */
  added: number | null;
  removed: number | null;
}

const RAW_HEAD = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{4,64}) ([0-9a-f]{4,64}) ([A-Z])([0-9]{0,3})$/;
const NUMSTAT = /^(-|[0-9]+)\t(-|[0-9]+)\t([\s\S]*)$/;

/** The summary's records, in git's order (path order). Records that do not read are left out. */
export function parseRawNumstat(out: string): RawChange[] {
  const tokens = out.split("\0");
  const raw: RawChange[] = [];
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "") {
      i++;
      continue;
    }
    const head = RAW_HEAD.exec(t);
    if (head) {
      const status = head[5]!;
      const two = status === "R" || status === "C";
      const a = tokens[i + 1];
      const b = two ? tokens[i + 2] : undefined;
      i += two ? 3 : 2;
      if (a === undefined || (two && b === undefined)) break;
      raw.push({
        status,
        path: two ? b! : a,
        ...(two ? { from: a } : {}),
        oldMode: head[1]!,
        newMode: head[2]!,
        oldId: head[3]!,
        newId: head[4]!,
        added: null,
        removed: null,
      });
      continue;
    }
    const num = NUMSTAT.exec(t);
    if (!num) {
      i++;
      continue;
    }
    const added = num[1] === "-" ? null : Number(num[1]);
    const removed = num[2] === "-" ? null : Number(num[2]);
    if (num[3] === "") {
      // A rename: the old path and the new path follow.
      const to = tokens[i + 2];
      i += 3;
      if (to !== undefined) counts.set(to, { added, removed });
    } else {
      counts.set(num[3]!, { added, removed });
      i++;
    }
  }
  for (const r of raw) {
    const c = counts.get(r.path);
    if (c) {
      r.added = c.added;
      r.removed = c.removed;
    }
  }
  return raw;
}

/** What one file's patch says, within the caps. */
export interface ParsedPatch {
  binary: boolean;
  hunks: DiffHunk[];
  /** Past `maxLines`: how many lines are kept and how many more there were. */
  cut?: { shown: number; more: number };
}

export interface PatchCaps {
  /** Lines kept over every hunk. */
  maxLines: number;
  /** Characters kept of one line (its sign included); a longer one ends with an ellipsis. */
  lineChars: number;
  /** Characters kept of a hunk's function line. */
  contextChars?: number;
  /**
   * Keep only the hunks of this file's own section (`diff --git a/... b/<path>`, or its rename's old path): the rest of
   * a diff of several files is read past. With no `diff --git` line (Claude's own edits' hunks), every hunk is kept.
   */
  only?: { path: string; from?: string };
}

const C_ESCAPES: Readonly<Record<string, string>> = { "\x07": "\\a", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\v": "\\v", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };

/** git's C quoting of a path in a header (quote_c_style, with core.quotePath off): the name as git prints it. */
export function gitQuoted(name: string): string {
  let out = "";
  let quoted = false;
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    const esc = C_ESCAPES[ch];
    if (esc !== undefined || c < 0x20 || c === 0x7f) quoted = true;
    out += esc ?? (c < 0x20 || c === 0x7f ? `\\${c.toString(8).padStart(3, "0")}` : ch);
  }
  return quoted ? `"${out}"` : out;
}

/** The `diff --git` header lines of a file's own sections: its change (or its rename from `from`), and `from`'s own. */
function headersOf(path: string, from?: string): Set<string> {
  const line = (a: string, b: string) => `diff --git ${gitQuoted(`a/${a}`)} ${gitQuoted(`b/${b}`)}`;
  return new Set([line(path, path), ...(from && from !== path ? [line(from, path), line(from, from)] : [])]);
}

const HUNK_HEAD = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@ ?(.*)$/;

function cutLine(line: string, max: number): string {
  if (line.length <= max) return line;
  let end = max - 1;
  // Never between the two halves of a surrogate pair.
  const c = line.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${line.slice(0, end)}…`;
}

/**
 * The hunks of a unified diff (one file's, or several files' in a row), each line with its sign first and `\` for
 * git's "No newline at end of file". A hunk is read by its own counts: its lines end when both sides are full, and the
 * `\` lines that follow are its own. `binary`: git's "Binary files ... differ" line came.
 */
export function parsePatch(text: string, caps: PatchCaps): ParsedPatch {
  const lines = text.split("\n");
  // A trailing newline leaves one empty piece.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const hunks: DiffHunk[] = [];
  let binary = false;
  let shown = 0;
  let more = 0;
  let i = 0;
  const own = caps.only ? headersOf(caps.only.path, caps.only.from) : null;
  /** Inside a section that is kept (a text with no section header keeps every hunk). */
  let keepSection = true;
  while (i < lines.length) {
    const line = lines[i]!;
    const head = HUNK_HEAD.exec(line);
    if (!head) {
      if (own && line.startsWith("diff --git ")) keepSection = own.has(line);
      else if (!keepSection) {
        // another file's header lines
      } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) binary = true;
      else if (line.startsWith("GIT binary patch")) binary = true;
      i++;
      continue;
    }
    const oldStart = Number(head[1]);
    const oldLines = head[2] === undefined ? 1 : Number(head[2]);
    const newStart = Number(head[3]);
    const newLines = head[4] === undefined ? 1 : Number(head[4]);
    const context = cutLine(head[5] ?? "", caps.contextChars ?? 200);
    const hunk: DiffHunk = { oldStart, oldLines, newStart, newLines, context, lines: [] };
    let o = oldLines;
    let n = newLines;
    i++;
    const keep = (l: string) => {
      if (!keepSection) return;
      if (shown < caps.maxLines) {
        hunk.lines.push(cutLine(l, caps.lineChars));
        shown++;
      } else more++;
    };
    while (i < lines.length && (o > 0 || n > 0)) {
      const l = lines[i]!;
      const sign = l[0];
      if (sign === "+") n--;
      else if (sign === "-") o--;
      else if (sign === " " || l === "") {
        o--;
        n--;
      } else if (sign !== "\\") break;
      keep(l === "" ? " " : l);
      i++;
    }
    while (i < lines.length && lines[i]!.startsWith("\\")) {
      keep(lines[i]!);
      i++;
    }
    if (keepSection && (hunk.lines.length || shown < caps.maxLines)) hunks.push(hunk);
  }
  return { binary, hunks, ...(more > 0 ? { cut: { shown, more } } : {}) };
}

/** `ls-tree -l -z` of one path: the blob's size in bytes, or null when the tree has no blob there. */
export function lsTreeSize(out: string): number | null {
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const fields = (tab < 0 ? rec : rec.slice(0, tab)).trim().split(/\s+/);
    if (fields.length < 4 || fields[1] !== "blob") continue;
    const size = Number(fields[3]);
    if (Number.isFinite(size) && size >= 0) return size;
  }
  return null;
}
