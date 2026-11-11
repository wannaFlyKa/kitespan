// The app-drawn pickers' rules (DESIGN-B1 4.5, PAGE 6 and 17): the select list's keys (Up, Down, Home, End, type to
// find, disabled options skipped), the date grid's keys (a day, a week, a month, a year with Shift, the week's ends),
// the month grid with the locale's first day, ISO weeks, the value forms each kind sets (shared/browser.ts
// pickValueOk), min and max, and where a picker sits against its control.
import { describe, expect, test } from "bun:test";
import { pickValueOk } from "../../shared/browser";
import { dateKey, inRange, isoWeekOf, monthGrid, placePicker, selectKey, typeToFind, valueFor } from "../../web/browser/pickRules";

const ITEMS = [
  { group: null, label: "Ridge Loop", disabled: false, index: 0 },
  { group: null, label: "Beacon Hill at sunrise", disabled: false, index: 1 },
  { group: "Hard", label: "Three Tarns", disabled: false, index: 2 },
  { group: "Hard", label: "Winter traverse (full)", disabled: true, index: 3 },
  { group: "Hard", label: "Tarn Edge", disabled: false, index: 4 },
];

describe("the select list's keys", () => {
  test("Down and Up skip a disabled option and stop at the ends", () => {
    expect(selectKey("ArrowDown", 2, ITEMS)).toBe(4);
    expect(selectKey("ArrowUp", 4, ITEMS)).toBe(2);
    expect(selectKey("ArrowUp", 0, ITEMS)).toBe(0);
    expect(selectKey("ArrowDown", 4, ITEMS)).toBe(4);
  });
  test("Home and End go to the first and last option that can be picked", () => {
    expect(selectKey("Home", 3, ITEMS)).toBe(0);
    expect(selectKey("End", 0, ITEMS)).toBe(4);
    expect(selectKey("x", 0, ITEMS)).toBeNull();
  });
  test("type to find: the next label that starts with the typed text", () => {
    expect(typeToFind("t", 0, ITEMS)).toBe(2);
    expect(typeToFind("t", 2, ITEMS)).toBe(4);
    expect(typeToFind("ta", 2, ITEMS)).toBe(4);
    expect(typeToFind("w", 0, ITEMS)).toBeNull();
  });
});

describe("the date grid", () => {
  test("arrows by a day and a week, Page Up and Down by a month, with Shift a year, Home and End the week's ends", () => {
    expect(dateKey("ArrowRight", "2026-11-30", false, 1)).toBe("2026-12-01");
    expect(dateKey("ArrowLeft", "2026-11-01", false, 1)).toBe("2026-10-31");
    expect(dateKey("ArrowDown", "2026-11-14", false, 1)).toBe("2026-11-21");
    expect(dateKey("ArrowUp", "2026-11-14", false, 1)).toBe("2026-11-07");
    expect(dateKey("PageDown", "2026-01-31", false, 1)).toBe("2026-02-28");
    expect(dateKey("PageUp", "2026-11-14", true, 1)).toBe("2025-11-14");
    // 14 November 2026 is a Saturday; with Monday first the week runs 9 to 15.
    expect(dateKey("Home", "2026-11-14", false, 1)).toBe("2026-11-09");
    expect(dateKey("End", "2026-11-14", false, 1)).toBe("2026-11-15");
    // With Sunday first: 8 to 14.
    expect(dateKey("Home", "2026-11-14", false, 0)).toBe("2026-11-08");
    expect(dateKey("Tab", "2026-11-14", false, 1)).toBeNull();
  });
  test("a month's grid: blanks before the first day by the locale's first day of the week", () => {
    const g = monthGrid(2026, 10, 1); // November 2026, Monday first: 1 November is a Sunday
    expect(g.slice(0, 7)).toEqual([null, null, null, null, null, null, "2026-11-01"]);
    expect(g.filter(Boolean).length).toBe(30);
    expect(g.length % 7).toBe(0);
    expect(monthGrid(2026, 10, 0)[0]).toBe("2026-11-01");
  });
  test("min and max", () => {
    expect(inRange("2026-11-09", "2026-11-10", null)).toBe(false);
    expect(inRange("2026-11-10", "2026-11-10", "2026-12-01")).toBe(true);
    expect(inRange("2026-12-02", null, "2026-12-01")).toBe(false);
  });
  test("ISO weeks", () => {
    expect(isoWeekOf("2026-11-14")).toBe("2026-W46");
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
    expect(isoWeekOf("2024-12-30")).toBe("2025-W01");
  });
});

describe("the value each kind sets", () => {
  test("each form passes the shared check", () => {
    const cases: [Parameters<typeof valueFor>[0], Parameters<typeof valueFor>[1], string][] = [
      ["date", { day: "2026-11-14" }, "2026-11-14"],
      ["datetime-local", { day: "2026-11-14", time: "07:30" }, "2026-11-14T07:30"],
      ["month", { day: "2026-11-14" }, "2026-11"],
      ["week", { day: "2026-11-14" }, "2026-W46"],
      ["time", { time: "07:30" }, "07:30"],
      ["color", { color: "#2F6B4F" }, "#2f6b4f"],
    ];
    for (const [kind, parts, want] of cases) {
      expect(valueFor(kind, parts)).toBe(want);
      expect(pickValueOk(kind, want)).toBe(true);
    }
  });
  test("Clear sets a date-like field empty; a colour is never empty", () => {
    expect(valueFor("date", {})).toBe("");
    expect(pickValueOk("date", "")).toBe(true);
    expect(valueFor("color", { color: "red" })).toBeNull();
  });
});

describe("where a picker sits (PAGE 6)", () => {
  test("below its control at its left edge, as wide as it for a select", () => {
    expect(placePicker({ x: 100, y: 50, w: 120, h: 30 }, { w: 600, h: 500 }, { w: 120, h: 160 })).toEqual({ left: 100, top: 84 });
  });
  test("above it when the room below is short", () => {
    expect(placePicker({ x: 100, y: 400, w: 120, h: 30 }, { w: 600, h: 500 }, { w: 200, h: 300 })).toEqual({ left: 100, top: 96 });
  });
  test("never past the stage's edges", () => {
    expect(placePicker({ x: 550, y: 50, w: 40, h: 20 }, { w: 600, h: 500 }, { w: 220, h: 100 })).toEqual({ left: 372, top: 74 });
    expect(placePicker({ x: -30, y: 200, w: 40, h: 20 }, { w: 600, h: 300 }, { w: 220, h: 290 }).left).toBe(8);
  });
});
