"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  previewDrive,
  registerDrive,
  reconcileNow,
  markStatus,
  archiveDrive,
  unarchiveDrive,
  editDriveName,
  type DrivePreview,
} from "./actions";

const BTN = "rounded border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50";
const BTN_PRIMARY =
  "rounded bg-primary text-primary-foreground px-3 py-1 text-sm font-medium hover:opacity-90 disabled:opacity-50";

export function ReconcileNowButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end">
      <button
        className={BTN}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await reconcileNow();
            setMsg(res.success ? "Reconciliación iniciada" : res.error);
            router.refresh();
          })
        }
      >
        {pending ? "Reconciliando…" : "Reconciliar ahora"}
      </button>
      {msg && <span className="mt-1 text-xs text-muted-foreground">{msg}</span>}
    </div>
  );
}

export function RegisterDriveButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [driveId, setDriveId] = useState("");
  const [rootFolderId, setRootFolderId] = useState("");
  const [preview, setPreview] = useState<DrivePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function reset() {
    setDriveId("");
    setRootFolderId("");
    setPreview(null);
    setError(null);
  }

  return (
    <>
      <button className={BTN_PRIMARY} onClick={() => setOpen(true)}>
        Registrar drive
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg border bg-background p-6 shadow-lg">
            <h2 className="mb-1 text-lg font-semibold">Registrar Shared Drive</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Pega el ID del Shared Drive (empieza con <code>0A</code>).
              Confirma el nombre antes de registrar.
            </p>

            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-muted-foreground">ID del Shared Drive</span>
              <input
                className="w-full rounded border px-2 py-1 font-mono text-sm bg-background"
                value={driveId}
                onChange={(e) => {
                  setDriveId(e.target.value);
                  setPreview(null);
                  setError(null);
                }}
                placeholder="0A..."
              />
            </label>

            {preview && (
              <div className="mb-3 rounded border bg-muted/30 p-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Nombre: </span>
                  <strong>{preview.name}</strong>
                </div>
                {preview.createdTime && (
                  <div className="text-xs text-muted-foreground">
                    Creado: {new Date(preview.createdTime).toLocaleDateString("es-EC")}
                  </div>
                )}
                {preview.alreadyRegistered && (
                  <div className="mt-1 text-xs text-amber-700">
                    Este drive ya está registrado.
                  </div>
                )}
                <label className="mt-3 block text-xs">
                  <span className="mb-1 block text-muted-foreground">
                    Carpeta raíz de instalaciones (opcional — por defecto la raíz del drive)
                  </span>
                  <input
                    className="w-full rounded border px-2 py-1 font-mono text-xs bg-background"
                    value={rootFolderId}
                    onChange={(e) => setRootFolderId(e.target.value)}
                    placeholder={preview.driveId}
                  />
                </label>
              </div>
            )}

            {error && <div className="mb-3 text-sm text-red-700">{error}</div>}

            <div className="flex justify-end gap-2">
              <button
                className={BTN}
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Cancelar
              </button>
              {!preview ? (
                <button
                  className={BTN_PRIMARY}
                  disabled={pending || !driveId.trim()}
                  onClick={() =>
                    start(async () => {
                      setError(null);
                      const res = await previewDrive(driveId);
                      if (res.success) setPreview(res.data);
                      else setError(res.error);
                    })
                  }
                >
                  {pending ? "Verificando…" : "Verificar"}
                </button>
              ) : (
                <button
                  className={BTN_PRIMARY}
                  disabled={pending || preview.alreadyRegistered}
                  onClick={() =>
                    start(async () => {
                      setError(null);
                      const res = await registerDrive({
                        driveId: preview.driveId,
                        name: preview.name,
                        rootFolderId: rootFolderId.trim() || undefined,
                      });
                      if (res.success) {
                        setOpen(false);
                        reset();
                        router.refresh();
                      } else {
                        setError(res.error);
                      }
                    })
                  }
                >
                  {pending ? "Registrando…" : "Registrar"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function RowActions({
  id,
  name,
  status,
  archived,
}: {
  id: string;
  name: string;
  status: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function run(fn: () => Promise<{ success: boolean; error?: string }>) {
    start(async () => {
      const res = await fn();
      if (!res.success && res.error) alert(res.error);
      router.refresh();
    });
  }

  return (
    <div className="inline-flex flex-wrap justify-end gap-1">
      {status === "active" && (
        <button className={BTN} disabled={pending} onClick={() => run(() => markStatus(id, "read-only"))}>
          Solo lectura
        </button>
      )}
      {status === "read-only" && (
        <button className={BTN} disabled={pending} onClick={() => run(() => markStatus(id, "active"))}>
          Activar
        </button>
      )}
      <button
        className={BTN}
        disabled={pending}
        onClick={() => {
          const next = window.prompt("Nuevo nombre:", name);
          if (next && next.trim() && next.trim() !== name) {
            run(() => editDriveName(id, next));
          }
        }}
      >
        Renombrar
      </button>
      {archived ? (
        <button className={BTN} disabled={pending} onClick={() => run(() => unarchiveDrive(id))}>
          Desarchivar
        </button>
      ) : (
        <button
          className={BTN}
          disabled={pending}
          onClick={() => {
            if (window.confirm(`¿Archivar ${name}? Dejará de recibir nuevas instalaciones.`)) {
              run(() => archiveDrive(id));
            }
          }}
        >
          Archivar
        </button>
      )}
    </div>
  );
}
