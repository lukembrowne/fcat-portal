"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SortIcon } from "@/components/sort-icon";
import {
  createSpecies,
  updateSpecies,
  deleteSpecies,
  getSpeciesUsageCount,
} from "@/app/camera-trap/actions";
import type { Species } from "@/db/schema";
import type { TaxonomicRank } from "@/lib/types";

const TYPE_LABELS: Record<string, string> = {
  mammal: "Mamífero",
  bird: "Ave",
  reptile: "Reptil",
  amphibian: "Anfibio",
  insect: "Insecto",
  system: "Sistema",
};

const RANK_LABELS: Record<string, { label: string; short: string; color: string }> = {
  species: { label: "Especie", short: "sp.", color: "bg-green-100 text-green-800" },
  genus: { label: "Género", short: "gen.", color: "bg-blue-100 text-blue-800" },
  family: { label: "Familia", short: "fam.", color: "bg-purple-100 text-purple-800" },
  order: { label: "Orden", short: "ord.", color: "bg-orange-100 text-orange-800" },
  class: { label: "Clase", short: "cl.", color: "bg-gray-100 text-gray-800" },
};

interface SpeciesClientProps {
  species: Species[];
}

interface FormState {
  scientificName: string;
  commonName: string;
  spanishName: string;
  taxonomicRank: TaxonomicRank;
  type: string;
}

const emptyForm: FormState = {
  scientificName: "",
  commonName: "",
  spanishName: "",
  taxonomicRank: "species",
  type: "mammal",
};

type SortKey = "scientificName" | "commonName" | "spanishName" | "taxonomicRank" | "type";
type SortDir = "asc" | "desc";

const COLUMN_TOOLTIPS: Record<string, string> = {
  scientificName: "Nombre en latín según la taxonomía linneana (ej. Panthera onca)",
  commonName: "Nombre común en inglés usado en la literatura internacional",
  spanishName: "Nombre común en español usado localmente en Ecuador",
  taxonomicRank: "Nivel de clasificación biológica: Clase > Orden > Familia > Género > Especie",
  type: "Grupo taxonómico general del organismo (mamífero, ave, reptil, etc.)",
  actions: "Editar o eliminar esta especie del catálogo",
};

const RANK_ORDER: Record<string, number> = {
  class: 0, order: 1, family: 2, genus: 3, species: 4,
};

