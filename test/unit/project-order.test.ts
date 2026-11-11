// Row 99: the sidebar's order of the environments (server/store/order.ts). Until the user moves one, the last used comes
// first, exactly as before; after a move, the user's order, with a project added later at the top.

import { describe, expect, test } from "bun:test";
import { movedOrder, projectOrder, topOrder } from "../../server/store/order";
import type { ProjectRecord } from "../../server/store/types";

const ids = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"] as const;
const project = (i: number, lastUsedAt: string, over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: ids[i]!,
  cwd: `/srv/work/app${i}`,
  name: `app${i}`,
  createdAt: "2026-11-01T00:00:00.000Z",
  lastUsedAt,
  picks: { model: null, effort: null, permissionMode: null },
  ...over,
});
const order = (list: readonly ProjectRecord[]) => projectOrder(list).map((p) => p.id);

describe("projectOrder", () => {
  test("with no order anywhere: the last used first, as before row 99", () => {
    const list = [project(0, "2026-11-01T09:00:00.000Z"), project(1, "2026-11-02T09:00:00.000Z"), project(2, "2026-11-01T10:00:00.000Z")];
    expect(order(list)).toEqual([ids[1], ids[2], ids[0]]);
    // The list it was given is left as it was.
    expect(list.map((p) => p.id)).toEqual([ids[0], ids[1], ids[2]]);
  });

  test("with an order: the user's order, whatever was used last", () => {
    const list = [project(0, "2026-11-03T09:00:00.000Z", { order: 2 }), project(1, "2026-11-01T09:00:00.000Z", { order: 0 }), project(2, "2026-11-02T09:00:00.000Z", { order: 1 })];
    expect(order(list)).toEqual([ids[1], ids[2], ids[0]]);
  });

  test("a project with no order among ordered ones goes at the top, the newest added first", () => {
    const list = [
      project(0, "2026-11-01T09:00:00.000Z", { order: 0 }),
      project(1, "2026-11-01T09:00:00.000Z", { createdAt: "2026-11-02T00:00:00.000Z" }),
      project(2, "2026-11-01T09:00:00.000Z", { createdAt: "2026-11-03T00:00:00.000Z" }),
      project(3, "2026-11-01T09:00:00.000Z", { order: 1 }),
    ];
    expect(order(list)).toEqual([ids[2], ids[1], ids[0], ids[3]]);
  });
});

describe("topOrder: a project added now", () => {
  test("no order yet: none (the last used order puts it first anyway)", () => {
    expect(topOrder([project(0, "2026-11-01T09:00:00.000Z")])).toEqual({});
    expect(topOrder([])).toEqual({});
  });
  test("an order: one above the top", () => {
    expect(topOrder([project(0, "x", { order: 3 }), project(1, "x", { order: -1 })])).toEqual({ order: -2 });
  });
});

describe("movedOrder: one move", () => {
  const today = [project(0, "2026-11-01T09:00:00.000Z"), project(1, "2026-11-03T09:00:00.000Z"), project(2, "2026-11-02T09:00:00.000Z")];
  // Shown now: 1, 2, 0.
  test("the first move numbers every project in the order shown, with the one moved in its new place", () => {
    const moved = movedOrder(today, ids[0]!, ids[1]!)!;
    expect(moved.map((p) => [p.id, p.order])).toEqual([
      [ids[0], 0],
      [ids[1], 1],
      [ids[2], 2],
    ]);
  });
  test("before null puts it at the end; moving up and down by one", () => {
    expect(movedOrder(today, ids[1]!, null)!.map((p) => p.id)).toEqual([ids[2], ids[0], ids[1]]);
    // Move down: before the one two below; Move up: before the one above.
    expect(movedOrder(today, ids[1]!, ids[0]!)!.map((p) => p.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(movedOrder(today, ids[0]!, ids[2]!)!.map((p) => p.id)).toEqual([ids[1], ids[0], ids[2]]);
  });
  test("the other fields stay as they were", () => {
    const moved = movedOrder(today, ids[2]!, ids[1]!)!;
    expect(moved.find((p) => p.id === ids[2])).toEqual({ ...today[2]!, order: 0 });
  });
  test("an unknown project, an unknown place, or a place that is itself: null", () => {
    expect(movedOrder(today, "zzzzzzzzzz", null)).toBeNull();
    expect(movedOrder(today, ids[0]!, "zzzzzzzzzz")).toBeNull();
    expect(movedOrder(today, ids[0]!, ids[0]!)).toBeNull();
  });
});
