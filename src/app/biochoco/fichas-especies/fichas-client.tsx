"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortIcon } from "@/components/sort-icon";
import { updateSpeciesContent } from "./actions";
import { SPECIES_CONTENT_MAX, type SpeciesContentRow } from "./content-types";

const TYPE_LABELS: Record<string, string> = {
  mammal: "Mamífero",
  bird: "Ave",
  reptile: "Reptil",
  amphibian: "Anfibio",
  insect: "Insecto",
  system: "Sistema",
};

type SortKey = "name" | "type" | "status" | "records";
type SortDir = "asc" | "desc";

interface Props {
  species: SpeciesContentRow[];
}

function displayName(s: SpeciesContentRow): string {
  return s.spanishName || s.commonName || s.scientificName;
}

export function FichasEspeciesClient({ species }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rows, setRows] = useState<SpeciesContentRow[]>(species);
  const [editId, setEditId] = useState<number | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Default: most camera-trap records first, so the species farmers actually
  // see lead the list and the audio-bird tail (0 registros) sinks to the bottom.
  const [sortKey, setSortKey] = useState<SortKey>("records");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      // Records default to descending (most first); text columns to ascending.
      setSortDir(key === "records" ? "desc" : "asc");
    }
  };

  const filteredSorted = useMemo(() => {
    const q = search.toLowerCase().trim();
    let list = rows;
    if (q) {
      list = rows.filter(
        (s) =>
          s.scientificName.toLowerCase().includes(q) ||
          s.commonName.toLowerCase().includes(q) ||
          (s.spanishName && s.spanishName.toLowerCase().includes(q))
      );
    }
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") cmp = displayName(a).localeCompare(displayName(b));
      else if (sortKey === "type")
        cmp = (TYPE_LABELS[a.type] || a.type).localeCompare(TYPE_LABELS[b.type] || b.type);
      else if (sortKey === "records") {
        // Most records first (when desc); name as a stable tiebreaker so the
        // 0-registro tail stays alphabetical rather than arbitrary.
        cmp = a.detectionCount - b.detectionCount;
        if (cmp === 0) {
          // Tiebreak by name ASCENDING regardless of sortDir.
          const nameCmp = displayName(a).localeCompare(displayName(b));
          return (sortDir === "asc" ? cmp : -cmp) || nameCmp;
        }
      } else {
        // status: "con ficha" first when asc
        const av = a.hasContent ? 0 : 1;
        const bv = b.hasContent ? 0 : 1;
        cmp = av - bv || displayName(a).localeCompare(displayName(b));
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, search, sortKey, sortDir]);

  const openEdit = (s: SpeciesContentRow) => {
    setEditId(s.id);
    setContent(s.publicContent ?? "");
    setError(null);
  };

  const closeEdit = () => {
    setEditId(null);
    setError(null);
  };

  const handleSave = () => {
    if (editId === null) return;
    setError(null);
    startTransition(async () => {
      const result = await updateSpeciesContent(editId, {
        publicContent: content,
      });
      if (result.success) {
        const saved = result.data.publicContent;
        setRows((rs) =>
          rs.map((r) =>
            r.id === editId
              ? {
                  ...r,
                  publicContent: saved,
                  hasContent: !!saved?.trim(),
                }
              : r
          )
        );
        closeEdit();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const editSp = editId !== null ? rows.find((r) => r.id === editId) : null;
  const withContent = rows.filter((r) => r.hasContent).length;

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Fichas de especies</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Texto que aparece en las páginas públicas de las fincas. Es el mismo
          para todos los sitios: al editarlo aquí se actualiza en todas las
          páginas que muestran esa especie.
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {withContent} de {rows.length} especies con ficha
        </p>
      </header>

      <div className="mb-4">
        <Input
          placeholder="Buscar por nombre científico, común o español..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-md"
        />
      </div>

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead label="Especie" col="name" cur={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHead label="Tipo" col="type" cur={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHead label="Registros" col="records" cur={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHead label="Ficha" col="status" cur={sortKey} dir={sortDir} onSort={toggleSort} />
              <TableHead className="w-[100px]">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredSorted.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  No se encontraron especies
                </TableCell>
              </TableRow>
            )}
            {filteredSorted.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <div className="font-medium">{displayName(s)}</div>
                  <div className="text-xs text-muted-foreground italic">
                    {s.scientificName}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-xs">
                    {TYPE_LABELS[s.type] || s.type}
                  </Badge>
                </TableCell>
                <TableCell>
                  {s.detectionCount > 0 ? (
                    <span className="tabular-nums">
                      {s.detectionCount.toLocaleString("es")}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {s.hasContent ? (
                    <Badge className="text-xs bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                      Con ficha
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      Sin ficha
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openEdit(s)}>
                    Editar
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editId !== null} onOpenChange={(open) => { if (!open) closeEdit(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editSp ? displayName(editSp) : "Editar ficha"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="content">Información de la especie</Label>
              <Textarea
                id="content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={7}
                maxLength={SPECIES_CONTENT_MAX}
                placeholder={
                  "Ej: La guatusa dispersa semillas y ayuda a la regeneración del bosque.\n\nPara perros, gatos, gallinas, ganado o cerdos, puede incluir un consejo de manejo:\n- Vacunar y esterilizar\n- No dejarlos sueltos de noche"
                }
              />
              <p className="text-xs text-muted-foreground mt-1">
                Describe el papel del animal en el bosque y, si aplica (perros,
                gatos, gallinas, ganado, cerdos), un consejo de manejo. Deja una
                línea en blanco para separar párrafos y usa un guion (-) al
                inicio de una línea para viñetas.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeEdit} disabled={isPending}>
              Cancelar
            </Button>
            <Button onClick={handleSave} disabled={isPending}>
              {isPending ? "Guardando..." : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SortableHead({
  label,
  col,
  cur,
  dir,
  onSort,
}: {
  label: string;
  col: SortKey;
  cur: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  return (
    <TableHead>
      <button
        type="button"
        className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground"
        onClick={() => onSort(col)}
      >
        {label}
        <SortIcon direction={cur === col ? dir : false} />
      </button>
    </TableHead>
  );
}
