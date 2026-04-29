"use client";

import { useEffect, useState } from "react";
import { HelpCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function AnnotationHelpPanel() {
  const [open, setOpen] = useState(false);

  // While the help modal is open, swallow annotation hotkeys at the capture
  // phase so digits/arrows don't leak through to the window-level shortcut
  // handler. Esc still flows to Radix to close the dialog.
  useEffect(() => {
    if (!open) return;
    function swallow(e: KeyboardEvent) {
      if (e.key === "Escape") return;
      e.stopPropagation();
    }
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 px-2.5 py-1.5 rounded-md border text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        title="Ver ayuda y atajos de teclado"
      >
        <HelpCircle className="size-4 shrink-0" />
        Ayuda y atajos
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Ayuda y atajos de teclado</DialogTitle>
          </DialogHeader>

          <div className="grid gap-5 sm:grid-cols-2 text-sm">
            {/* Workflow */}
            <section className="sm:col-span-2">
              <h4 className="font-medium text-xs uppercase text-muted-foreground mb-2 tracking-wider">
                Flujo de trabajo
              </h4>
              <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                <li>Clic en un cuadro (o tecla <Kbd>1-9</Kbd>) — aparece el selector</li>
                <li>Asigne especie con clic o tecla <Kbd>1-0</Kbd> (slot fijo por sesión)</li>
                <li>Se verifica automáticamente al asignar especie</li>
                <li>Eliminar detecciones falsas: botón <Kbd>🗑</Kbd> o tecla <Kbd>d</Kbd></li>
                <li>Dibujar nuevos cuadros: clic y arrastrar en la imagen</li>
              </ol>
            </section>

            {/* Keyboard shortcuts */}
            <section>
              <h4 className="font-medium text-xs uppercase text-muted-foreground mb-2 tracking-wider">
                Atajos de teclado
              </h4>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                <ShortcutRow keys="← →" desc="Imagen anterior/siguiente" />
                <ShortcutRow keys="1-9" desc="Seleccionar detección" />
                <ShortcutRow keys="1-0" desc="Asignar especie frecuente" />
                <ShortcutRow keys="Enter" desc="Verificar todo y avanzar" />
                <ShortcutRow keys="d / ⌫" desc="Eliminar detección" />
                <ShortcutRow keys="b" desc="Confirmar/desconfirmar vacía" />
                <ShortcutRow keys="s" desc="Destacar imagen" />
                <ShortcutRow keys="i" desc="Marcar como instalación" />
                <ShortcutRow keys="t" desc="Marcar como recogida" />
                <ShortcutRow keys="h" desc="Ocultar/mostrar cajas" />
                <ShortcutRow keys="z" desc="Restablecer zoom" />
                <ShortcutRow keys="Esc" desc="Deseleccionar / volver" />
              </div>
            </section>

            <section>
              <h4 className="font-medium text-xs uppercase text-muted-foreground mb-2 tracking-wider">
                Mouse y zoom
              </h4>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                <ShortcutRow keys="Scroll" desc="Zoom" />
                <ShortcutRow keys="Espacio + arrastrar" desc="Mover vista" />
                <ShortcutRow keys="Clic y arrastrar" desc="Dibujar nuevo cuadro" />
              </div>

              <h4 className="font-medium text-xs uppercase text-muted-foreground mt-4 mb-2 tracking-wider">
                Consejos
              </h4>
              <ul className="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                <li>Los slots 1-0 quedan fijos durante la sesión</li>
                <li>Con el selector abierto, escriba para buscar especies raras</li>
                <li><Kbd>Enter</Kbd> verifica todo y avanza</li>
              </ul>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-block px-1.5 py-0.5 text-[11px] font-mono bg-background border rounded shadow-sm">
      {children}
    </kbd>
  );
}

function ShortcutRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <>
      <span className="flex items-center">
        <Kbd>{keys}</Kbd>
      </span>
      <span className="text-muted-foreground flex items-center">{desc}</span>
    </>
  );
}
