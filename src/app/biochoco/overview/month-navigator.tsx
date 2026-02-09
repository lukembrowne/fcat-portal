"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Download, Upload, MapPin, CalendarDays } from "lucide-react";
import { SPANISH_MONTHS } from "./types";

interface MonthNavigatorProps {
  selectedMonth: { year: number; month: number };
  deploymentsCount: number;
  retrievalsCount: number;
  onPrev: () => void;
  onNext: () => void;
}

export function MonthNavigator({
  selectedMonth,
  deploymentsCount,
  retrievalsCount,
  onPrev,
  onNext,
}: MonthNavigatorProps) {
  const uniqueSites = deploymentsCount + retrievalsCount;
  const monthLabel = `${SPANISH_MONTHS[selectedMonth.month]} ${selectedMonth.year}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={onPrev}>
          <ChevronLeft className="h-4 w-4" />
          Anterior
        </Button>
        <h2 className="text-xl font-semibold flex-1 text-center">{monthLabel}</h2>
        <Button variant="outline" size="sm" onClick={onNext}>
          Siguiente
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Instalar</CardTitle>
            <Upload className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{deploymentsCount}</div>
          </CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Recuperar</CardTitle>
            <Download className="h-4 w-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">{retrievalsCount}</div>
          </CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
            <CalendarDays className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{deploymentsCount + retrievalsCount}</div>
          </CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Sitios</CardTitle>
            <MapPin className="h-4 w-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{uniqueSites}</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
