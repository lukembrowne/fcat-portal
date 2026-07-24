import { describe, it, expect } from "vitest";
import { buildBiochocoPublicNav } from "@/components/sidebar-nav";

describe("buildBiochocoPublicNav", () => {
  it("returns finca-page tools for a biochoco editor (non super-admin)", () => {
    const children = buildBiochocoPublicNav({
      isBiochocoEditor: true,
      isSuperAdmin: false,
    });
    expect(children).toEqual([
      { label: "Páginas de fincas", href: "/biochoco/paginas-publicas" },
      { label: "Fichas de especies", href: "/biochoco/fichas-especies" },
    ]);
  });

  it("returns all children in order for a super-admin", () => {
    const children = buildBiochocoPublicNav({
      isBiochocoEditor: true,
      isSuperAdmin: true,
    });
    expect(children).toEqual([
      { label: "Páginas de fincas", href: "/biochoco/paginas-publicas" },
      { label: "Fichas de especies", href: "/biochoco/fichas-especies" },
      { label: "Resumen divulgativo", href: "/admin/biochoco-overview" },
    ]);
    expect(children.map((c) => c.label)).toEqual([
      "Páginas de fincas",
      "Fichas de especies",
      "Resumen divulgativo",
    ]);
  });

  it("returns an empty array when neither flag is set", () => {
    const children = buildBiochocoPublicNav({
      isBiochocoEditor: false,
      isSuperAdmin: false,
    });
    expect(children).toEqual([]);
  });
});
