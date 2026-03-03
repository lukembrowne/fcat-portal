"use client";

import { useState, useCallback } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

const STORAGE_KEY = "annotation-help-collapsed";

function getStoredCollapsed(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(STORAGE_KEY);
  // First visit (null): collapsed (true). Subsequent: use stored preference.
  return stored === null ? true : stored === "true";
}

export function AnnotationHelpPanel() {
  // Initialize from localStorage on first client render
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
        Ayuda y atajos de teclado
      </button>

      {!isCollapsed && (
        <div className="px-3 pb-3 space-y-3 text-sm">
          {/* Workflow */}
          <div>
            <h4 className="font-medium text-xs uppercase text-muted-foreground mb-1">
              Flujo de trabajo
            </h4>
            <ol className="list-decimal list-inside space-y-0.5 text-xs text-muted-foreground">
              <li>Seleccionar una detección (clic en el cuadro o tecla <Kbd>1-9</Kbd>)</li>
              <li>Asignar especie (clic en la lista izquierda o tecla <Kbd>1-0</Kbd>)</li>
              <li>Se verifica automáticamente al asignar especie</li>
              <li>Eliminar detecciones falsas: botón <Kbd>🗑</Kbd> o tecla <Kbd>d</Kbd></li>
              <li>Dibujar nuevos cuadros: clic y arrastrar en la imagen</li>
            </ol>
          </div>

          {/* Keyboard shortcuts */}
          <div>
            <h4 className="font-medium text-xs uppercase text-muted-foreground mb-1">
              Atajos de teclado
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
              <ShortcutRow keys="← →" desc="Imagen anterior/siguiente" />
              <ShortcutRow keys="1-9" desc="Seleccionar detección" />
              <ShortcutRow keys="1-0" desc="Asignar especie (con detección)" />
              <ShortcutRow keys="Enter" desc="Verificar todo y avanzar" />
              <ShortcutRow keys="v" desc="Verificar detección" />
              <ShortcutRow keys="r" desc="Rechazar detección" />
              <ShortcutRow keys="d / ⌫ / Supr" desc="Eliminar detección" />
              <ShortcutRow keys="b" desc="Confirmar/desconfirmar vacía" />
              <ShortcutRow keys="h" desc="Ocultar/mostrar cajas" />
              <ShortcutRow keys="Scroll" desc="Zoom" />
              <ShortcutRow keys="Espacio+arrastrar" desc="Mover vista" />
              <ShortcutRow keys="z" desc="Restablecer zoom" />
              <ShortcutRow keys="Esc" desc="Deseleccionar / limpiar búsqueda" />
            </div>
          </div>

          {/* Tips */}
          <div>
            <h4 className="font-medium text-xs uppercase text-muted-foreground mb-1">
              Consejos
            </h4>
            <ul className="list-disc list-inside space-y-0.5 text-xs text-muted-foreground">
              <li><Kbd>Enter</Kbd> verifica todas las detecciones pendientes y avanza</li>
              <li>Las detecciones verificadas se pueden re-corregir</li>
              <li>Use la búsqueda para filtrar especies, luego tecla <Kbd>1</Kbd> para asignar</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-block px-1 py-0.5 text-[10px] font-mono bg-background border rounded shadow-sm">
      {children}
    </kbd>
  );
}

function ShortcutRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <>
      <span className="text-muted-foreground">
        <Kbd>{keys}</Kbd>
      </span>
      <span className="text-muted-foreground">{desc}</span>
    </>
  );
}
