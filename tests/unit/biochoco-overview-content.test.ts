import { describe, it, expect } from "vitest";
import { CONTENT } from "@/app/public/biochoco-overview/content";

/** Recursively collect the key-path shape of an object (ignoring array contents). */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe("bilingual content parity", () => {
  it("en and es expose the same key shape (no missing translations)", () => {
    expect(keyPaths(CONTENT.en)).toEqual(keyPaths(CONTENT.es));
  });

  it("nested lists have matching lengths across languages", () => {
    const { en, es } = CONTENT;
    expect(en.learn.objectives.length).toBe(4);
    expect(es.learn.objectives.length).toBe(4);
    expect(en.methods.cards.length).toBe(4);
    expect(es.methods.cards.length).toBe(4);
    expect(en.stats.tiles.length).toBe(8);
    expect(es.stats.tiles.length).toBe(8);
    expect(en.platform.gallery.length).toBe(4);
    expect(es.platform.gallery.length).toBe(4);
    expect(en.collaborate.oppList.length).toBe(7);
    expect(es.collaborate.oppList.length).toBe(7);
    expect(en.contacts.length).toBe(10);
    expect(es.contacts.length).toBe(10);
    expect(en.acknowledgements.groups.length).toBe(2);
    expect(es.acknowledgements.groups.length).toBe(2);
  });

  it("pins the section headlines (guards against accidental copy drift)", () => {
    const { en } = CONTENT;
    expect(en.hero.title).toBe("BioChocó");
    expect(en.learn.heading).toBe("Objectives");
    expect(en.methods.heading).toBe("How each biodiversity monitoring station works");
    expect(en.stats.heading).toBe("Where the network stands today");
    expect(en.map.heading).toBe("Where we are working");
    expect(en.species.heading).toBe("Species detections");
    expect(en.platform.heading).toBe("An integrated end-to-end platform");
    expect(en.collaborate.heading).toBe("Where collaborators come in");
    expect(en.acknowledgements.heading).toBe("Funders and acknowledgements");
  });

  it("template strings carry the placeholders the shell interpolates", () => {
    for (const lang of ["en", "es"] as const) {
      const c = CONTENT[lang];
      expect(c.hero.liveDate).toContain("{date}");
      // spanLine and note may be intentionally blank per language; when present
      // they must carry the tokens the shell interpolates.
      if (c.stats.spanLine) expect(c.stats.spanLine).toContain("{span}");
      if (c.stats.note) {
        expect(c.stats.note).toContain("{deploymentCount}");
        expect(c.stats.note).toContain("{retrievedCount}");
        expect(c.stats.note).toContain("{inField}");
      }
      expect(c.species.camCap).toContain("{n}");
      expect(c.species.audCap).toContain("{n}");
      expect(c.footer.date).toContain("{date}");
    }
    // The eight stat-tile subs reference the expected snapshot tokens.
    const subs = CONTENT.en.stats.tiles.map((t) => t.sub).join(" ");
    for (const token of ["{cam}", "{audio}", "{climate}", "{span}", "{mammals}", "{birds}", "{tb}", "{loggers}", "{conf}"]) {
      expect(subs).toContain(token);
    }
  });

  it("keeps the same real contacts (name + email) across languages, with translated roles", () => {
    const { en, es } = CONTENT;
    expect(en.contacts.map((c) => ({ name: c.name, email: c.email }))).toEqual(
      es.contacts.map((c) => ({ name: c.name, email: c.email })),
    );
    expect(en.contacts.map((c) => c.role)).toEqual([
      "Monitoring lead",
      "FCAT Reserve Director",
      "FCAT co-founder",
      "Program Director",
      "Field Coordinator",
      "Field Coordinator",
      "Local biologist (FCATero)",
      "Local biologist (FCATera)",
      "Local biologist (FCATero)",
      "Local biologist (FCATero)",
    ]);
    // Field-team members are listed without an email; every contact that has
    // one uses the org domain.
    expect(
      en.contacts.filter((c) => c.email).every((c) => c.email!.endsWith("@fcat-ecuador.org")),
    ).toBe(true);
  });
});

describe("acknowledgements", () => {
  it("has matching per-group entry counts across languages", () => {
    const { en, es } = CONTENT;
    expect(en.acknowledgements.groups.map((g) => g.entries.length)).toEqual(
      es.acknowledgements.groups.map((g) => g.entries.length),
    );
    // Funders group carries three entries; institutional support carries one.
    expect(en.acknowledgements.groups.map((g) => g.entries.length)).toEqual([3, 1]);
  });

  it("names the three funders in both languages", () => {
    for (const lang of ["en", "es"] as const) {
      const funders = CONTENT[lang].acknowledgements.groups[0].entries.map((e) => e.name);
      expect(funders).toContain("Wedgetail Foundation");
      expect(funders).toContain("National Science Foundation");
      expect(funders).toHaveLength(3);
    }
  });

  it("keeps MAATE out of the funders group — it supports and permits, it does not fund", () => {
    for (const lang of ["en", "es"] as const) {
      const [funders, support] = CONTENT[lang].acknowledgements.groups;
      expect(funders.entries.some((e) => e.name.includes("MAATE"))).toBe(false);
      expect(support.entries.some((e) => e.name.includes("MAATE"))).toBe(true);
    }
  });
});
