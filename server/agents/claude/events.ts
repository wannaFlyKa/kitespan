// SDK messages to neutral ChatEvents (DESIGN.md 4.2; V-sdk C15's table). One EventMapper per live chat keeps the
// little state the mapping needs: the main thread's API message id for stream keys, the text dedupe (D-LIVE-42), the
// tool names by id, the subagent tool-use id of each task, and whether a turn runs. historyEvents() maps a session's
// transcript (getSessionMessages) the same way, for a sleeping chat or a preview.
//
// Every text that reaches an event is plain text; nothing here renders. The caps of 4.3 are applied by capEvent().

import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  capEvent,
  capText,
  CONTROL_CHARS,
  FAST_MODE_STATES,
  LIMITS,
  TURN_INTERRUPTED,
  type ChatEvent,
  type ChatEventOf,
  type CommandInfo,
  type FastModeState,
  type PluginInfo,
  type TaskEvent,
  type TaskUsage,
  type WorkflowStep,
  type BgLaunch,
} from "../../../shared/protocol";
import { launchesIn } from "../../../shared/background";
import { refusedFolder } from "../../../shared/trust";
import { isProviderArn } from "../types";
import { parseBashRecord } from "./bash";

/**
 * Which whole assistant records repeat text the stream already drew (the spike's text-dedupe.ts, D-LIVE-42). The CLI
 * sends one assistant record PER content block (thinking, then text, same message id), so a record's content index
 * is not the stream's block index; counting text blocks per API message id is what matches them.
 */
export class TextDedupe {
  private streamed = new Map<string, number>();
  private recorded = new Map<string, number>();
  /** A text content_block_start in the stream of message `id`. */
  streamedText(id: string): void {
    this.streamed.set(id, (this.streamed.get(id) ?? 0) + 1);
  }
  /** A text block in a whole record of message `id`: null if the stream drew it, else a key for a new block. */
  recordText(id: string): string | null {
    const n = this.recorded.get(id) ?? 0;
    this.recorded.set(id, n + 1);
    return n < (this.streamed.get(id) ?? 0) ? null : `${id}:record-text-${n}`;
  }
}

/** Tools whose tool_use_result carries a subagent's hand-back report. */
const AGENT_TOOLS = new Set(["Agent", "Task"]);
/** The CLI's own hand-back row inside a subagent: never shown (D-LIVE-34). */
export const HIDDEN_TOOLS = new Set(["SubagentHandback"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOr = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
const task = (s: unknown): string => capText(typeof s === "string" ? s : "", LIMITS.taskText);
const taskOrNull = (s: unknown): string | null => (typeof s === "string" && s !== "" ? capText(s, LIMITS.taskText) : null);

/** ANSI colour and cursor sequences, which local command output carries. */
export function stripAnsi(s: string): string {
  // The character class holds ESC (0x1b) and the CSI final-byte range.
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

const LOCAL_TAG_RE = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g;

/** The local command outputs in `s`, one per `<local-command-stdout>` or `<local-command-stderr>` tag (V-sdk C11). */
export function localOutputs(s: string): { stream: "stdout" | "stderr"; text: string }[] {
  const out: { stream: "stdout" | "stderr"; text: string }[] = [];
  for (const m of s.matchAll(LOCAL_TAG_RE)) out.push({ stream: m[1] as "stdout" | "stderr", text: stripAnsi(m[2]!).replace(/\s+$/, "") });
  return out;
}

/** A tool_result block's content as text: strings joined, other blocks as `[type]`. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (isObj(c) && c.type === "text" && typeof c.text === "string" ? c.text : `[${isObj(c) ? String(c.type) : "?"}]`)).join("\n");
}

/**
 * R127: the `trust` key of a tool result whose whole text (before the cap of 4.3) holds Claude Code's refusal of a
 * background session in a folder that is not trusted (shared/trust.ts); none otherwise. The root is the registry's
 * (its own file reads), so it is null here. Only a shell tool's result (SHELL_TOOLS, as R131's launch lines): any other
 * text that quotes the line (an Agent or Task report, a fetched page, an MCP tool's answer) must not offer to trust
 * the folder it names; the subagent's own Bash rows still carry theirs.
 */
function trustOf(text: string, name: string | undefined): { trust?: { path: string; root: null } } {
  if (name === undefined || !SHELL_TOOLS.has(name)) return {};
  const path = refusedFolder(text);
  return path ? { trust: { path, root: null } } : {};
}

/**
 * R131: the tools whose result is a shell's own output, so a launch line in it is Claude Code's printout of `claude
 * --bg`: Bash (a call that runs now), BashOutput (a call that ran in the background) and PowerShell (Claude Code's
 * shell tool on Windows). Every other result is someone else's text that may quote the line (the agent-view docs'
 * own example is `backgrounded · 7c5dcf5d · flaky-test-fix`): an Agent or Task report, the text of WebFetch's small
 * model, a search, an MCP tool, a file read, a task's output (TaskOutput also returns a subagent's report).
 */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "BashOutput", "PowerShell"]);

/**
 * R131: the `background` key of a tool result whose whole text (before the cap of 4.3) holds Claude Code's launch lines
 * of background sessions (shared/background.ts); none otherwise. Only for a shell tool's result (`name`, the call's
 * tool; a result whose call was not seen is none): any other text that quotes a line started nothing here. A
 * subagent's own Bash rows still carry theirs.
 */
function backgroundOf(text: string, name: string | undefined): { background?: BgLaunch[] } {
  if (name === undefined || !SHELL_TOOLS.has(name)) return {};
  const launches = launchesIn(text);
  return launches.length ? { background: launches } : {};
}

/** U1: the file tools whose result carries their own patch (sdk-tools.d.ts FileEditOutput, FileWriteOutput). */
const PATCH_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write"]);
/** U1: the JSON of one `edit_patch` event's hunks at most (the turn keeps at most 256 KiB of them in all). */
export const EDIT_PATCH_BYTES = 128 * 1024;
/** U1: one line of a patch at most (the diff view's own cap). */
const PATCH_LINE = 2_000;

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * U1 (DESIGN-U1 4.4): a file tool's own patch from its result's `tool_use_result`, for a turn that has no git marks:
 * the file as the tool named it, whether a Write created it, the lines its hunks add and remove, and the hunks (each
 * line cut at 2,000 characters, the hunks at EDIT_PATCH_BYTES of JSON, `cut` when some went). A Write that created a
 * file with no hunks gives one hunk of its whole content. An edit held for review (`staged`) changed nothing: none.
 */
export function editPatchOf(name: string | undefined, id: string, side: unknown, parent: string | null): ChatEventOf<"edit_patch"> | null {
  if (name === undefined || !PATCH_TOOLS.has(name) || !isObj(side) || side.staged === true) return null;
  const path = side.filePath;
  if (typeof path !== "string" || path === "" || path.length > 4096) return null;
  const create = name === "Write" && side.type === "create";
  const raw = Array.isArray(side.structuredPatch) ? side.structuredPatch : [];
  let hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] = [];
  for (const h of raw) {
    if (!isObj(h) || !Array.isArray(h.lines)) continue;
    const [oldStart, oldLines, newStart, newLines] = [count(h.oldStart), count(h.oldLines), count(h.newStart), count(h.newLines)];
    if (oldStart === null || oldLines === null || newStart === null || newLines === null) continue;
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: h.lines.filter((l): l is string => typeof l === "string") });
  }
  if (!hunks.length && create && typeof side.content === "string" && side.content !== "") {
    const lines = side.content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
  }
  let added = 0;
  let removed = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  let bytes = 2;
  let cut = false;
  const kept: typeof hunks = [];
  for (const h of hunks) {
    const lines: string[] = [];
    let size = 96;
    for (const l of h.lines) {
      const line = l.length > PATCH_LINE ? `${l.slice(0, PATCH_LINE - 1)}…` : l;
      const n = line.length * 2 + 4;
      if (bytes + size + n > EDIT_PATCH_BYTES) {
        cut = true;
        break;
      }
      size += n;
      lines.push(line);
    }
    if (!lines.length) {
      cut = true;
      break;
    }
    kept.push({ ...h, lines });
    bytes += size;
    if (cut) break;
  }
  return { k: "edit_patch", id, path, create, added, removed, hunks: kept, cut, parent };
}

