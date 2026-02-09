"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CalendarCheck, Clock, MapPin, CheckCircle } from "lucide-react";
import type { ToolsPageData } from "./actions";
import { BulkShift } from "./bulk-shift";
import { DateSwap } from "./date-swap";
import { AddSite } from "./add-site";
import { Validation } from "./validation";
import { SyncOdk } from "./sync-odk";

export function ToolsShell({ initialData }: { initialData: ToolsPageData }) {
  const { schedule, hasSlots } = initialData;

  const total = schedule.length;
  const scheduled = schedule.filter((r) => r.status === "scheduled").length;
  const deployed = schedule.filter((r) => r.status === "deployed").length;
  const retrieved = schedule.filter((r) => r.status === "retrieved").length;

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Herramientas de Cronograma</h1>
        <p className="text-muted-foreground">Edición masiva de cronogramas y gestión de instalaciones.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
            <CalendarCheck className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{total}</div></CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Programados</CardTitle>
            <Clock className="h-4 w-4 text-gray-600" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{scheduled}</div></CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Instalados</CardTitle>
            <MapPin className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{deployed}</div></CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Recuperados</CardTitle>
            <CheckCircle className="h-4 w-4 text-orange-600" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{retrieved}</div></CardContent>
        </Card>
      </div>

      <Tabs defaultValue="shift">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="shift">Cambio Masivo</TabsTrigger>
          <TabsTrigger value="swap">Intercambiar</TabsTrigger>
          <TabsTrigger value="add-site">Agregar Sitio</TabsTrigger>
          <TabsTrigger value="validate">Validación</TabsTrigger>
          <TabsTrigger value="sync">Sincronizar ODK</TabsTrigger>
        </TabsList>

        <TabsContent value="shift" className="mt-4">
          <BulkShift hasSlots={hasSlots} scheduledCount={scheduled} />
        </TabsContent>

        <TabsContent value="swap" className="mt-4">
          <DateSwap schedule={schedule} />
        </TabsContent>

        <TabsContent value="add-site" className="mt-4">
          <AddSite />
        </TabsContent>

        <TabsContent value="validate" className="mt-4">
          <Validation />
        </TabsContent>

        <TabsContent value="sync" className="mt-4">
          <SyncOdk />
        </TabsContent>
      </Tabs>
    </div>
  );
}
