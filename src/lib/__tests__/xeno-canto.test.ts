import { describe, it, expect } from "vitest";

import { xenoCantoUrl } from "../xeno-canto";

describe("xenoCantoUrl", () => {
  it("builds the species path from a scientific name", () => {
    expect(xenoCantoUrl("Ramphastos ambiguus")).toBe(
      "https://xeno-canto.org/species/Ramphastos-ambiguus"
    );
  });

  it("keeps the capitalised genus", () => {
    // Not `speciesSlug`, which lowercases for internal routing — xeno-canto's
    // own paths are capitalised and a lowercased one 404s.
    expect(xenoCantoUrl("Cephalopterus penduliger")).toContain("/Cephalopterus-");
  });

  it("collapses stray whitespace rather than emitting a double hyphen", () => {
    expect(xenoCantoUrl("  Attila   torridus ")).toBe(
      "https://xeno-canto.org/species/Attila-torridus"
    );
  });

  it("handles a trinomial", () => {
    expect(xenoCantoUrl("Ortalis erythroptera columbiana")).toBe(
      "https://xeno-canto.org/species/Ortalis-erythroptera-columbiana"
    );
  });

  it("escapes a name that would otherwise break the path", () => {
    // Names arrive from a database and a paste box, not a controlled list.
    expect(xenoCantoUrl("Genus sp/nov")).not.toContain("sp/nov");
  });
});