/** A subagent's report: `handbackReport` as a string or `{text}`, else the text of the result's own content (spike). */
export function handbackReport(side: unknown): string | null {
  if (!isObj(side)) return null;
  const hb = side.handbackReport;
  if (typeof hb === "string") return hb;
  if (isObj(hb) && typeof hb.text === "string") return hb.text;
  if (Array.isArray(side.content)) {
    const t = side.content.filter((c) => isObj(c) && c.type === "text" && typeof c.text === "string").map((c) => (c as Obj).text as string);
    return t.length ? t.join("\n") : null;
  }
  return null;
}

/**
 * The user messages a main-thread reply frame says its turn took in (`user_message_uuids`, else `user_message_uuid`:
 * sdk.d.ts 0.3.322 lines 3757-3762 and 5848-5852, the turn's first frames, and a message folded in later where the CLI
 * stamps one), as one `taken_in` before the frame's own rows; none when the frame carries no stamp.
 */
function takenIn(m: Obj, out: ChatEvent[]): void {
  const list = Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [m.user_message_uuid];
  const uuids = list.filter((u): u is string => typeof u === "string" && u !== "").slice(0, 64);
  if (uuids.length) out.push({ k: "taken_in", uuids });
}

function usageOf(u: unknown): TaskUsage | null {
  if (!isObj(u)) return null;
  const totalTokens = num(u.total_tokens);
  const toolUses = num(u.tool_uses);
  const durationMs = num(u.duration_ms);
  if (totalTokens === null || toolUses === null || durationMs === null) return null;
  return { totalTokens, toolUses, durationMs };
}

/** A model id cut to its last segment, so a provider's inference-profile path never reaches the page. */
const modelTail = (v: unknown): string | null => {
  const tail = typeof v === "string" && v ? (v.split("/").pop() ?? v) : null;
  return isProviderArn(tail) ? null : tail;
};
/** A model id as Claude Code reports it, or null for none and for a provider's ARN (row 95). */
const modelOf = (v: unknown): string | null => (isProviderArn(v) ? null : str(v));

/** The `workflow_progress` entries of a task_progress message (an untyped field; the spike's mapping). */
export function workflowSteps(v: unknown): WorkflowStep[] | null {
  if (!Array.isArray(v)) return null;
  const out: WorkflowStep[] = [];
  for (const x of v) {
    if (!isObj(x)) continue;
    const index = num(x.index) ?? 0;
    if (x.type === "workflow_phase") out.push({ kind: "phase", index, title: str(x.title) });
    else if (x.type === "workflow_agent")
      out.push({
        kind: "agent",
        index,
        label: str(x.label),
        phaseIndex: num(x.phaseIndex),
        phaseTitle: str(x.phaseTitle),
        state: str(x.state),
        attempt: num(x.attempt),
        prompt: taskOrNull(x.promptPreview),
        result: taskOrNull(x.resultPreview ?? x.summary ?? x.result),
        error: taskOrNull(x.error),
        model: modelTail(x.model),
      });
  }
  return out;
}

