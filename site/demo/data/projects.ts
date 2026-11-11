// The demo's three projects (the click-through seed's: kitespan, notes-api, scratch) in the demo machine's home
// folder (/work), the folders that New environment suggests, and the files of each folder that the @ picker and the
// file search list (test/click/seed/demo.ts PROJECT_FILES). Pure data.

import type { ProjectView, SuggestedFolder } from "../../../server/http/api-types";

export interface DemoProject extends Omit<ProjectView, "createdAt" | "lastUsedAt"> {
  /** Days before the page's load. */
  createdDays: number;
  /** Minutes before the page's load. */
  usedMin: number;
}

/** The projects, the one used last first (GET /api/projects's order). */
export const PROJECTS: DemoProject[] = [
  {
    id: "k3m7q2x4ab",
    name: "kitespan",
    cwd: "/work/kitespan",
    picks: { model: "claude-opus-5-5", effort: "xhigh", permissionMode: null },
    worktree: false,
    worktreeOff: null,
    env: 0,
    createdDays: 30,
    usedMin: 0,
  },
  {
    id: "scr4tch2de",
    name: "scratch",
    cwd: "/work/scratch",
    picks: { model: null, effort: null, permissionMode: null },
    worktree: false,
    worktreeOff: "not_git",
    env: 0,
    createdDays: 30,
    usedMin: 1,
  },
  {
    id: "n4tes2api7",
    name: "notes-api",
    cwd: "/work/notes-api",
    picks: { model: null, effort: null, permissionMode: "acceptEdits" },
    worktree: false,
    worktreeOff: "not_git",
    env: 0,
    createdDays: 30,
    usedMin: 4,
  },
];

export const SUGGESTED_FOLDERS: SuggestedFolder[] = [
  { name: "kitespan", path: "/work/kitespan", git: true, project: "k3m7q2x4ab", from: "session" },
  { name: "notes-api", path: "/work/notes-api", git: false, project: "n4tes2api7", from: "session" },
  { name: "scratch", path: "/work/scratch", git: false, project: "scr4tch2de", from: "session" },
];

/** Each project's files, relative to its folder, in git's order. */
export const PROJECT_FILES: Record<string, string[]> = {
  k3m7q2x4ab: [
    "README.md",
    "docs/UPLOAD-RETRIES.md",
    "package.json",
    "src/cli/push.ts",
    "src/sync.ts",
    "src/upload.ts",
    "test/helpers/fake-fetch.ts",
    "test/upload.test.ts",
  ],
  n4tes2api7: ["src/db/schema.sql", "src/query/parse.ts"],
  scr4tch2de: ["docs/RELEASE.md", "notes/log-summary.md"],
};