export function SpeciesClient({ species }: SpeciesClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleteUsageCount, setDeleteUsageCount] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("scientificName");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filteredSorted = useMemo(() => {
    const q = search.toLowerCase().trim();
    let list = species;
    if (q) {
      list = species.filter(
        (sp) =>
          sp.scientificName.toLowerCase().includes(q) ||
          sp.commonName.toLowerCase().includes(q) ||
          (sp.spanishName && sp.spanishName.toLowerCase().includes(q)) ||
          (TYPE_LABELS[sp.type] || sp.type).toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      let cmp: number;
      if (sortKey === "taxonomicRank") {
        cmp = (RANK_ORDER[a.taxonomicRank] ?? 99) - (RANK_ORDER[b.taxonomicRank] ?? 99);
      } else {
        const va = (a[sortKey] || "").toLowerCase();
        const vb = (b[sortKey] || "").toLowerCase();
        cmp = va.localeCompare(vb);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [species, search, sortKey, sortDir]);

  const handleAdd = () => {
    setError(null);
    startTransition(async () => {
      const result = await createSpecies({
        scientificName: form.scientificName,
        commonName: form.commonName,
        spanishName: form.spanishName || null,
        taxonomicRank: form.taxonomicRank,
        type: form.type,
      });
      if (result.success) {
        setAddOpen(false);
        setForm(emptyForm);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const handleEdit = () => {
    if (editId === null) return;
    setError(null);
    startTransition(async () => {
      const result = await updateSpecies(editId, {
        scientificName: form.scientificName,
        commonName: form.commonName,
        spanishName: form.spanishName || null,
        taxonomicRank: form.taxonomicRank,
        type: form.type,
      });
      if (result.success) {
        setEditId(null);
        setForm(emptyForm);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const openEdit = (sp: Species) => {
    setError(null);
    setForm({
      scientificName: sp.scientificName,
      commonName: sp.commonName,
      spanishName: sp.spanishName || "",
      taxonomicRank: sp.taxonomicRank as TaxonomicRank,
      type: sp.type,
    });
    setEditId(sp.id);
  };

  const openDelete = (sp: Species) => {
    setDeleteId(sp.id);
    setDeleteUsageCount(null);
    setError(null);
    startTransition(async () => {
      const result = await getSpeciesUsageCount(sp.id);
      if (result.success) {
        setDeleteUsageCount(result.data);
      }
    });
  };

  const handleDelete = () => {
    if (deleteId === null) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteSpecies(deleteId);
      if (result.success) {
        setDeleteId(null);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const formFields = (
    <div className="space-y-4">
      <div>
        <Label htmlFor="scientificName">Nombre científico *</Label>
        <Input
          id="scientificName"
          value={form.scientificName}
          onChange={(e) => setForm({ ...form, scientificName: e.target.value })}
          placeholder="Ej: Cuniculus paca"
        />
      </div>
      <div>
        <Label htmlFor="commonName">Nombre común (inglés) *</Label>
        <Input
          id="commonName"
          value={form.commonName}
          onChange={(e) => setForm({ ...form, commonName: e.target.value })}
          placeholder="Ej: Lowland paca"
        />
      </div>
      <div>
        <Label htmlFor="spanishName">Nombre común (español)</Label>
        <Input
          id="spanishName"
          value={form.spanishName}
          onChange={(e) => setForm({ ...form, spanishName: e.target.value })}
          placeholder="Ej: Guanta"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Rango taxonómico</Label>
          <Select
            value={form.taxonomicRank}
            onValueChange={(v) => setForm({ ...form, taxonomicRank: v as TaxonomicRank })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="species">Especie</SelectItem>
              <SelectItem value="genus">Género</SelectItem>
              <SelectItem value="family">Familia</SelectItem>
              <SelectItem value="order">Orden</SelectItem>
              <SelectItem value="class">Clase</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Tipo</Label>
          <Select
            value={form.type}
            onValueChange={(v) => setForm({ ...form, type: v })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="mammal">Mamífero</SelectItem>
              <SelectItem value="bird">Ave</SelectItem>
              <SelectItem value="reptile">Reptil</SelectItem>
              <SelectItem value="amphibian">Anfibio</SelectItem>
              <SelectItem value="insect">Insecto</SelectItem>
              <SelectItem value="system">Sistema</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );

  const deleteSp = deleteId !== null ? species.find((s) => s.id === deleteId) : null;

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Especies</h1>
          <p className="text-sm text-muted-foreground">
            {species.length} especies registradas
          </p>
        </div>
        <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) { setForm(emptyForm); setError(null); } }}>
          <DialogTrigger asChild>
            <Button>Agregar Especie</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Agregar Especie</DialogTitle>
            </DialogHeader>
            {formFields}
            <DialogFooter>
              <Button
                onClick={handleAdd}
                disabled={isPending || !form.scientificName || !form.commonName}
              >
                {isPending ? "Guardando..." : "Agregar"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="mb-4">
        <Input
          placeholder="Buscar por nombre científico, común, español o tipo..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-md"
        />
        {search && (
          <p className="text-xs text-muted-foreground mt-1">
            {filteredSorted.length} de {species.length} especies
          </p>
        )}
      </div>

      <TooltipProvider delayDuration={300}>
        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead column="scientificName" label="Nombre científico" current={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableHead column="commonName" label="Nombre común" current={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableHead column="spanishName" label="Español" current={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableHead column="taxonomicRank" label="Rango taxonómico" current={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableHead column="type" label="Tipo" current={sortKey} dir={sortDir} onSort={toggleSort} />
                <TableHead className="w-[120px]">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help">Acciones</span>
                    </TooltipTrigger>
                    <TooltipContent><p className="max-w-[200px] text-xs">{COLUMN_TOOLTIPS.actions}</p></TooltipContent>
                  </Tooltip>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredSorted.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    {search ? "No se encontraron especies" : "No hay especies registradas"}
                  </TableCell>
                </TableRow>
              )}
              {filteredSorted.map((sp) => {
                const rank = RANK_LABELS[sp.taxonomicRank] || RANK_LABELS.species;
                return (
                  <TableRow key={sp.id}>
                    <TableCell className="font-medium italic">{sp.scientificName}</TableCell>
                    <TableCell>{sp.commonName}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {sp.spanishName || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-xs ${rank.color}`}>
                        {rank.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs">
                        {TYPE_LABELS[sp.type] || sp.type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => openEdit(sp)}
                        >
                          Editar
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-destructive"
                          onClick={() => openDelete(sp)}
                        >
                          Eliminar
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </TooltipProvider>

      {/* Edit Dialog */}
      <Dialog open={editId !== null} onOpenChange={(open) => { if (!open) { setEditId(null); setForm(emptyForm); setError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar Especie</DialogTitle>
          </DialogHeader>
          {formFields}
          <DialogFooter>
            <Button
              onClick={handleEdit}
              disabled={isPending || !form.scientificName || !form.commonName}
            >
              {isPending ? "Guardando..." : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteId !== null} onOpenChange={(open) => { if (!open) { setDeleteId(null); setError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminar Especie</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {deleteSp && (
              <p className="text-sm">
                ¿Eliminar <span className="font-medium italic">{deleteSp.scientificName}</span> ({deleteSp.commonName})?
              </p>
            )}
            {deleteUsageCount === null && isPending && (
              <p className="text-sm text-muted-foreground">Verificando uso...</p>
            )}
            {deleteUsageCount !== null && deleteUsageCount > 0 && (
              <p className="text-sm text-destructive">
                Esta especie está referenciada en {deleteUsageCount} correcciones y no puede ser eliminada.
              </p>
            )}
            {deleteUsageCount === 0 && (
              <p className="text-sm text-muted-foreground">
                Esta especie no está en uso y puede ser eliminada.
              </p>
            )}
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending || deleteUsageCount === null || deleteUsageCount > 0}
            >
              {isPending ? "Eliminando..." : "Eliminar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SortableHead({
  column,
  label,
  current,
  dir,
  onSort,
}: {
  column: SortKey;
  label: string;
  current: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const active = current === column;
  return (
    <TableHead>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors text-left"
            onClick={() => onSort(column)}
          >
            {label}
            <SortIcon direction={active ? dir : false} />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="max-w-[220px] text-xs">{COLUMN_TOOLTIPS[column]}</p>
        </TooltipContent>
      </Tooltip>
    </TableHead>
  );
}