/** C0 and C1 controls, DEL and the bidirectional marks (CONTROL_CHARS), all of them. */
const CONTROL_ALL = new RegExp(CONTROL_CHARS.source, "g");

/** A one-line label from the CLI: controls become spaces, runs of white space one space; null when nothing is left. */
function plainLabel(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = capText(v.replace(CONTROL_ALL, " ").replace(/\s+/g, " ").trim(), max).trim();
  return s || null;
}

/**
 * What `system/init` says that Settings and the + menu read (6.5, 6.8): the fast-mode state and its reason (D35,
 * AR-7), the skills and the plugins that the chat loaded (SE-3; a plugin's path stays on the server, and its version
 * is the author's own text, so it is cut), and the output style (SE-4).
 */
export function loadedFacts(m: Record<string, unknown>): Required<Pick<ChatEventOf<"session">, "fastMode" | "skills" | "plugins" | "outputStyle">> {
  const state = m.fast_mode_state;
  const fastMode =
    typeof state === "string" && (FAST_MODE_STATES as readonly string[]).includes(state)
      ? { state: state as FastModeState, reason: plainLabel(m.fast_mode_disabled_reason, LIMITS.name) }
      : null;
  const skills = (Array.isArray(m.skills) ? m.skills : [])
    .map((s) => plainLabel(s, LIMITS.name))
    .filter((s): s is string => s !== null)
    .slice(0, LIMITS.loaded);
  const plugins: PluginInfo[] = [];
  for (const p of Array.isArray(m.plugins) ? m.plugins : []) {
    if (!isObj(p)) continue;
    const name = plainLabel(p.name, LIMITS.name);
    if (name === null) continue;
    plugins.push({ name, version: plainLabel(p.version, LIMITS.pluginVersion) });
    if (plugins.length >= LIMITS.loaded) break;
  }
  return { fastMode, skills, plugins, outputStyle: plainLabel(m.output_style, LIMITS.name) };
}

/**
 * L34: `system/init`'s `cwd` (sdk.d.ts 0.3.322 line 6355), the folder Claude Code runs in: an absolute path of at most
 * 4,096 characters with no control character, else null.
 */
export function initCwd(v: unknown): string | null {
  return typeof v === "string" && v.startsWith("/") && v.length <= 4096 && !CONTROL_CHARS.test(v) ? v : null;
}

/** A slash command row (sdk.d.ts `SlashCommand`) with D47's terminal-only mark. */
export function commandInfo(c: unknown, terminalOnly: ReadonlySet<string>): CommandInfo | null {
  if (!isObj(c) || typeof c.name !== "string") return null;
  return {
    name: c.name,
    description: capText(strOr(c.description, ""), LIMITS.taskText),
    argumentHint: strOr(c.argumentHint, ""),
    aliases: Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === "string") : [],
    builtin: c.builtin === true,
    terminalOnly: terminalOnly.has(c.name),
  };
}

export interface MapperOptions {
  /** This chat's Claude Code started with the bypass flag (D12). */
  bypass: boolean;
  /** True for a uuid the host itself put on the input: a user message with it is the CLI's echo (D49), dropped. */
  isOwnMessage?: (uuid: string) => boolean;
  /** True while a user message the host sent waits for its turn: the next turn starts "by user". */
  userWaiting?: () => boolean;
}

/** One live chat's mapping state. map() never throws: an unknown or malformed message gives no event. */
export class EventMapper {
  private msgId = "";
  private readonly texts = new TextDedupe();
  private readonly thinking = new TextDedupe();
  /** Stream keys of the text and thinking blocks open in the main thread's stream. */
  private readonly openBlocks = new Map<number, string>();
  private readonly toolNames = new Map<string, string>();
  private readonly hiddenTools = new Set<string>();
  /** task_id to the tool-use id of its Agent or Workflow call, so a denial inside a subagent finds its block. */
  private readonly taskToolUse = new Map<string, string>();
  /** Local outputs already shown in this turn, so the assistant twin of a local command adds nothing. */
  private readonly localSeen = new Set<string>();
  private inTurn = false;
  /** Names in `terminal_slash_commands` of the last init (D47). */
  readonly terminalOnly = new Set<string>();
  /** The last command list (initialization, then each commands_changed). */
  commands: unknown[] | null = null;
  sessionId: string | null = null;

  constructor(private readonly opts: MapperOptions) {}

  get turnRunning(): boolean {
    return this.inTurn;
  }

  /** The tool-use id of the Agent or Workflow call that runs task `taskId` (a subagent's `agentID`), or null. */
  toolUseOfTask(taskId: string): string | null {
    return this.taskToolUse.get(taskId) ?? null;
  }

  /** Remember a task's tool use (task_started also does this when it maps). */
  noteTask(taskId: string, toolUseId: string | null): void {
    if (toolUseId) this.taskToolUse.set(taskId, toolUseId);
  }

  map(m: SDKMessage): ChatEvent[] {
    try {
      return this.mapInner(m as unknown as Obj).map(capEvent);
    } catch {
      return [];
    }
  }

  /** The `/` menu from a command list (also used for the initialization result). */
  commandsEvent(list: unknown[]): ChatEvent {
    this.commands = list;
    return { k: "commands", list: list.map((c) => commandInfo(c, this.terminalOnly)).filter((c): c is CommandInfo => c !== null) };
  }

