// Row 97 (the owner: Settings said "Start a chat to read it." in many places): the facts that only a live chat's Claude
// Code reports, kept for the times none runs. The provider (Settings > Account, `accountInfo().apiProvider`) on every
// live read, and the start facts (fast mode, skills, plugins, output style) on every `session` event, each with the
// chat's project and the time it came (projects.json, store/facts.ts). Settings shows the newest provider kept with
// any project, and the start facts kept with the project it reads (else the newest any project kept), with their age,
// while no live value is there; a live value replaces them. No string that starts with "arn:" is kept. D60: a project
// whose variables can change the provider (it has some, or they cannot be read: ModelList.own) answers for itself
// alone, and the host's Settings and every other project take only the newest of the projects with none.

import type { ChatEventOf } from "../../shared/protocol";
import { isProviderArn } from "../agents/types";
import { keptAccountFrom, keptFactsFrom } from "../store/facts";
import type { KeptAccount, KeptFacts, ProjectRecord, Store } from "../store/types";

const newest = <T extends { at: string }>(list: (T | undefined)[]): T | null => list.reduce<T | null>((best, x) => (x && (!best || x.at > best.at) ? x : best), null);

type Own = (project: string) => boolean;

/** The provider for project `id`'s Settings (null: the host's): the newest kept with any project; `own`: D60's rule. */
export function newestAccount(projects: readonly Pick<ProjectRecord, "id" | "account">[], id: string | null = null, own: Own = () => false): KeptAccount | null {
  if (id !== null && own(id)) return projects.find((p) => p.id === id)?.account ?? null;
  return newest(projects.filter((p) => !own(p.id)).map((p) => p.account));
}

/** The start facts kept with project `id`, else the newest that any project kept; null when none are. `own`: D60's rule. */
export function factsFor(projects: readonly Pick<ProjectRecord, "id" | "facts">[], id: string | null, own: Own = () => false): KeptFacts | null {
  if (id !== null && own(id)) return projects.find((p) => p.id === id)?.facts ?? null;
  return projects.find((p) => p.id === id)?.facts ?? newest(projects.filter((p) => !own(p.id)).map((p) => p.facts));
}

/** A session event's start facts as kept, at `at`; undefined for an event that names none. Names that are ARNs go. */
export function factsOfSession(e: ChatEventOf<"session">, at: string): KeptFacts | undefined {
  if (e.skills === undefined || e.plugins === undefined || e.outputStyle === undefined || e.fastMode === undefined) return undefined;
  const name = (v: string | null | undefined) => (typeof v === "string" && v && !isProviderArn(v) ? v : null);
  return keptFactsFrom({
    at,
    fastMode: e.fastMode && { state: e.fastMode.state, reason: name(e.fastMode.reason) },
    skills: e.skills.filter((s) => name(s)),
    plugins: e.plugins.filter((p) => name(p.name)).map((p) => ({ name: p.name, version: name(p.version) })),
    outputStyle: name(e.outputStyle),
  });
}

export interface KeptSettingsDeps {
  store: Pick<Store, "listProjects" | "putProject">;
  now?: () => Date;
  /** Runs each write of the project table (the registry's one-after-another chain); by default, at once. */
  write?: <T>(fn: () => Promise<T>) => Promise<T>;
  onError?: (err: "store_write") => void;
}

export class KeptSettings {
  private readonly now: () => Date;

  constructor(private readonly deps: KeptSettingsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** A live chat's `session` event: its start facts kept with project `id`. */
  session(id: string, e: ChatEventOf<"session">): void {
    const facts = factsOfSession(e, this.now().toISOString());
    if (facts) this.put(id, { facts });
  }

  /** A live chat's account read: its provider kept with project `id`. */
  account(id: string, read: { provider: string | null }): void {
    const account = keptAccountFrom({ at: this.now().toISOString(), provider: read.provider });
    if (account) this.put(id, { account });
  }

  private put(id: string, change: Pick<ProjectRecord, "account"> | Pick<ProjectRecord, "facts">): void {
    const write = this.deps.write ?? ((fn) => fn());
    void write(async () => {
      const project = (await this.deps.store.listProjects()).find((p) => p.id === id);
      if (project) await this.deps.store.putProject({ ...project, ...change });
    }).catch(() => this.deps.onError?.("store_write"));
  }
}
