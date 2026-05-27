"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search } from "lucide-react";
import type { ScheduleRow } from "@/lib/schedule-types";
import { commitDateEdit, commitInlineSwap, previewInlineSwap, updateSiteEntity, type InlineSwapPreview } from "./actions";
import { getHabitatName, HABITAT_NAMES, type SiteInfo } from "./types";

interface Props {
  self: ScheduleRow;
  candidates: ScheduleRow[];
  /** The ODK site entity for `self.siteId` — enables the "Editar sitio" section. */
  site: SiteInfo | null;
  /** Dates/swap are editable only for future (scheduled) deployments. The name is always editable. */
  canEditDates: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A coordinate input matches the original if both blank or numerically equal. */
function coordUnchanged(input: string, original: number | null): boolean {
  const t = input.trim();
  if (t === "") return original == null;
  return original != null && parseFloat(t) === original;
}

type DialogState =
  | { mode: "idle" }
  | { mode: "swap-preview"; preview: InlineSwapPreview };

const TODAY_ISO = new Date().toISOString().slice(0, 10);

function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function InlineScheduleEditorDialog({ self, candidates, site, canEditDates, open, onOpenChange }: Props) {
  const router = useRouter();
  const [state, setState] = useState<DialogState>({ mode: "idle" });
  const [dateInput, setDateInput] = useState(self.plannedDeployDate ?? "");
  const [selectedSwapId, setSelectedSwapId] = useState<string | null>(null);
  const [habitatOnly, setHabitatOnly] = useState(true);
  const [candidateFilter, setCandidateFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();

  // ───── Site entity edit state (prefilled from the page-load site values) ─────
  const [siteName, setSiteName] = useState(site?.siteName ?? "");
  const [siteLat, setSiteLat] = useState(site?.lat != null ? String(site.lat) : "");
  const [siteLng, setSiteLng] = useState(site?.lng != null ? String(site.lng) : "");
  const [siteHabitat, setSiteHabitat] = useState(site?.habitatType ?? "");
  const [siteLandownerName, setSiteLandownerName] = useState(site?.landownerName ?? "");
  const [siteLandownerPhone, setSiteLandownerPhone] = useState(site?.landownerPhone ?? "");
  const [siteNotes, setSiteNotes] = useState(site?.notes ?? "");

  const siteChanged = useMemo(() => {
    if (!site) return false;
    return (
      siteName.trim() !== (site.siteName ?? "").trim() ||
      siteHabitat !== (site.habitatType ?? "") ||
      !coordUnchanged(siteLat, site.lat) ||
      !coordUnchanged(siteLng, site.lng) ||
      siteLandownerName.trim() !== (site.landownerName ?? "").trim() ||
      siteLandownerPhone.trim() !== (site.landownerPhone ?? "").trim() ||
      siteNotes.trim() !== (site.notes ?? "").trim()
    );
  }, [site, siteName, siteHabitat, siteLat, siteLng, siteLandownerName, siteLandownerPhone, siteNotes]);

  const filtered = useMemo(() => {
    const q = candidateFilter.toLowerCase();
    return candidates
      .filter((c) => c.deploymentId !== self.deploymentId)
      .filter((c) => c.status === "scheduled")
      .filter((c) => {
        if (habitatOnly && c.habitatType !== self.habitatType) return false;
        if (
          q &&
          !c.deploymentId.toLowerCase().includes(q) &&
          !c.siteName.toLowerCase().includes(q)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => (a.plannedDeployDate ?? "").localeCompare(b.plannedDeployDate ?? ""));
  }, [candidates, candidateFilter, habitatOnly, self.deploymentId, self.habitatType]);

  const newRetrievePreview = useMemo(() => {
    if (!dateInput || !self.plannedDeployDate || !self.plannedRetrieveDate) return null;
    const interval =
      parseISO(self.plannedRetrieveDate).getTime() - parseISO(self.plannedDeployDate).getTime();
    return formatISO(new Date(parseISO(dateInput).getTime() + interval));
  }, [dateInput, self.plannedDeployDate, self.plannedRetrieveDate]);

  function handleSuccess() {
    onOpenChange(false);
    router.refresh();
  }

  function handlePreviewSwap() {
    if (!selectedSwapId) return;
    setError(null);
    setWarnings([]);
    startTransition(async () => {
      const result = await previewInlineSwap(self.deploymentId, selectedSwapId);
      if (result.success) {
        setState({ mode: "swap-preview", preview: result.data });
      } else {
        setError(result.error);
      }
    });
  }

  function handleCommitSwap() {
    if (state.mode !== "swap-preview" || !selectedSwapId) return;
    setError(null);
    startTransition(async () => {
      const result = await commitInlineSwap(self.deploymentId, selectedSwapId, state.preview.hash);
      if (result.success) handleSuccess();
      else setError(result.error);
    });
  }

  function handleCommitDateEdit() {
    if (!dateInput || dateInput === self.plannedDeployDate) return;
    setError(null);
    startTransition(async () => {
      const result = await commitDateEdit(self.deploymentId, dateInput);
      if (result.success) {
        setWarnings(result.data.warnings);
        handleSuccess();
      } else {
        setError(result.error);
      }
    });
  }

  function handleSaveSite() {
    if (!site || !siteChanged) return;
    setError(null);
    setWarnings([]);
    startTransition(async () => {
      const result = await updateSiteEntity({
        siteId: site.siteId,
        uuid: site.uuid,
        name: siteName,
        latitude: siteLat,
        longitude: siteLng,
        habitatType: siteHabitat,
        landownerName: siteLandownerName,
        landownerPhone: siteLandownerPhone,
        notes: siteNotes,
        expected: {
          name: site.siteName,
          latitude: site.lat != null ? String(site.lat) : "",
          longitude: site.lng != null ? String(site.lng) : "",
          habitatType: site.habitatType,
          landownerName: site.landownerName,
          landownerPhone: site.landownerPhone,
          notes: site.notes,
        },
      });
      if (result.success) {
        if (result.data.warnings.length > 0) {
          // Keep the dialog open so the "saved to ODK, sheet didn't" warning is seen.
          setWarnings(result.data.warnings);
          router.refresh();
        } else {
          handleSuccess();
        }
      } else {
        setError(result.error);
      }
    });
  }

  const habitatLabel = getHabitatName(self.habitatType);
  const swapDisabled = !selectedSwapId || isPending;
  const dateEditDisabled =
    isPending || !dateInput || dateInput === self.plannedDeployDate;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Editar {self.deploymentId} — {habitatLabel}
          </DialogTitle>
          <DialogDescription>
            {canEditDates
              ? "Cambiar la fecha de instalación, intercambiar con otra instalación programada, o editar los datos del sitio en ODK."
              : "Esta instalación ya no está programada, así que las fechas no se pueden cambiar. Puedes editar los datos del sitio en ODK."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-sm text-muted-foreground">
          <div>
            Fechas actuales:{" "}
            <span className="tabular-nums text-foreground">
              Instalación {self.plannedDeployDate ?? "—"}
            </span>
            {" · "}
            <span className="tabular-nums text-foreground">
              Recuperación {self.plannedRetrieveDate ?? "—"}
            </span>
          </div>
          <div>{self.siteName}</div>
        </div>

        <div className={canEditDates ? "grid gap-4 md:grid-cols-2 md:items-start" : "space-y-4"}>
          {/* Left column: site editing (always) + date editing (future only) */}
          <div className="space-y-4">
            {/* ───── Edit site entity (name / coords / habitat) ───── */}
            {site && (
              <section className="space-y-3 rounded-lg border p-4">
                <h3 className="text-sm font-semibold">Editar sitio</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="text-xs font-medium block mb-1" htmlFor="site-name">
                      Nombre
                    </label>
                    <Input
                      id="site-name"
                      value={siteName}
                      onChange={(e) => setSiteName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1" htmlFor="site-lat">
                      Latitud
                    </label>
                    <Input
                      id="site-lat"
                      inputMode="decimal"
                      value={siteLat}
                      onChange={(e) => setSiteLat(e.target.value)}
                      className="tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1" htmlFor="site-lng">
                      Longitud
                    </label>
                    <Input
                      id="site-lng"
                      inputMode="decimal"
                      value={siteLng}
                      onChange={(e) => setSiteLng(e.target.value)}
                      className="tabular-nums"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-xs font-medium block mb-1" htmlFor="site-habitat">
                      Hábitat
                    </label>
                    <Select value={siteHabitat} onValueChange={setSiteHabitat}>
                      <SelectTrigger id="site-habitat" className="w-full">
                        <SelectValue placeholder="Seleccionar hábitat" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(HABITAT_NAMES).map(([key, label]) => (
                          <SelectItem key={key} value={key}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1" htmlFor="site-landowner-name">
                      Nombre del propietario
                    </label>
                    <Input
                      id="site-landowner-name"
                      value={siteLandownerName}
                      onChange={(e) => setSiteLandownerName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1" htmlFor="site-landowner-phone">
                      Teléfono del propietario
                    </label>
                    <Input
                      id="site-landowner-phone"
                      inputMode="tel"
                      value={siteLandownerPhone}
                      onChange={(e) => setSiteLandownerPhone(e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-xs font-medium block mb-1" htmlFor="site-notes">
                      Notas
                    </label>
                    <Textarea
                      id="site-notes"
                      rows={3}
                      value={siteNotes}
                      onChange={(e) => setSiteNotes(e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Estos campos pertenecen al sitio{" "}
                  <span className="font-mono">{site.siteId}</span> en ODK y afectan todas sus
                  visitas. El nombre se sincroniza con la hoja del cronograma.
                </p>
                <Button onClick={handleSaveSite} disabled={isPending || !siteChanged} size="sm">
                  {isPending ? "Guardando..." : "Guardar sitio"}
                </Button>
              </section>
            )}

            {/* ───── Direct date edit (future deployments only) ───── */}
            {canEditDates && (
              <section className="space-y-3 rounded-lg border p-4">
                <h3 className="text-sm font-semibold">Cambiar fecha</h3>
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="text-xs font-medium block mb-1" htmlFor="new-deploy-date">
                      Nueva fecha de instalación
                    </label>
                    <Input
                      id="new-deploy-date"
                      type="date"
                      value={dateInput}
                      min={TODAY_ISO}
                      onChange={(e) => setDateInput(e.target.value)}
                      className="w-44"
                    />
                  </div>
                  {newRetrievePreview && (
                    <p className="text-xs text-muted-foreground pb-2">
                      Recuperación se moverá a{" "}
                      <span className="tabular-nums font-medium text-foreground">
                        {newRetrievePreview}
                      </span>
                      .
                    </p>
                  )}
                </div>
                <Button onClick={handleCommitDateEdit} disabled={dateEditDisabled} size="sm">
                  {isPending ? "Guardando..." : "Aplicar cambio de fecha"}
                </Button>
              </section>
            )}
          </div>

          {/* Right column: swap with another scheduled deployment (future only) */}
          {canEditDates && (
            <section className="space-y-3 rounded-lg border p-4">
              <h3 className="text-sm font-semibold">o intercambiar con otra instalación</h3>

              <div className="flex items-center gap-2 text-sm">
                <Checkbox
                  id="habitat-only"
                  checked={habitatOnly}
                  onCheckedChange={(v) => setHabitatOnly(v === true)}
                />
                <label htmlFor="habitat-only" className="cursor-pointer">
                  Solo mismo hábitat ({habitatLabel})
                </label>
              </div>

              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por ID o sitio..."
                  value={candidateFilter}
                  onChange={(e) => setCandidateFilter(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>

              <div className="max-h-64 overflow-y-auto rounded-md border">
                {filtered.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-3">
                    No hay instalaciones que coincidan con el filtro.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {filtered.map((c) => (
                      <li key={c.deploymentId}>
                        <label className="flex items-center gap-3 p-2 cursor-pointer hover:bg-muted/50 text-sm">
                          <input
                            type="radio"
                            name="swap-target"
                            value={c.deploymentId}
                            checked={selectedSwapId === c.deploymentId}
                            onChange={() => setSelectedSwapId(c.deploymentId)}
                          />
                          <span className="font-mono text-xs">{c.deploymentId}</span>
                          <span className="text-muted-foreground">{c.siteName}</span>
                          <span className="tabular-nums ml-auto">
                            {c.plannedDeployDate ?? "—"}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <Button onClick={handlePreviewSwap} disabled={swapDisabled} variant="secondary" size="sm">
                {isPending ? "Calculando..." : "Vista previa del intercambio"}
              </Button>

              {state.mode === "swap-preview" && (
                <div className="space-y-3">
                  <div className="rounded-md border overflow-auto">
                    <Table className="text-xs">
                      <TableHeader>
                        <TableRow>
                          <TableHead>ID</TableHead>
                          <TableHead>Campo</TableHead>
                          <TableHead>Antes</TableHead>
                          <TableHead>Después</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {state.preview.changes.map((c, i) => (
                          <TableRow key={i}>
                            <TableCell className="font-mono">{c.deploymentId}</TableCell>
                            <TableCell>{c.field}</TableCell>
                            <TableCell className="tabular-nums">{c.oldValue}</TableCell>
                            <TableCell className="tabular-nums">{c.newValue}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {state.preview.validationErrors.length > 0 && (
                    <div className="rounded-md bg-yellow-50 p-3 text-xs">
                      <p className="font-medium text-yellow-800">
                        {state.preview.validationErrors.length} advertencia
                        {state.preview.validationErrors.length === 1 ? "" : "s"}:
                      </p>
                      <ul className="mt-1 list-disc pl-5 text-yellow-700 space-y-0.5">
                        {state.preview.validationErrors.slice(0, 10).map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <Button onClick={handleCommitSwap} disabled={isPending} size="sm">
                    {isPending ? "Guardando..." : "Aplicar intercambio"}
                  </Button>
                </div>
              )}
            </section>
          )}
        </div>

        {warnings.length > 0 && (
          <div className="rounded-md bg-yellow-50 p-3 text-xs">
            <p className="font-medium text-yellow-800">Cambio aplicado con advertencias:</p>
            <ul className="mt-1 list-disc pl-5 text-yellow-700 space-y-0.5">
              {warnings.slice(0, 10).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
