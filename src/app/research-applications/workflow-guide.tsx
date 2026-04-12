"use client";

import { useState, useCallback } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

const STORAGE_KEY = "research-apps-guide-collapsed";

function getStoredCollapsed(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === null ? false : stored === "true";
}

export function WorkflowGuide() {
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
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 flex-shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 flex-shrink-0" />
        )}
        Guía: flujo de trabajo de aplicaciones
      </button>

      {!isCollapsed && (
        <div className="px-4 pb-4 space-y-4 text-sm">
          {/* Workflow */}
          <div>
            <h4 className="font-medium text-foreground mb-2">
              Flujo de revisión
            </h4>
            <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground">
              <li>
                El investigador completa el{" "}
                <span className="font-medium text-foreground">
                  formulario público
                </span>{" "}
                — se genera un código de referencia y el comité recibe un email
              </li>
              <li>
                Un editor asigna un{" "}
                <span className="font-medium text-foreground">
                  revisor principal
                </span>{" "}
                y cambia el estado a{" "}
                <span className="rounded bg-yellow-100 text-yellow-800 px-1.5 py-0.5 text-xs">
                  En revisión
                </span>
              </li>
              <li>
                El comité discute en los{" "}
                <span className="font-medium text-foreground">comentarios</span>{" "}
                de la aplicación
              </li>
              <li>
                El editor marca como{" "}
                <span className="rounded bg-green-100 text-green-800 px-1.5 py-0.5 text-xs">
                  Aceptada
                </span>
                ,{" "}
                <span className="rounded bg-red-100 text-red-800 px-1.5 py-0.5 text-xs">
                  Rechazada
                </span>
                , o{" "}
                <span className="rounded bg-orange-100 text-orange-800 px-1.5 py-0.5 text-xs">
                  Revisiones solicitadas
                </span>{" "}
                — la comunicación de la decisión al investigador se hace manualmente
              </li>
              <li>
                Al aceptar, se establece automáticamente la{" "}
                <span className="font-medium text-foreground">
                  fecha de entrega del informe final
                </span>{" "}
                (3 meses después de la fecha de fin del proyecto, ajustable)
              </li>
            </ol>
          </div>

          {/* Emails */}
          <div>
            <h4 className="font-medium text-foreground mb-2">
              Emails automáticos
            </h4>
            <ul className="space-y-1.5 text-muted-foreground">
              <li className="flex gap-2">
                <span className="text-foreground">Al enviar:</span>
                Confirmación al investigador + notificación al comité
              </li>
              <li className="flex gap-2">
                <span className="text-foreground">30 días antes:</span>
                Recordatorio al investigador con enlace para subir el informe
              </li>
              <li className="flex gap-2">
                <span className="text-foreground">Día de vencimiento:</span>
                Segundo recordatorio
              </li>
              <li className="flex gap-2">
                <span className="text-foreground">7 días después:</span>
                Recordatorio de informe vencido
              </li>
              <li className="flex gap-2">
                <span className="text-foreground">Mensual (día 1):</span>
                Resumen al comité con aplicaciones nuevas, informes pendientes y
                vencidos
              </li>
            </ul>
            <p className="text-muted-foreground mt-1">
              <span className="text-foreground font-medium">Nota:</span> La
              decisión (aceptada/rechazada) se comunica manualmente al
              investigador — no se envía email automático.
            </p>
          </div>

          {/* Report flow */}
          <div>
            <h4 className="font-medium text-foreground mb-2">
              Informe final
            </h4>
            <p className="text-muted-foreground">
              Los emails de recordatorio incluyen un enlace único para que el
              investigador suba su informe sin necesidad de cuenta. El enlace
              expira 60 días después de la fecha de vencimiento.
            </p>
            <p className="text-muted-foreground mt-1.5">
              Los editores también pueden{" "}
              <span className="font-medium text-foreground">
                generar y copiar el enlace manualmente
              </span>{" "}
              desde la página de detalle de una aplicación aceptada, o enviarlo
              directamente por email al investigador con el botón de reenvío.
            </p>
          </div>

          {/* Roles */}
          <div>
            <h4 className="font-medium text-foreground mb-2">Permisos</h4>
            <ul className="space-y-1 text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">Visor:</span>{" "}
                Ver aplicaciones, comentarios y documentos
              </li>
              <li>
                <span className="font-medium text-foreground">Editor:</span>{" "}
                Cambiar estados, asignar revisores, comentar, establecer fechas
                de entrega
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
