import { SubNav } from "@/components/sub-nav";

const GIZ_TABS = [
  { href: "/giz/tree-planting", label: "Siembra de Árboles" },
  { href: "/giz/cacao-monitoring", label: "Monitoreo de Cacao" },
];

export default function GizLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <SubNav items={GIZ_TABS} />
      {children}
    </div>
  );
}
