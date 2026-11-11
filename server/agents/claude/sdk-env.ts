// The names that SDK 0.3.312 puts into, or takes out of, the claude child's environment: a module with no imports, so
// the gate (options.ts) and D60's refused names (server/env/names.ts) both read it without importing each other.

/**
 * What SDK 0.3.312 does to the environment of the claude child (sdk.mjs; DESIGN 4.7, "The clean start environment").
 * It sets the `host` names on the server's own process.env (the first when the SDK is imported, the second at each
 * query()), and the child's copy of process.env carries them. In that copy it sets the three `added` names, each only
 * when absent. With the key set above no other name comes: each `conditional` one needs an option outside the table or
 * another entry point than query() (enableFileCheckpointing, getOAuthToken, getHostAuthToken, toolConfig, a
 * sessionStore resume, an active OpenTelemetry context, DEBUG_CLAUDE_AGENT_SDK, the SDK's startup path).
 * test/gate/clean-start.test.ts and the driver tests check the names that the child gets.
 */
export const SDK_CHILD_ENV = {
  host: ["NoDefaultCurrentDirectoryInExePath", "CLAUDE_AGENT_SDK_VERSION"],
  added: ["CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SDK_READS_SESSION_STATE"],
  conditional: [
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
    "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
    "CLAUDE_CODE_QUESTION_EXTENDED",
    "CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "TRACEPARENT",
    "TRACESTATE",
    "DEBUG",
    "CLAUDE_CODE_SDK_READS_STARTUP_MARKS",
  ],
  removed: ["NODE_OPTIONS", "DEBUG", "CLAUDE_CODE_QUESTION_EXTENDED", "CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS", "CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES"],
} as const;
