import { describe, it, expect } from "vitest";
import {
  deriveSitePageStatus,
  STATUS_RANK,
} from "@/lib/landowner/page-status";

describe("deriveSitePageStatus", () => {
  it("no active token → sin_empezar, not personalized, no viewedAt", () => {
    const status = deriveSitePageStatus({
      hasActiveToken: false,
      lastViewedAt: null,
      pageConfig: null,
    });
    expect(status).toEqual({
      key: "sin_empezar",
      personalized: false,
      viewedAt: null,
    });
  });

  it("active token, no views, pageConfig null → publicado, not personalized", () => {
    const status = deriveSitePageStatus({
      hasActiveToken: true,
      lastViewedAt: null,
      pageConfig: null,
    });
    expect(status).toEqual({
      key: "publicado",
      personalized: false,
      viewedAt: null,
    });
  });

  it("active token, no views, pageConfig set → publicado, personalized", () => {
    const status = deriveSitePageStatus({
      hasActiveToken: true,
      lastViewedAt: null,
      pageConfig: '{"version":1,"blocks":[]}',
    });
    expect(status).toEqual({
      key: "publicado",
      personalized: true,
      viewedAt: null,
    });
  });

  it("active token + lastViewedAt set → visto, carries the date, personalized reflects pageConfig", () => {
    const viewed = new Date("2026-07-10T12:00:00Z");
    const status = deriveSitePageStatus({
      hasActiveToken: true,
      lastViewedAt: viewed,
      pageConfig: '{"version":1,"blocks":[]}',
    });
    expect(status.key).toBe("visto");
    expect(status.viewedAt).toBe(viewed);
    expect(status.personalized).toBe(true);
  });

  it("active token + lastViewedAt set, pageConfig null → visto, not personalized", () => {
    const viewed = new Date("2026-07-10T12:00:00Z");
    const status = deriveSitePageStatus({
      hasActiveToken: true,
      lastViewedAt: viewed,
      pageConfig: null,
    });
    expect(status.key).toBe("visto");
    expect(status.viewedAt).toBe(viewed);
    expect(status.personalized).toBe(false);
  });

  it("revoked-only (hasActiveToken false) → sin_empezar regardless of other fields", () => {
    const status = deriveSitePageStatus({
      hasActiveToken: false,
      lastViewedAt: new Date("2026-07-10T12:00:00Z"),
      pageConfig: '{"version":1,"blocks":[]}',
    });
    expect(status).toEqual({
      key: "sin_empezar",
      personalized: false,
      viewedAt: null,
    });
  });

  it("STATUS_RANK orders sin_empezar < publicado < visto", () => {
    expect(STATUS_RANK.sin_empezar).toBeLessThan(STATUS_RANK.publicado);
    expect(STATUS_RANK.publicado).toBeLessThan(STATUS_RANK.visto);
  });
});
