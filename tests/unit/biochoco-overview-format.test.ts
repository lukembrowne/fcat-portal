import { describe, it, expect } from "vitest";
import { fmt, tpl, spanLabel } from "@/app/public/biochoco-overview/lib/format";

describe("report format helpers", () => {
  describe("fmt", () => {
    it("thousands-separates with en-US grouping", () => {
      expect(fmt(16632)).toBe("16,632");
      expect(fmt(0)).toBe("0");
    });
  });

  describe("tpl", () => {
    it("interpolates known tokens", () => {
      expect(tpl("{a} of {b}", { a: 3, b: "ten" })).toBe("3 of ten");
    });
    it("leaves unknown tokens intact", () => {
      expect(tpl("hi {who}", {})).toBe("hi {who}");
    });
    it("replaces every occurrence", () => {
      expect(tpl("{x}-{x}", { x: 1 })).toBe("1-1");
    });
  });

  describe("spanLabel", () => {
    it("formats a start–end month/year span", () => {
      expect(spanLabel("2026-01-21", "2026-07-10", "en")).toBe("Jan 2026 – Jul 2026");
    });
    it("drops a missing end (sensor still in field)", () => {
      expect(spanLabel("2026-01-21", null, "en")).toBe("Jan 2026");
    });
    it("returns empty when both are missing", () => {
      expect(spanLabel(null, null, "en")).toBe("");
    });
  });
});
