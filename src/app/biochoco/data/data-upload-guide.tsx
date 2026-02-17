"use client";

import { useState, useCallback } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

const STORAGE_KEY = "data-upload-guide-collapsed";

function getStoredCollapsed(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === null ? true : stored === "true";
}

export function DataUploadGuide() {
  const [isCollapsed, setIsCollapsed] = useState(getStoredCollapsed);

  const toggle = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return (
    <div className="border rounded-lg bg-muted/30">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 flex-shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 flex-shrink-0" />
        )}
        Guía: cómo subir datos de sensores
      </button>

      {!isCollapsed && (
        <div className="px-3 pb-3 space-y-3 text-sm">
          <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">Recuperar sensores</span>
              {" — "}
              Completar el formulario de recuperación en ODK Collect desde el campo
            </li>
            <li>
              <span className="font-medium text-foreground">Crear carpetas de Drive</span>
              {" — "}
              Si la instalación no tiene carpeta en Google Drive, usar el panel
              {" \"Crear Carpetas de Drive\" "}
              arriba. Hacer clic en
              {" \"Buscar Instalaciones sin Carpeta\" "}
              para encontrar instalaciones pendientes y crear las carpetas automáticamente.
            </li>
            <li>
              <span className="font-medium text-foreground">Encontrar la instalación</span>
              {" — "}
              Buscar en la tabla por nombre de sitio o ID, o usar la barra de búsqueda para filtrar
            </li>
            <li>
              <span className="font-medium text-foreground">Subir archivos</span>
              {" — "}
              Hacer clic en &quot;Subir&quot; junto al tipo de dato (Cámaras, Audio, iButton) para abrir la carpeta en Google Drive
            </li>
            <li>
              <span className="font-medium text-foreground">Cargar los datos</span>
              {" — "}
              Arrastrar o seleccionar los archivos del sensor en la carpeta que se abre
            </li>
            <li>
              <span className="font-medium text-foreground">Verificar</span>
              {" — "}
              Volver a esta página y verificar que los conteos de archivos aparezcan correctamente (usar el botón de actualizar si es necesario).
              Los números junto a cada enlace indican cuántos archivos se encontraron en esa carpeta de Drive.
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
