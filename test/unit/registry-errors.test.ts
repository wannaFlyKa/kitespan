// The registry passes a driver error's own code through to the ack (DESIGN.md 4.3: `no_claude`, `bad_request`,
// `unsupported`, `stale` and `not_found`), instead of answering every failure with `failed`; any other error, and a
// driver error with another code, is still `failed`. The scripted driver throws the Claude driver's own DriverError.
import { describe, expect, test } from "bun:test";
import type { RequestFrame } from "../../shared/protocol";
import { DriverError } from "../../server/agents/claude/driver";
import { DRIVER_ACK_CODES, driverErrorCode, ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();

async function liveChat() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  autoReply(driver);
  const reg = new ChatRegistry({ driver, store }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
  await reg.boot();
  const o = await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "hello", picks: { model: null, effort: null, mode: null }, uploads: [] });
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  const chat = (o.result as { chat: string }).chat;
  await settle(10);
  return { driver, store, reg, chat };
}

describe("driverErrorCode", () => {
  test("a DriverError's code passes when it is one the ack may carry; every other error is failed", () => {
    expect([...DRIVER_ACK_CODES].sort()).toEqual(["bad_request", "no_claude", "not_found", "stale", "unsupported"]);
    for (const code of DRIVER_ACK_CODES) expect(driverErrorCode(new DriverError(code as never, "x"))).toBe(code);
    expect(driverErrorCode(new DriverError("failed", "x"))).toBe("failed");
    expect(driverErrorCode(new Error("boom"))).toBe("failed");
    expect(driverErrorCode(Object.assign(new Error("ENOENT"), { code: "not_found" }))).toBe("failed");
    expect(driverErrorCode(Object.assign(new Error("x"), { name: "DriverError", code: "archived" }))).toBe("failed");
    expect(driverErrorCode("not an error")).toBe("failed");
    expect(driverErrorCode(null)).toBe("failed");
  });
});

describe("the ack carries the driver's code", () => {
  test("a live chat's call that the driver refuses: unsupported, not_found and stale reach the page; a plain error is failed", async () => {
    const { driver, reg, chat } = await liveChat();
    const live = driver.last;
    live.setMode = async () => {
      throw new DriverError("unsupported", "Bypass needs the Settings switch and a new start");
    };
    live.reconnect = async () => {
      throw new DriverError("not_found", "No such MCP server");
    };
    live.runInBackground = async () => {
      throw new DriverError("stale", "Not a task of this chat");
    };
    live.setEffort = async () => {
      throw new Error("the SDK fell over");
    };
    const frames: RequestFrame[] = [
      { t: "set_mode", rid: rid(), chat, value: "acceptEdits" },
      { t: "reconnect_mcp", rid: rid(), chat, server: "docs" },
      { t: "background", rid: rid(), chat, toolUse: "toolu_1" },
      { t: "set_effort", rid: rid(), chat, value: "high" },
    ];
    const codes = [];
    for (const f of frames) {
      const o = await apply(reg, f);
      codes.push(o.ok ? "ok" : o.code);
    }
    expect(codes).toEqual(["unsupported", "not_found", "stale", "failed"]);
    await reg.shutdown();
  });

  test("rename and Continue here: the driver's code when the transcript exists, and its reading of the session", async () => {
    const { driver, reg, chat } = await liveChat();
    driver.rename = async () => {
      throw new DriverError("bad_request", "A title has 1 to 120 characters");
    };
    // The chat's Claude Code took the name, so it keeps it and writes it itself: the rename stands.
    expect(await apply(reg, { t: "rename", rid: rid(), chat, title: "A new name" })).toEqual({ ok: true, result: null });
    // It has no way to take one: the transcript's refusal is the answer.
    driver.last.renameTaken = false;
    const renamed = await apply(reg, { t: "rename", rid: rid(), chat, title: "Another name" });
    expect(renamed.ok ? "ok" : renamed.code).toBe("bad_request");
    driver.sessionInfo = async () => {
      throw new DriverError("no_claude", "No usable claude on PATH");
    };
    const cont = await apply(reg, { t: "continue_session", rid: rid(), project: PROJECT, session: "7c9e6679-7425-40de-944b-e07fc1f90ae7" });
    expect(cont.ok ? "ok" : cont.code).toBe("no_claude");
    await reg.shutdown();
  });

  test("a delete whose transcript removal the driver refuses keeps the chat and says why", async () => {
    const { driver, reg, chat } = await liveChat();
    driver.deleteSession = async () => {
      throw new DriverError("unsupported", "deleteSession is not available");
    };
    const o = await apply(reg, { t: "delete", rid: rid(), chat });
    expect(o.ok ? "ok" : o.code).toBe("unsupported");
    expect(reg.has(chat)).toBe(true);
    await reg.shutdown();
  });
});
