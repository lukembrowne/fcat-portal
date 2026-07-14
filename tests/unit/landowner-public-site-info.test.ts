import { describe, it, expect } from "vitest";
import { toPublicSiteInfo } from "@/lib/landowner/public-site-info";
import type { SiteInfo } from "@/app/biochoco/overview/types";

const fullSite: SiteInfo = {
  uuid: "entity-uuid-123",
  siteId: "SEC-006",
  siteName: "Finca La Esperanza",
  habitatType: "primary_forest",
  lat: -0.123456,
  lng: -79.123456,
  habitatAssessed: "yes",
  landownerName: "María Pérez",
  landownerPhone: "+593999999999",
  notes: "Confidential internal note",
};

describe("toPublicSiteInfo", () => {
  it("keeps only the public-safe fields", () => {
    expect(toPublicSiteInfo(fullSite)).toEqual({
      siteId: "SEC-006",
      siteName: "Finca La Esperanza",
      habitatType: "primary_forest",
      habitatAssessed: "yes",
    });
  });

  it("never leaks landowner identity", () => {
    const result = toPublicSiteInfo(fullSite);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("María Pérez");
    expect(serialized).not.toContain("+593999999999");
    expect(result).not.toHaveProperty("landownerName");
    expect(result).not.toHaveProperty("landownerPhone");
  });

  it("never leaks GPS, uuid, or notes", () => {
    const result = toPublicSiteInfo(fullSite);
    expect(result).not.toHaveProperty("lat");
    expect(result).not.toHaveProperty("lng");
    expect(result).not.toHaveProperty("uuid");
    expect(result).not.toHaveProperty("notes");
  });

  it("passes null through", () => {
    expect(toPublicSiteInfo(null)).toBeNull();
  });
});
