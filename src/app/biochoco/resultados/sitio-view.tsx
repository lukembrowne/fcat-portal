"use client";

import { useState, useMemo } from "react";
import type { ResultadosData } from "./types";
import { ResultadosMap } from "./resultados-map";
import { SiteTable } from "./site-table";
import { getHabitatName } from "../overview/types";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search } from "lucide-react";

interface SitioViewProps {
  data: ResultadosData;
}

export function SitioView({ data }: SitioViewProps) {
  const [search, setSearch] = useState("");
  const [habitatFilter, setHabitatFilter] = useState("all");

  const filteredSites = useMemo(() => {
    let sites = data.sites;
    if (search) {
      const q = search.toLowerCase();
      sites = sites.filter(
        (s) =>
          s.siteId.toLowerCase().includes(q) ||
          s.siteName.toLowerCase().includes(q),
      );
    }
    if (habitatFilter !== "all") {
      sites = sites.filter((s) => s.habitatType === habitatFilter);
    }
    return sites;
  }, [data.sites, search, habitatFilter]);

  const habitatTypes = useMemo(() => {
    const types = new Set(data.sites.map((s) => s.habitatType).filter(Boolean));
    return Array.from(types).sort();
  }, [data.sites]);

  return (
    <div className="space-y-6 min-w-0">
      <ResultadosMap sites={filteredSites} />

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre o ID de sitio..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={habitatFilter} onValueChange={setHabitatFilter}>
          <SelectTrigger className="w-full sm:w-[220px]">
            <SelectValue placeholder="Todos los hábitats" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los hábitats</SelectItem>
            {habitatTypes.map((h) => (
              <SelectItem key={h} value={h}>
                {getHabitatName(h)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SiteTable sites={filteredSites} />
    </div>
  );
}
