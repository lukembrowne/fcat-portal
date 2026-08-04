"use client";

/**
 * "Agregar fuente" and "Agregar línea" dialogs for /finance/sueldos.
 *
 * A new line pre-fills the source's default period and leaves it editable —
 * the default is a convenience, not a constraint (KTD3).
 */

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FUNDING_STATUS_LABELS, FUNDING_STATUS_ORDER } from "@/lib/finance/sueldos-fields";
import { createFundingSource, createAllocation, type SourcePanel } from "./actions";

export function AddSourceDialog({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [status, setStatus] = useState<"funded" | "pending">("pending");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  function reset() {
    setName("");
    setStatus("pending");
    setStart("");
    setEnd("");
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createFundingSource({
        name,
        status,
        defaultStartDate: start || null,
        defaultEndDate: end || null,
      });
      if (res.success) {
        setOpen(false);
        reset();
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Agregar fuente de financiamiento</DialogTitle>
          <DialogDescription>
            El período es solo un valor por defecto: cada línea puede tener sus propias fechas.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fuente-nombre">Nombre</Label>
            <Input
              id="fuente-nombre"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="p. ej. NMBCA VII"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fuente-estado">Estado</Label>
            <select
              id="fuente-estado"
              value={status}
              onChange={(e) => setStatus(e.target.value as "funded" | "pending")}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {FUNDING_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {FUNDING_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fuente-desde">Desde (por defecto)</Label>
              <Input
                id="fuente-desde"
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fuente-hasta">Hasta (por defecto)</Label>
              <Input
                id="fuente-hasta"
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            <span className={pending ? "ml-1" : ""}>Agregar</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddAllocationDialog({
  source,
  targetOptions,
  children,
}: {
  source: SourcePanel;
  targetOptions: { value: string; label: string }[];
  children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  // Pre-filled from the source, still editable — the line's dates are what count.
  const [start, setStart] = useState(source.defaultStartDate ?? "");
  const [end, setEnd] = useState(source.defaultEndDate ?? "");
  const [notes, setNotes] = useState("");

  function reset() {
    setTarget("");
    setAmount("");
    setStart(source.defaultStartDate ?? "");
    setEnd(source.defaultEndDate ?? "");
    setNotes("");
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createAllocation({
        sourceId: source.id,
        target,
        amount,
        startDate: start || null,
        endDate: end || null,
        notes: notes || null,
      });
      if (res.success) {
        setOpen(false);
        reset();
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Agregar línea — {source.name}</DialogTitle>
          <DialogDescription>
            Las fechas vienen del período por defecto de la fuente y se pueden ajustar.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="linea-destino">Destino</Label>
            <select
              id="linea-destino"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">— seleccionar —</option>
              {targetOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="linea-monto">Monto</Label>
            <Input
              id="linea-monto"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="p. ej. 6,725.00"
              inputMode="decimal"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="linea-desde">Desde</Label>
              <Input
                id="linea-desde"
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="linea-hasta">Hasta</Label>
              <Input
                id="linea-hasta"
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="linea-notas">Notas</Label>
            <Input
              id="linea-notas"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Opcional"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={pending || !target || !amount.trim()}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            <span className={pending ? "ml-1" : ""}>Agregar</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