  private startTurn(out: ChatEvent[]): void {
    if (this.inTurn) return;
    this.inTurn = true;
    out.push({ k: "turn_start", by: this.opts.userWaiting?.() ? "user" : "agent" });
  }

  private local(out: ChatEvent[], s: string): void {
    for (const o of localOutputs(s)) {
      const key = `${o.stream}\u0000${o.text}`;
      if (this.localSeen.has(key)) continue;
      this.localSeen.add(key);
      out.push({ k: "local_output", stream: o.stream, text: o.text });
    }
  }

  private mapInner(m: Obj): ChatEvent[] {
    const out: ChatEvent[] = [];
    const parent = str(m.parent_tool_use_id);
    switch (m.type) {
      case "system":
        this.system(m, out);
        return out;
      case "conversation_reset":
        out.push({ k: "reset", trigger: strOr(m.trigger, "clear") });
        return out;
      case "stream_event":
        if (parent) return out; // subagent text arrives as whole messages (forwardSubagentText), routed below
        this.startTurn(out);
        takenIn(m, out);
        this.stream(m.event, out);
        return out;
      case "assistant":
        if (!parent) {
          this.startTurn(out);
          takenIn(m, out);
        }
        this.assistant(m, parent, out);
        return out;
      case "user":
        this.user(m, parent, out);
        return out;
      case "result":
        this.result(m, out);
        return out;
      case "tool_progress": {
        const id = str(m.tool_use_id);
        if (id && !this.hiddenTools.has(id)) out.push({ k: "tool_progress", id, seconds: num(m.elapsed_time_seconds) ?? 0, parent });
        return out;
      }
      case "prompt_suggestion":
        if (typeof m.suggestion === "string" && m.suggestion.trim()) out.push({ k: "suggestion", text: m.suggestion });
        return out;
      case "command_lifecycle": {
        // Only the `cancelled` state: a message that will not run (the `dropped` event, shared/protocol.ts).
        const uuid = str(m.command_uuid);
        if (uuid && m.state === "cancelled") out.push({ k: "dropped", uuid });
        return out;
      }
      default:
        // auth_status, rate_limit_event, tool_use_summary and the rest: not shown (4.2, 11.2).
        return out;
    }
  }

  private system(m: Obj, out: ChatEvent[]): void {
    switch (m.subtype) {
      case "init": {
        this.startTurn(out);
        const sid = str(m.session_id);
        if (sid) this.sessionId = sid;
        const before = [...this.terminalOnly].sort().join("\n");
        this.terminalOnly.clear();
        if (Array.isArray(m.terminal_slash_commands)) for (const n of m.terminal_slash_commands) if (typeof n === "string") this.terminalOnly.add(n);
        const changed = before !== [...this.terminalOnly].sort().join("\n");
        out.push({
          k: "session",
          sessionId: sid ?? "",
          model: modelOf(m.model),
          mode: str(m.permissionMode),
          version: str(m.claude_code_version),
          bypass: this.opts.bypass,
          ...loadedFacts(m),
          ...(initCwd(m.cwd) ? { cwd: initCwd(m.cwd) } : {}),
        });
        // The terminal-only marks changed: the `/` menu again, with the new marks (D47).
        if (this.commands && changed) out.push(this.commandsEvent(this.commands));
        return;
      }
      case "status":
        out.push({
          k: "status",
          status: m.status === "compacting" || m.status === "requesting" ? m.status : null,
          compact: m.compact_result === "success" || m.compact_result === "failed" ? m.compact_result : null,
          error: str(m.compact_error),
        });
        return;
      case "api_retry":
        out.push({ k: "retry", attempt: num(m.attempt) ?? 0, max: num(m.max_retries) ?? 0, delayMs: num(m.retry_delay_ms) ?? 0, error: strOr(m.error, "unknown") });
        return;
      case "model_refusal_fallback":
        out.push({
          k: "refusal",
          uuid: strOr(m.uuid, ""),
          text: strOr(m.content, ""),
          retracted: Array.isArray(m.retracted_message_uuids) ? m.retracted_message_uuids.filter((u): u is string => typeof u === "string") : [],
          fallback: { model: modelOf(m.fallback_model) ?? "", scope: m.scope === "local" ? "local" : "session" },
        });
        return;
      case "model_refusal_no_fallback":
        out.push({ k: "refusal", uuid: strOr(m.uuid, ""), text: strOr(m.content, ""), retracted: [], fallback: null });
        return;
      case "informational": {
        const level = m.level === "notice" || m.level === "suggestion" || m.level === "warning" ? m.level : "info";
        out.push({ k: "info", uuid: strOr(m.uuid, ""), text: strOr(m.content, ""), level, toolUseId: str(m.tool_use_id) });
        return;
      }
      case "memory_recall":
        out.push({
          k: "memory",
          uuid: strOr(m.uuid, ""),
          items: (Array.isArray(m.memories) ? m.memories : []).filter(isObj).map((x) => ({
            scope: x.scope === "team" || x.scope === "organization" ? x.scope : "personal",
            path: strOr(x.path, ""),
            text: str(x.content),
          })),
        });
        return;
      case "plugin_install": {
        const s = m.status;
        if (s === "started" || s === "installed" || s === "failed" || s === "completed")
          out.push({ k: "plugin_install", uuid: strOr(m.uuid, ""), status: s, name: str(m.name), error: str(m.error) });
        return;
      }
      case "notification": {
        const p = m.priority;
        out.push({
          k: "toast",
          key: strOr(m.key, ""),
          text: strOr(m.text, ""),
          priority: p === "medium" || p === "high" || p === "immediate" ? p : "low",
          timeoutMs: num(m.timeout_ms),
        });
        return;
      }
      case "thinking_tokens":
        out.push({ k: "thinking_estimate", tokens: num(m.estimated_tokens) ?? 0 });
        return;
      case "hook_started":
      case "hook_progress":
      case "hook_response": {
        const phase = m.subtype === "hook_started" ? "started" : m.subtype === "hook_progress" ? "progress" : "response";
        const output = phase === "started" ? null : [str(m.output), str(m.stdout), str(m.stderr)].find((s) => s) ?? null;
        out.push({ k: "hook", phase, event: strOr(m.hook_event, ""), name: strOr(m.hook_name, ""), outcome: phase === "response" ? str(m.outcome) : null, output });
        return;
      }
      case "compact_boundary":
        out.push({ k: "compacted", trigger: isObj(m.compact_metadata) ? strOr(m.compact_metadata.trigger, "auto") : "auto" });
        return;
      case "local_command_output": {
        const c = strOr(m.content, "");
        if (/<local-command-(stdout|stderr)>/.test(c)) {
          this.local(out, c);
        } else {
          const text = stripAnsi(c).replace(/\s+$/, "");
          const key = `stdout\u0000${text}`;
          if (!this.localSeen.has(key)) {
            this.localSeen.add(key);
            out.push({ k: "local_output", stream: "stdout", text });
          }
        }
        return;
      }
      case "task_started":
      case "task_progress":
      case "task_updated":
      case "task_notification": {
        const e = this.task(m);
        if (e) out.push(e);
        return;
      }
      case "background_tasks_changed":
        out.push({
          k: "tasks",
          running: (Array.isArray(m.tasks) ? m.tasks : []).filter(isObj).map((t) => ({ taskId: strOr(t.task_id, ""), description: task(t.description), ambient: t.ambient === true })),
        });
        return;
      case "commands_changed":
        if (Array.isArray(m.commands)) out.push(this.commandsEvent(m.commands));
        return;
      case "session_title_changed": {
        // The session's name. Claude Code sends it at a start when the session has one and after each change: a /rename
        // (with no name too, when Claude Code picks one), a rename in the terminal or another host, a SessionStart hook's
        // sessionTitle. Never for its own automatic title (2.1.311's description of the message), so it is the user's.
        const title = plainLabel(m.title, LIMITS.title);
        if (title) out.push({ k: "title", title, from: "renamed" });
        return;
      }
      case "permission_denied": {
        const id = str(m.tool_use_id);
        if (!id) return;
        const agent = str(m.agent_id);
        out.push({
          k: "denied",
          id,
          tool: strOr(m.tool_name, ""),
          reasonType: str(m.decision_reason_type),
          reason: str(m.decision_reason),
          parent: agent ? (this.taskToolUse.get(agent) ?? null) : null,
        });
        return;
      }
      default:
        // elicitation_complete is the driver's (it settles a URL-mode card); files_persisted, session_state_changed,
        // mirror_error, session_writes_lost (typed since SDK 0.3.322; sent as Claude Code exits) and the rest show
        // nothing.
        return;
    }
  }

