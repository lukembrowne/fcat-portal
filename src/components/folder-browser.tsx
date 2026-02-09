"use client";

import { useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { listDirectory } from "@/app/camera-trap/actions";

interface FolderBrowserProps {
  onSelect: (path: string) => void;
  trigger?: React.ReactNode;
}

export function FolderBrowser({ onSelect, trigger }: FolderBrowserProps) {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState("/");
  const [pathInput, setPathInput] = useState("/");
  const [entries, setEntries] = useState<{ name: string; isDir: boolean; imageCount: number }[]>([]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const browse = (dirPath: string) => {
    setError(null);
    startTransition(async () => {
      const result = await listDirectory(dirPath);
      if (result.success) {
        setEntries(result.data.entries);
        setCurrentPath(dirPath);
        setPathInput(dirPath);
      } else {
        setError(result.error);
      }
    });
  };

  const handleGoToPath = () => {
    if (pathInput.trim()) {
      browse(pathInput.trim());
    }
  };

  const handleNavigateUp = () => {
    const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
    browse(parent);
  };

  const handleNavigateInto = (name: string) => {
    const newPath = currentPath.endsWith("/")
      ? `${currentPath}${name}`
      : `${currentPath}/${name}`;
    browse(newPath);
  };

  const handleSelect = () => {
    onSelect(currentPath);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o && entries.length === 0) browse("/"); }}>
      <DialogTrigger asChild>
        {trigger || (
          <Button type="button" variant="outline" size="sm">
            Explorar...
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Seleccionar directorio</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleGoToPath()}
            className="font-mono text-sm"
            placeholder="/ruta/al/directorio"
          />
          <Button type="button" variant="outline" size="sm" onClick={handleGoToPath}>
            Ir
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto border rounded-md">
          {isPending && (
            <div className="p-8 text-center text-muted-foreground">
              Cargando...
            </div>
          )}

          {error && (
            <div className="p-4 text-center text-red-600 text-sm">{error}</div>
          )}

          {!isPending && !error && (
            <div className="divide-y">
              {currentPath !== "/" && (
                <button
                  type="button"
                  className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-accent transition-colors"
                  onClick={handleNavigateUp}
                >
                  <span className="text-sm font-medium">..</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    Directorio padre
                  </span>
                </button>
              )}

              {entries.length === 0 && (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  No se encontraron subdirectorios
                </div>
              )}

              {entries.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-accent transition-colors"
                  onClick={() => handleNavigateInto(entry.name)}
                >
                  <span className="text-sm font-medium truncate flex-1">
                    {entry.name}
                  </span>
                  {entry.imageCount > 0 && (
                    <Badge variant="secondary" className="text-xs shrink-0">
                      {entry.imageCount} img
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button type="button" onClick={handleSelect} disabled={!currentPath}>
            Seleccionar esta carpeta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
