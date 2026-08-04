"use client";

/**
 * "Agregar persona" — name, role, group and the selected year's salary in one
 * step, so adding someone as the staff changes never requires a spreadsheet
 * round-trip.
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
import { createPerson } from "./actions";

export function AddPersonDialog({
  year,
  groups,
  children,
}: {
  year: number;
  groups: { id: number; name: string }[];
  children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [groupId, setGroupId] = useState("");
  const [annualCost, setAnnualCost] = useState("");

  function reset() {
    setName("");
    setRole("");
    setGroupId("");
    setAnnualCost("");
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createPerson({
        name,
        role: role || null,
        groupId: groupId ? Number(groupId) : null,
        year,
        annualCost: annualCost || null,
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
          <DialogTitle>Agregar persona</DialogTitle>
          <DialogDescription>
            El sueldo se registra para {year}. Los años anteriores no se modifican.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sueldo-nombre">Nombre</Label>
            <Input
              id="sueldo-nombre"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nombre y apellido"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sueldo-figura">Figura en rol de pagos</Label>
            <Input
              id="sueldo-figura"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="p. ej. FCATero, Coordinadora logística"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sueldo-grupo">Grupo</Label>
            <select
              id="sueldo-grupo"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">— sin grupo —</option>
              {groups.map((g) => (
                <option key={g.id} value={String(g.id)}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sueldo-monto">Sueldo anual {year}</Label>
            <Input
              id="sueldo-monto"
              value={annualCost}
              onChange={(e) => setAnnualCost(e.target.value)}
              placeholder="p. ej. 8,566.16"
              inputMode="decimal"
            />
            <p className="text-xs text-muted-foreground">
              Costo total al proyecto: incluye décimo tercero, décimo cuarto, aporte patronal y
              fondos de reserva. Opcional — se puede completar después.
            </p>
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