  private task(m: Obj): TaskEvent | null {
    // Housekeeping and watcher tasks stay out of the transcript (sdk.d.ts: skip_transcript, ambient).
    if (m.skip_transcript === true || m.ambient === true) return null;
    const taskId = str(m.task_id);
    if (!taskId) return null;
    const toolUseId = str(m.tool_use_id);
    if (toolUseId) this.taskToolUse.set(taskId, toolUseId);
    switch (m.subtype) {
      case "task_started": {
        const isWorkflow = m.task_type === "local_workflow";
        return {
          k: "task",
          ev: "started",
          taskId,
          toolUseId,
          taskType: str(m.task_type),
          subagentType: str(m.subagent_type),
          description: task(m.description),
          workflowName: str(m.workflow_name),
          background: m.is_backgrounded === true,
          prompt: isWorkflow ? null : taskOrNull(m.prompt),
          parentTaskId: str(m.parent_task_id),
        };
      }
      case "task_progress":
        return {
          k: "task",
          ev: "progress",
          taskId,
          toolUseId,
          description: task(m.description),
          lastTool: str(m.last_tool_name),
          summary: taskOrNull(m.summary),
          usage: usageOf(m.usage),
          workflow: workflowSteps(m.workflow_progress),
        };
      case "task_updated": {
        const p = isObj(m.patch) ? m.patch : {};
        const s = p.status;
        return {
          k: "task",
          ev: "updated",
          taskId,
          toolUseId,
          status: s === "pending" || s === "running" || s === "completed" || s === "failed" || s === "killed" || s === "paused" ? s : null,
          error: taskOrNull(p.error),
          background: typeof p.is_backgrounded === "boolean" ? p.is_backgrounded : null,
        };
      }
      default: {
        const s = m.status;
        return {
          k: "task",
          ev: "done",
          taskId,
          toolUseId,
          status: s === "failed" || s === "stopped" ? s : "completed",
          summary: taskOrNull(m.summary),
          usage: usageOf(m.usage),
        };
      }
    }
  }

