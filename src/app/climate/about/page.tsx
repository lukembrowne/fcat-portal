import { requirePermission } from "@/lib/auth";
import { AboutContent } from "./about-content";

export default async function ClimateAboutPage() {
  await requirePermission("climate", "viewer");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Acerca de los Datos Climáticos</h1>
        <p className="text-muted-foreground mt-1">
          Información sobre la estación, metodología y cómo citar los datos
        </p>
      </div>
      <AboutContent />
    </div>
  );
}
