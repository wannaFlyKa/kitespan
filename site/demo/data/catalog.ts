// What Claude Code tells the page about a live chat in the demo (the click-through fixture's answers): the model rows,
// Claude Code's own slash commands (no plugin's command and no user's own), the example chat's context and its
// connectors. Pure data.

import type { CommandInfo, ConnectorInfo, ContextInfo, ModelInfo } from "../../../shared/protocol";

export const MODELS: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Use the default model (currently Opus 5.5)",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    supportsAutoMode: true,
  },
  {
    value: "claude-opus-5-5",
    displayName: "Opus 5.5",
    description: "Most capable for complex work",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    supportsAutoMode: true,
  },
  {
    value: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    description: "Fast and capable for everyday work",
    efforts: ["low", "medium", "high", "xhigh"],
    supportsAutoMode: true,
  },
  {
    value: "claude-haiku-5-5",
    displayName: "Haiku 5.5",
    description: "Fastest for quick answers",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    supportsAutoMode: true,
  },
  { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "Earlier Opus", efforts: ["low", "medium", "high"], supportsAutoMode: false },
];

export const COMMANDS: CommandInfo[] = [
  { name: "clear", description: "Start a new conversation in this chat", argumentHint: "", aliases: [], builtin: true, terminalOnly: false },
  {
    name: "compact",
    description: "Clear conversation history but keep a summary in context",
    argumentHint: "[instructions]",
    aliases: [],
    builtin: true,
    terminalOnly: false,
  },
  { name: "context", description: "Show current context usage", argumentHint: "", aliases: [], builtin: true, terminalOnly: false },
  { name: "review", description: "Review the changes on this branch", argumentHint: "", aliases: [], builtin: true, terminalOnly: false },
  { name: "init", description: "Write a CLAUDE.md for this folder", argumentHint: "", aliases: [], builtin: true, terminalOnly: false },
  { name: "memory", description: "Edit memory files", argumentHint: "", aliases: [], builtin: true, terminalOnly: false },
  { name: "mcp", description: "Manage MCP servers", argumentHint: "", aliases: [], builtin: true, terminalOnly: false },
  { name: "cost", description: "Show this session's usage", argumentHint: "", aliases: [], builtin: true, terminalOnly: false },
  { name: "doctor", description: "Check your Claude Code install", argumentHint: "", aliases: [], builtin: true, terminalOnly: true },
];

export const CONTEXT: ContextInfo = {
  model: "claude-opus-5-5",
  usedTokens: 114000,
  maxTokens: 200000,
  percent: 57,
  parts: [
    { name: "System prompt", tokens: 6400, kind: "used" },
    { name: "System tools", tokens: 14200, kind: "used" },
    { name: "MCP tools", tokens: 21800, kind: "used" },
    { name: "Memory files", tokens: 3100, kind: "used" },
    { name: "Messages", tokens: 68500, kind: "used" },
    { name: "Free space", tokens: 86000, kind: "free" },
  ],
};

export const CONNECTORS: ConnectorInfo[] = [
  { name: "github", status: "connected", error: null, tools: 3, scope: "user", hasView: true },
  { name: "docs-search", status: "failed", error: "The server closed the connection during start-up.", tools: 0, scope: "project", hasView: false },
  { name: "tickets", status: "needs-auth", error: null, tools: 0, scope: "user", hasView: false },
];