  private stream(ev: unknown, out: ChatEvent[]): void {
    if (!isObj(ev)) return;
    if (ev.type === "message_start") {
      this.msgId = isObj(ev.message) ? strOr(ev.message.id, "") : "";
      this.openBlocks.clear();
      return;
    }
    const index = num(ev.index);
    if (index === null) return;
    const key = `${this.msgId}:${index}`;
    if (ev.type === "content_block_start" && isObj(ev.content_block)) {
      const cb = ev.content_block;
      if (cb.type === "text") {
        this.texts.streamedText(this.msgId);
        this.openBlocks.set(index, key);
        out.push({ k: "block_start", key, kind: "text", parent: null });
      } else if (cb.type === "thinking" || cb.type === "redacted_thinking") {
        this.thinking.streamedText(this.msgId);
        this.openBlocks.set(index, key);
        out.push({ k: "block_start", key, kind: "thinking", parent: null });
      } else if (cb.type === "tool_use" && typeof cb.id === "string") {
        const name = strOr(cb.name, "");
        this.toolNames.set(cb.id, name);
        if (HIDDEN_TOOLS.has(name)) this.hiddenTools.add(cb.id);
        else out.push({ k: "tool_call", id: cb.id, name, input: null, parent: null });
      }
      return;
    }
    if (ev.type === "content_block_delta" && isObj(ev.delta) && this.openBlocks.has(index)) {
      const d = ev.delta;
      if (d.type === "text_delta" && typeof d.text === "string") out.push({ k: "block_delta", key, text: d.text });
      else if (d.type === "thinking_delta" && typeof d.thinking === "string") out.push({ k: "block_delta", key, text: d.thinking });
      return;
    }
    if (ev.type === "content_block_stop" && this.openBlocks.has(index)) {
      this.openBlocks.delete(index);
      out.push({ k: "block_end", key });
    }
  }

  private assistant(m: Obj, parent: string | null, out: ChatEvent[]): void {
    const msg = isObj(m.message) ? m.message : {};
    const id = strOr(msg.id, strOr(m.uuid, ""));
    const uuid = strOr(m.uuid, "");
    // The headless engine's assistant twin of a local command (an @internal field): its text is the command's own
    // output, which shows as local output, never as a model reply (V-sdk C11).
    if (typeof m.local_command_source === "string") {
      this.local(out, m.local_command_source);
      return;
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === "text" && typeof b.text === "string") {
        // null: already drawn from the stream (main thread); subagent and unstreamed text arrives only here.
        const key = this.texts.recordText(id);
        if (key && b.text !== "") out.push({ k: "block", key, kind: "text", text: b.text, parent });
      } else if ((b.type === "thinking" || b.type === "redacted_thinking") && !parent) {
        const key = this.thinking.recordText(id);
        const text = typeof b.thinking === "string" ? b.thinking : "";
        if (key && text) out.push({ k: "block", key: `${key}:thinking`, kind: "thinking", text, parent: null });
      } else if (b.type === "tool_use" && typeof b.id === "string") {
        const name = strOr(b.name, "");
        this.toolNames.set(b.id, name);
        if (HIDDEN_TOOLS.has(name)) {
          this.hiddenTools.add(b.id);
          continue;
        }
        out.push({ k: "tool_call", id: b.id, name, input: b.input ?? {}, parent });
      }
    }
    if (typeof m.error === "string") out.push({ k: "agent_error", uuid, error: m.error, parent });
  }

  private user(m: Obj, parent: string | null, out: ChatEvent[]): void {
    // The CLI's replay of the host's own message (D49; live L2 saw none): the server already drew it.
    if (m.isReplay === true) return;
    const uuid = str(m.uuid);
    if (uuid && this.opts.isOwnMessage?.(uuid)) return;
    const msg = isObj(m.message) ? m.message : {};
    const content = msg.content;
    if (typeof content === "string") {
      if (!parent) this.local(out, content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!isObj(b)) continue;
      // A local slash command answers with <local-command-stdout> in a user message; other text the CLI adds (a
      // skill's expansion, a subagent's prompt) is not the user's own and shows nothing.
      if (b.type === "text" && typeof b.text === "string" && !parent) this.local(out, b.text);
      else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        if (this.hiddenTools.has(b.tool_use_id)) continue;
        const name = this.toolNames.get(b.tool_use_id);
        const report = name && AGENT_TOOLS.has(name) ? handbackReport(m.tool_use_result) : null;
        const text = toolResultText(b.content);
        out.push({ k: "tool_result", id: b.tool_use_id, text, isError: b.is_error === true, parent, report, ...trustOf(text, name), ...backgroundOf(text, name) });
        // U1: a file tool's own patch, for the registry alone (never a page's).
        const patch = b.is_error === true ? null : editPatchOf(name, b.tool_use_id, m.tool_use_result, parent);
        if (patch) out.push(patch);
      }
    }
  }

  private result(m: Obj, out: ChatEvent[]): void {
    const sid = str(m.session_id);
    if (sid) this.sessionId = sid;
    this.inTurn = false;
    this.localSeen.clear();
    const isError = m.is_error === true;
    let error: string | null = null;
    if (isError) {
      const errs = Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === "string" && e.trim() !== "") : [];
      error = (str(m.result) || errs.join("; ") || strOr(m.subtype, "error")).split("\n")[0]!.slice(0, 240);
    }
    const uuids = Array.isArray(m.user_message_uuids)
      ? m.user_message_uuids.filter((u): u is string => typeof u === "string")
      : typeof m.user_message_uuid === "string"
        ? [m.user_message_uuid]
        : [];
    out.push({ k: "turn_end", ok: !isError, subtype: strOr(m.subtype, "success"), durationMs: num(m.duration_ms) ?? 0, error, uuids });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// History: a session's transcript as events (DESIGN 6.3 "History"; the spike's historyItems, srv 132-156)

/**
 * The tags Claude Code wraps its own texts in (a system reminder, a caveat, a task notification), by name: the
 * names with a hyphen or an underscore in the CLI's own tag lists. A user message that is one tag pair of any other
 * name (`<div>Center this box</div>`) is the user's own words and shows.
 */
