import { describe, it, expect } from "vitest";

import { buildAudioNav } from "../sidebar-nav";

const hrefs = (items: ReturnType<typeof buildAudioNav>) => items.map((i) => i.href);

describe("buildAudioNav", () => {
  it("includes the validation page for a grabaciones editor", () => {
    expect(hrefs(buildAudioNav({ isGrabacionesEditor: true }))).toContain(
      "/audio/validacion"
    );
  });

  it("omits the validation page for a viewer", () => {
    // Viewers cannot create campaigns, draw samples, or review — the page would
    // be read-only scaffolding.
    expect(hrefs(buildAudioNav({ isGrabacionesEditor: false }))).not.toContain(
      "/audio/validacion"
    );
  });

  it("keeps the existing entries for both roles", () => {
    for (const isGrabacionesEditor of [true, false]) {
      const items = hrefs(buildAudioNav({ isGrabacionesEditor }));
      expect(items).toContain("/audio");
      expect(items).toContain("/audio/species");
    }
  });

  it("puts validation last so existing muscle memory is undisturbed", () => {
    const items = buildAudioNav({ isGrabacionesEditor: true });
    expect(items.at(-1)?.href).toBe("/audio/validacion");
  });

  it("labels the entry in Spanish, per the project UI convention", () => {
    const entry = buildAudioNav({ isGrabacionesEditor: true }).at(-1);
    expect(entry?.label).toBe("Validación de umbrales");
  });
});
