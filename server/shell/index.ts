// The Terminal pane's shell (D38, D52): what the HTTP layer and the registry import.
export {
  createShellService,
  SHELL_ERROR_MESSAGES,
  type ShellHost,
  type ShellOutFrame,
  type ShellService,
  type ShellServiceOptions,
  type ShellSlotHandlers,
  type ShellSlotSocket,
  type ShellSocket,
  type ShellTypedFrame,
  type ShellUpgradeServer,
  type ShellWsData,
  type TypedCase,
} from "./service";
export { resumeCommand, shellWord, type ResumeCase, type ResumeCommand, type ShellChat } from "./command";
export { shellEnv, SHELL_TERM, type ShellEnvOptions } from "./env";
export { defaultShell, type ShellExit } from "./pty";