const CLI_WRAPPER_TAGS: ReadonlySet<string> = new Set([
  "system-reminder",
  "system_reminder",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "bash-exit-code",
  "user-memory-input",
  "user-prompt-submit-hook",
  "post-tool-use-hook",
  "task-notification",
  "agent-message",
  "teammate-message",
  "cross-session-message",
  "coordinator-relay",
  "remote-review",
  "fetched-web-content",
  "fork-boilerplate",
  "persisted-output",
  "mcp-resource-update",
  "mcp-polling-update",
  "ide_selection",
  "ide_opened_file",
  "browser_instruction",
  "function_results",
  "tool_use_error",
  "sandbox_violations",
  "total_tokens",
  "slack-ping",
  "slack-tag-message",
  "artifact-type-instructions",
  "artifact-file-content",
  "artifact-origin-notes",
  "artifact-stored-declaration",
  "cowritten-artifact-html",
]);
/** A whole text that is one tag pair (attributes allowed), with the tag's name. */
const TAG_PAIR_RE = /^\s*<([A-Za-z][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>\s*$/;

/** Whether `text` is one of Claude Code's own wrapper texts, not the user's words. */
function cliWrapped(text: string): boolean {
  const m = TAG_PAIR_RE.exec(text);
  return m !== null && CLI_WRAPPER_TAGS.has(m[1]!);
}
const COMMAND_RE = /<command-name>([^<]+)<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/;
/**
 * The line that Claude Code writes into the transcript when a Stop ends a turn (its own words, never the user's):
 * history ends that turn as interrupted, as the live turn ended (TURN_INTERRUPTED).
 */
const INTERRUPT_LINES: ReadonlySet<string> = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);

/**
 * A user record that holds Claude Code's own text, never the user's words: a compaction's summary (it retells the
 * earlier turns, with a tool's output and Claude's thinking) and the other rows the SDK's reader flags as meta (a row
 * for the transcript view only, a message that a channel or a peer put in). The reader sets `isCompactSummary` and
 * `is_meta` on its SessionMessage (fields its type does not declare). The live chat draws none of them.
 */
function ownRecord(sm: SessionMessage): boolean {
  const f = sm as SessionMessage & { isCompactSummary?: unknown; is_meta?: unknown };
  return f.isCompactSummary === true || f.is_meta === true;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => (b as Obj).text as string)
    .join("\n");
}

/**
 * The events of a transcript, in order. Subagent rows are left out (their transcripts are separate; v0.4 resume), and
 * so is the text of Claude Code's own user records (a compaction's summary: ownRecord);
 * `!` records, slash commands and their local output are parsed back from their tags, and Claude Code's own line
 * after a Stop is that turn's end (TURN_INTERRUPTED). A tool call that never gets a result is stopped
 * (`tool_stopped`) at its turn's end: before Claude Code's line after a Stop, or before the user's next message.
 * The calls of the transcript's last turn are left as they are, since the chat may still run that turn.
 */
export function historyEvents(messages: readonly SessionMessage[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  const toolNames = new Map<string, string>();
  const hidden = new Set<string>();
  /** Content blocks seen so far per API message id (main thread only). */
  const blockIndex = new Map<string, number>();
  const results = new Set<string>();
  for (const sm of messages) {
    if (sm.parent_tool_use_id || sm.type !== "user") continue;
    const c = isObj(sm.message) ? sm.message.content : null;
    if (Array.isArray(c)) for (const b of c) if (isObj(b) && b.type === "tool_result" && typeof b.tool_use_id === "string") results.add(b.tool_use_id);
  }
  /** The calls since the last turn's end that get no result anywhere in the transcript. */
  let open: string[] = [];
  const stopOpen = () => {
    for (const id of open) out.push({ k: "tool_stopped", id, parent: null });
    open = [];
  };
  for (const sm of messages) {
    if (sm.parent_tool_use_id) continue;
    const msg = isObj(sm.message) ? sm.message : {};
    const uuid = sm.uuid;
    if (sm.type === "user") {
      const content = msg.content;
      // Claude Code's own text (a compaction's summary): no bubble, and nothing the message search keeps.
      const text = ownRecord(sm) ? "" : userText(content);
      const bash = parseBashRecord(text);
      const cmd = COMMAND_RE.exec(text);
      const locals = localOutputs(text);
      const stopped = INTERRUPT_LINES.has(text.trim());
      // The user's next message (a `!` record, a `/` command and its output too) starts a new turn.
      if (bash || cmd || locals.length || (text && !cliWrapped(text) && !stopped)) stopOpen();
      if (bash) {
        out.push({
          k: "bash",
          uuid,
          input: bash.input,
          state: "done",
          stdout: bash.stdout,
          stderr: bash.stderr,
          code: null,
          ms: null,
          timedOut: /Command timed out after \d+s$/.test(bash.stderr),
          capped: false,
        });
      } else if (cmd) {
        const args = cmd[2]?.trim();
        out.push({ k: "user", uuid, text: `${cmd[1]!.trim()}${args ? ` ${args}` : ""}`, queued: false });
      } else if (locals.length) {
        for (const o of locals) out.push({ k: "local_output", stream: o.stream, text: o.text });
      } else if (text && !cliWrapped(text) && !stopped) {
        out.push({ k: "user", uuid, text, queued: false });
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!isObj(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string" || hidden.has(b.tool_use_id)) continue;
          const text = toolResultText(b.content);
          const name = toolNames.get(b.tool_use_id);
          out.push({ k: "tool_result", id: b.tool_use_id, text, isError: b.is_error === true, parent: null, report: null, ...trustOf(text, name), ...backgroundOf(text, name) });
        }
      }
      if (stopped) {
        stopOpen();
        out.push({ k: "turn_end", ok: false, subtype: TURN_INTERRUPTED, durationMs: 0, error: null, uuids: [] });
      }
    } else if (sm.type === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const apiId = typeof msg.id === "string" && msg.id !== "" ? msg.id : null;
      content.forEach((b, i) => {
        // The live stream's key, `<API message id>:<block index>`: the CLI writes one record per block, so the count of
        // blocks so far in records of that message is the stream's index. A snapshot taken during a turn then names
        // each block as the turn's own events do, and the page draws it once.
        let key = `${uuid}:${i}`;
        if (apiId !== null) {
          const n = blockIndex.get(apiId) ?? 0;
          blockIndex.set(apiId, n + 1);
          key = `${apiId}:${n}`;
        }
        if (!isObj(b)) return;
        if (b.type === "text" && typeof b.text === "string" && b.text !== "") out.push({ k: "block", key, kind: "text", text: b.text, parent: null });
        else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking !== "")
          out.push({ k: "block", key, kind: "thinking", text: b.thinking, parent: null });
        else if (b.type === "tool_use" && typeof b.id === "string") {
          const name = strOr(b.name, "");
          toolNames.set(b.id, name);
          if (HIDDEN_TOOLS.has(name)) hidden.add(b.id);
          else {
            out.push({ k: "tool_call", id: b.id, name, input: b.input ?? {}, parent: null });
            if (!results.has(b.id) && !open.includes(b.id)) open.push(b.id);
          }
        }
      });
    } else if (sm.type === "system") {
      if (msg.subtype === "compact_boundary") {
        const meta = isObj(msg.compact_metadata) ? msg.compact_metadata : isObj(msg.compactMetadata) ? msg.compactMetadata : {};
        out.push({ k: "compacted", trigger: strOr(meta.trigger, "auto") });
      }
    }
  }
  return out.map(capEvent);
}

