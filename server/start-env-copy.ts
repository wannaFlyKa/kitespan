// The environment as Bun got it from bin/kitespan (DESIGN.md 4.10), copied before any other module of the server runs:
// main.ts imports this module first, and it imports nothing, so the copy comes before the SDK's module writes a variable
// of its own into process.env (NoDefaultCurrentDirectoryInExePath when it loads, CLAUDE_AGENT_SDK_VERSION at each
// chat start). The restart's preflight child and successor, and the update check's git, get this copy.
//
// Under `bin/kitespan dev` (bun --hot) every module runs again at each reload while process.env stays as the SDK left it,
// so the first copy is kept on globalThis, which a reload keeps.

export type StartEnv = Readonly<Record<string, string | undefined>>;

const kept = globalThis as typeof globalThis & { __kitespanStartEnv?: StartEnv };

export const START_ENV: StartEnv = (kept.__kitespanStartEnv ??= Object.freeze({ ...process.env }));
