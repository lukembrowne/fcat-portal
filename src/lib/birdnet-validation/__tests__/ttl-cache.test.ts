import { describe, expect, it, vi } from "vitest";

import { createTtlCache, projectScopeKey } from "../ttl-cache";

describe("createTtlCache", () => {
  it("computes once per key within the TTL", () => {
    let t = 0;
    const cache = createTtlCache<number>(1000, () => t);
    const compute = vi.fn(() => 42);

    expect(cache.get("all", compute)).toBe(42);
    t = 999;
    expect(cache.get("all", compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes after the TTL expires", () => {
    let t = 0;
    const cache = createTtlCache<number>(1000, () => t);
    let n = 0;
    const compute = () => ++n;

    expect(cache.get("all", compute)).toBe(1);
    t = 1000;
    expect(cache.get("all", compute)).toBe(2);
  });

  it("keeps separate entries per key", () => {
    const cache = createTtlCache<string>(1000, () => 0);
    expect(cache.get("1,2", () => "a")).toBe("a");
    expect(cache.get("all", () => "b")).toBe("b");
    expect(cache.get("1,2", () => "c")).toBe("a");
  });

  it("clear() drops every entry", () => {
    const cache = createTtlCache<string>(1000, () => 0);
    cache.get("all", () => "a");
    cache.clear();
    expect(cache.get("all", () => "b")).toBe("b");
  });
});

describe("projectScopeKey", () => {
  it("is order-independent over project ids", () => {
    expect(projectScopeKey([3, 1, 2])).toBe(projectScopeKey([1, 2, 3]));
    expect(projectScopeKey([1, 2, 3])).toBe("1,2,3");
  });

  it("distinguishes 'all' from no projects", () => {
    expect(projectScopeKey("all")).toBe("all");
    expect(projectScopeKey([])).toBe("none");
  });

  it("does not sort ids as strings", () => {
    expect(projectScopeKey([10, 9])).toBe("9,10");
  });
});