/**
 * T-26: the whole text of one tool use's result in a transcript, before any cap (the output route's read), as history
 * maps a result's content (toolResultText); null when the transcript holds no result for that id, or holds it for a tool
 * that is never shown (HIDDEN_TOOLS).
 */
export function toolResultOf(messages: readonly SessionMessage[], toolUseId: string): string | null {
  let text: string | null = null;
  for (const sm of messages) {
    const content = isObj(sm.message) ? sm.message.content : null;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!isObj(b)) continue;
      if (sm.type === "assistant" && b.type === "tool_use" && b.id === toolUseId && HIDDEN_TOOLS.has(strOr(b.name, ""))) return null;
      if (sm.type === "user" && b.type === "tool_result" && b.tool_use_id === toolUseId && text === null) text = toolResultText(b.content);
    }
  }
  return text;
}

/** The model name of a reply that Claude Code wrote itself (an API error, an overload notice, "No response requested."). */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * U5: the records the message search reads (the driver's transcriptEvents): every record but Claude Code's own
 * synthetic replies, whose words are its notices (DESIGN-U5 4, system lines), not Claude's. The chat's history keeps
 * them, as the live chat shows them.
 */
export function searchRecords(messages: readonly SessionMessage[]): SessionMessage[] {
  return messages.filter((sm) => !(sm.type === "assistant" && isObj(sm.message) && sm.message.model === SYNTHETIC_MODEL));
}

/** The JSON size of an event, in bytes, as a frame would carry it. */
export function eventBytes(e: ChatEvent): number {
  return Buffer.byteLength(JSON.stringify(e), "utf8");
}

const CURSOR_RE = /^h1:(\d{1,9})$/;

/**
 * Row 94: the token use of the main session's last reply in the transcript, as the API reported it on that record:
 * its request's input (uncached, written to the cache and read from it) and its output, with the record's model (a
 * provider's ARN is the default model on Bedrock: "default"). A record with no usage or none counted (a line of Claude
 * Code's own) is passed over; null when no reply has one.
 */
export function lastReplyUsage(messages: readonly SessionMessage[]): { model: string | null; usedTokens: number } | null {
  const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);
  for (let i = messages.length - 1; i >= 0; i--) {
    const sm = messages[i]!;
    if (sm.parent_tool_use_id || sm.type !== "assistant" || !isObj(sm.message) || !isObj(sm.message.usage)) continue;
    const u = sm.message.usage;
    const used = count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens) + count(u.output_tokens);
    if (used === 0) continue;
    const model = sm.message.model;
    return { model: isProviderArn(model) ? "default" : typeof model === "string" && model && model !== SYNTHETIC_MODEL ? model : null, usedTokens: used };
  }
  return null;
}

/**
 * One page of `events` (chronological): the newest events that end before the cursor and fit `maxBytes` (at least
 * one event, so a page always moves), in order, and the cursor of the next older page or null.
 */
export function historyPage(events: readonly ChatEvent[], before: string | null, maxBytes: number): { events: ChatEvent[]; more: string | null } {
  let end = events.length;
  if (before !== null) {
    const m = CURSOR_RE.exec(before);
    if (!m) return { events: [], more: null };
    end = Math.min(events.length, Number(m[1]));
  }
  let start = end;
  let bytes = 2;
  while (start > 0) {
    const b = eventBytes(events[start - 1]!) + 1;
    if (start < end && bytes + b > maxBytes) break;
    bytes += b;
    start--;
  }
  return { events: events.slice(start, end), more: start > 0 ? `h1:${start}` : null };
}
