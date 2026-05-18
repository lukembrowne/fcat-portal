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
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search } from "lucide-react";
import type { ScheduleRow } from "@/lib/schedule-types";
import { commitDateEdit, commitInlineSwap, previewInlineSwap, type InlineSwapPreview } from "./actions";
import { getHabitatName } from "./types";

interface Props {
  self: ScheduleRow;
  candidates: ScheduleRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

export function InlineScheduleEditorDialog({ self, candidates, open, onOpenChange }: Props) {
  const router = useRouter();
  const [state, setState] = useState<DialogState>({ mode: "idle" });
  const [dateInput, setDateInput] = useState(self.plannedDeployDate ?? "");
  const [selectedSwapId, setSelectedSwapId] = useState<string | null>(null);
  const [habitatOnly, setHabitatOnly] = useState(true);
  const [candidateFilter, setCandidateFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();

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

  const habitatLabel = getHabitatName(self.habitatType);
  const swapDisabled = !selectedSwapId || isPending;
  const dateEditDisabled =
    isPending || !dateInput || dateInput === self.plannedDeployDate;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Editar {self.deploymentId} — {habitatLabel}
          </DialogTitle>
          <DialogDescription>
            Cambiar la fecha de instalación o intercambiar con otra instalación
            programada.
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

        {/* ───── Direct date edit ───── */}
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

        {/* ───── Swap ───── */}
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
