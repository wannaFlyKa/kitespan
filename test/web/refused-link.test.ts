// A refused send or `!` command of a link's text (5.1 rule 7, D49): a /c/<chat>/send?text= or /bash?cmd= pre-fill that
// the user never edited is not the store's draft, so only the box's own draft (the composer passes it, Composer.tsx
// send) can say that the text came from a link. The refused request puts it back with its link mark, so the warning
// line comes back with it on every page, and a refused Bash link stays a command that the user must Run again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ERROR_MESSAGES, PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { EMPTY_DRAFT, act, connectWith, draftOf, getState, resetState } from "../../web/state/store";
import { toInput, type Draft } from "../../web/composer/draft";

class MemoryStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {}
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

const g = globalThis as unknown as { window?: Record<string, unknown>; localStorage?: MemoryStorage };
const own = { window: !g.window, storage: !g.localStorage };
beforeAll(() => {
  g.window ??= {};
  g.localStorage ??= new MemoryStorage();
});
afterAll(() => {
  connectWith(null);
  resetState();
  if (own.window) delete g.window;
  if (own.storage) delete g.localStorage;
});

const EPOCH = "lz2k3m-abcdefghijkl";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const PROJECT = "k3m7q2x4ab";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let sock: FakeSocket;

function boot() {
  resetState();
  g.localStorage = new MemoryStorage();
  sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7943/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.322", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Fix the upload", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-10-31T10:00:00.000Z", archived: false }] });
  act.open(CHAT);
  const draft = { rev: 4, text: "", mode: "chat" as const, command: null, link: false, uploads: [], by: null, at: "2026-10-31T10:00:00.000Z" };
  sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 3, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft, archived: false, replay: "snapshot" });
  sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
}
const last = <T extends ClientFrame["t"]>(t: T) => sock.sent.filter((f): f is Extract<ClientFrame, { t: T }> => f.t === t).at(-1)!;
const refuse = (rid: string) => sock.receive({ t: "ack", rid, ok: false, error: { code: "archived", message: ERROR_MESSAGES.archived } });
const drafts = () => sock.sent.filter((f) => f.t === "draft");

describe("a refused request of a link's text that was never saved keeps its link mark", () => {
  test("a /send link's message: it comes back as link text, and its draft frame says link", async () => {
    boot();
    // The composer's box: the link's pre-fill, untouched, so the store's draft is still empty.
    const box: Draft = { mode: "chat", command: null, text: "Summarize the open issues", fromLink: true };
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    act.send(CHAT, "Summarize the open issues", toInput(box));
    refuse(last("send").rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "Summarize the open issues", link: true, uploads: [] });
    expect(drafts().at(-1)).toMatchObject({ t: "draft", chat: CHAT, mode: "chat", text: "Summarize the open issues", link: true });
  });

  test("a /bash link's command: it comes back in Bash mode with its link mark, never as the user's own command", async () => {
    boot();
    const box: Draft = { mode: "bash", command: null, text: "rm -rf build", fromLink: true };
    act.bash(CHAT, "rm -rf build", toInput(box));
    refuse(last("bash").rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "bash", command: null, text: "rm -rf build", link: true, uploads: [] });
    expect(drafts().at(-1)).toMatchObject({ t: "draft", chat: CHAT, mode: "bash", text: "rm -rf build", link: true });
  });

  test("the user's own text comes back as the user's own: no link mark is made up", async () => {
    boot();
    act.bash(CHAT, "ls", toInput({ mode: "bash", command: null, text: "ls", fromLink: false }));
    refuse(last("bash").rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "bash", command: null, text: "ls", link: false, uploads: [] });
  });
});
