// The chat socket's handlers fit the HTTP layer's mount for /ws (a compile-time check of the seam between the two).
import { expect, test } from "bun:test";
import type { SocketHandlers } from "../../server/http/app";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore } from "../../server/chats/testing";
import { wsHandlers } from "../../server/ws/handlers";

test("wsHandlers(registry) is a SocketHandlers for WIRE.path", () => {
  const hub = wsHandlers(new ChatRegistry({ driver: new FakeDriver(), store: new MemoryStore() }));
  const mount: SocketHandlers = hub;
  expect(typeof mount.open).toBe("function");
  expect(typeof mount.drain).toBe("function");
  hub.dispose();
});
