// /p/<project>/environment (D60, L41; DESIGN 9.4 "URLs added"): the project's editor for its Worktree option and its
// variables. `name` only marks one variable's row; the route has no key that could carry a value, and the decoder
// ignores every other key, so a link with ?value= or ?API_KEY= fills nothing.
import { describe, expect, test } from "bun:test";
import { ENV_NAME, ROUTE_BY_NAME, href, isAppPath, parse, routePattern } from "../../shared/route";

const P = "k3m7q2x4ab";
const at = (u: string) => parse(new URL(u, "http://127.0.0.1:7943"));

describe("the environment editor's route", () => {
  test("it is beside the project page, and its example opens it", () => {
    const def = ROUTE_BY_NAME.projectEnvironment!;
    expect(def.path).toBe("/p/:project/environment");
    expect(def.milestone).toBe("v0.4 resume");
    const r = at(def.example);
    expect(r.name).toBe("projectEnvironment");
    expect(r.params).toEqual({ project: P });
    expect(r.fallbackFrom).toBeUndefined();
    expect(isAppPath(`/p/${P}/environment`)).toBe(true);
    expect(routePattern(`/p/${P}/environment`)).toBe("/p/:project/environment");
  });

  test("name marks a row: a variable's name only, at most 128 characters", () => {
    expect(at(`/p/${P}/environment?name=API_TIMEOUT_MS`).query).toEqual({ name: "API_TIMEOUT_MS" });
    expect(at(`/p/${P}/environment?name=_x9`).query).toEqual({ name: "_x9" });
    expect(at(`/p/${P}/environment?name=${"A".repeat(128)}`).query.name).toBe("A".repeat(128));
    for (const bad of ["9LIVES", "A-B", "A%3DB", "A%20B", "", "A".repeat(129), "%E2%80%A2"]) {
      const r = at(`/p/${P}/environment?name=${bad}`);
      expect(r.name).toBe("projectEnvironment");
      expect(r.query).toEqual({});
      expect(r.dropped).toBe(true);
    }
    expect(ENV_NAME.test("PATH")).toBe(true);
    expect(ENV_NAME.test("a=b")).toBe(false);
  });

  test("no key fills a value: value, a variable's own name and the rest are ignored", () => {
    const r = at(`/p/${P}/environment?value=secret&API_KEY=secret&set=X%3D1&name=API_KEY`);
    expect(r.query).toEqual({ name: "API_KEY" });
    expect(r.dropped).toBeUndefined();
    expect(Object.keys(ROUTE_BY_NAME.projectEnvironment!.query)).toEqual(["name"]);
  });

  test("a bad project or a deeper path falls back; the encoder writes the canonical URL", () => {
    expect(at("/p/k3m7q2x9ab/environment").name).toBe("home"); // 9 is not in [a-z2-7]
    const deeper = at(`/p/${P}/environment/extra`);
    expect(deeper.name).toBe("projectEnvironment");
    expect(deeper.fallbackFrom).toBe(`/p/${P}/environment/extra`);
    expect(at(`/p/${P}/environments`).name).toBe("project");
    expect(href("projectEnvironment", { project: P })).toBe(`/p/${P}/environment`);
    expect(href("projectEnvironment", { project: P }, { name: "API_KEY" })).toBe(`/p/${P}/environment?name=API_KEY`);
  });
});
