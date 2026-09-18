import { describe, it, expect } from "vitest";

import { buildAudioNav } from "../sidebar-nav";

const hrefs = (items: ReturnType<typeof buildAudioNav>) => items.map((i) => i.href);

describe("buildAudioNav", () => {
  it("shows the validation page to everyone with grabaciones access", () => {
    // Reviewing is a viewer capability, and a reviewer who cannot find the page
    // cannot review. The whole Grabaciones group is already gated on project
    // access, so there is nothing further to gate here.
    expect(hrefs(buildAudioNav())).toContain("/audio/validacion");
  });

  it("keeps the existing entries", () => {
    const items = hrefs(buildAudioNav());
    expect(items).toContain("/audio");
    expect(items).toContain("/audio/species");
  });

  it("puts validation last so existing muscle memory is undisturbed", () => {
    expect(buildAudioNav().at(-1)?.href).toBe("/audio/validacion");
  });

  it("labels the entry in Spanish, per the project UI convention", () => {
    expect(buildAudioNav().at(-1)?.label).toBe("Validación de umbrales");
  });
});
