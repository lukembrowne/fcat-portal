import {
  fetchHabitatDashboardData,
  type HabitatDashboardData,
} from "./habitat-actions";
import {
  FilterBar,
  habitatFilter,
  type HabitatFilterOption,
} from "./habitat/filter-bar";
import { AcousticIndicesSection, dielPeriodsWithData } from "./habitat/acoustic-indices-section";
import { SpeciesSection } from "./habitat/species-section";
import { TemperatureSection } from "./habitat/temperature-section";

/**
 * Server-side data fetcher + layout for the "Por hábitat" tab. Pulls the four
 * sections' data in one composer call so React.cache lets them share the ODK
 * habitat round-trip.
 */
export async function HabitatView() {
  const result = await fetchHabitatDashboardData();
  if (!result.success) {
    return (
      <div className="rounded-md border bg-card p-6">
        <p className="text-destructive">{result.error}</p>
      </div>
    );
  }
  const data = result.data;
  const habitatOptions = collectHabitatOptions(data);
  const availableDielPeriods = dielPeriodsWithData(data.acousticIndices.groups);

  const hasAnyData =
    data.cameraSpecies.length > 0 ||
    data.audioSpecies.length > 0 ||
    data.acousticIndices.groups.length > 0 ||
    data.temperature.points.length > 0;

  if (!hasAnyData) {
    return (
      <div className="rounded-md border bg-card p-6">
        <h3 className="text-base font-semibold">Aún no hay datos</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Cuando se procesen despliegues verificados, índices acústicos o datos
          de temperatura, aparecerán aquí agrupados por hábitat.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 min-w-0">
      <FilterBar
        habitatOptions={habitatOptions}
        availableDielPeriods={availableDielPeriods}
      />
      <AcousticIndicesSection
        data={data.acousticIndices}
        habitatOptions={habitatOptions}
        availableDielPeriods={availableDielPeriods}
      />
      <SpeciesSection
        title="Cámaras trampa — riqueza por hábitat"
        description="Especies distintas detectadas en despliegues verificados, agregadas por hábitat."
        emptyMessage="No hay despliegues verificados con detecciones."
        data={data.cameraSpecies}
        habitatOptions={habitatOptions}
        idPrefix="camera"
      />
      <SpeciesSection
        title="Aves (BirdNET) — riqueza por hábitat"
        description="Especies detectadas en anotaciones verificadas de BirdNET, agregadas por hábitat."
        emptyMessage="No hay anotaciones BirdNET verificadas."
        data={data.audioSpecies}
        habitatOptions={habitatOptions}
        idPrefix="audio"
      />
      <TemperatureSection
        points={data.temperature.points}
        habitatOptions={habitatOptions}
      />
    </div>
  );
}

/**
 * Build the canonical habitat option list from data present across all four
 * sections, sorted by label with "Sin clasificar" pushed last.
 */
function collectHabitatOptions(
  data: HabitatDashboardData,
): HabitatFilterOption[] {
  const keys = new Set<string>();
  for (const r of data.cameraSpecies) keys.add(r.habitatKey);
  for (const r of data.audioSpecies) keys.add(r.habitatKey);
  for (const g of data.acousticIndices.groups) keys.add(g.habitatKey);
  for (const p of data.temperature.points) keys.add(p.habitatType);
  const options = Array.from(keys).map((k) => habitatFilter.buildOption(k));
  return options.sort((a, b) => {
    if (a.key === habitatFilter.UNKNOWN_KEY) return 1;
    if (b.key === habitatFilter.UNKNOWN_KEY) return -1;
    return a.label.localeCompare(b.label);
  });
}
