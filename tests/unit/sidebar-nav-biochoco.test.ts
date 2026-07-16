import { describe, it, expect } from "vitest";
import { buildBiochocoPublicNav } from "@/components/sidebar-nav";

describe("buildBiochocoPublicNav", () => {
  it("returns only 'Páginas de fincas' for a biochoco editor (non super-admin)", () => {
    const children = buildBiochocoPublicNav({
      isBiochocoEditor: true,
      isSuperAdmin: false,
    });
    expect(children).toEqual([
      { label: "Páginas de fincas", href: "/biochoco/paginas-publicas" },
    ]);
  });

  it("returns both children in order for a super-admin", () => {
    const children = buildBiochocoPublicNav({
      isBiochocoEditor: true,
      isSuperAdmin: true,
    });
    expect(children).toEqual([
      { label: "Páginas de fincas", href: "/biochoco/paginas-publicas" },
      { label: "Resumen divulgativo", href: "/admin/biochoco-overview" },
    ]);
    expect(children.map((c) => c.label)).toEqual([
      "Páginas de fincas",
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
