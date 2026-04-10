"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogSource = "portal" | "cron";

interface PinoLine {
  raw: string;
  parsed: true;
  level: number;
  time?: string;
  msg?: string;
  ctx: Record<string, unknown>;
}

interface PlainLine {
  raw: string;
  parsed: false;
}

type LogLine = PinoLine | PlainLine;

interface HealthSnapshot {
  serverTime: string;
  nodeVersion: string;
  uptimeSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  db: { sizeBytes: number | null; walSizeBytes: number | null; modifiedAt: string | null };
  activeJobCount: number;
  latestBackup: { name: string; at: string; sizeBytes: number } | null;
  mlVenvReady: boolean;
  logs: {
    portal: { sizeBytes: number; modifiedAt: string } | null;
    cron: { sizeBytes: number; modifiedAt: string } | null;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_LINES = 2000;

// Pino numeric levels: 10=trace 20=debug 30=info 40=warn 50=error 60=fatal
function levelLabel(level: number): string {
  if (level >= 60) return "FATAL";
  if (level >= 50) return "ERROR";
  if (level >= 40) return "WARN";
  if (level >= 30) return "INFO";
  if (level >= 20) return "DEBUG";
  return "TRACE";
}

function levelClass(level: number): string {
  if (level >= 50) return "text-red-400 bg-red-500/10 border-l-2 border-red-500";
  if (level >= 40) return "text-yellow-300 bg-yellow-500/10 border-l-2 border-yellow-500";
  if (level >= 30) return "text-zinc-100";
  return "text-zinc-400";
}

function plainLineClass(raw: string): string {
  const lower = raw.toLowerCase();
  if (/\b(error|err|fatal|exception|traceback)\b/.test(lower))
    return "text-red-400 bg-red-500/10 border-l-2 border-red-500";
  if (/\b(warn|warning)\b/.test(lower))
    return "text-yellow-300 bg-yellow-500/10 border-l-2 border-yellow-500";
  return "text-zinc-300";
}

// Fields that are always present on every pino line and add no useful info
// in the viewer. They're still in the raw JSON if you need them.
const HIDDEN_CTX_KEYS = new Set(["app", "hostname", "pid"]);

function parseLine(raw: string): LogLine {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("{")) return { raw, parsed: false };
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj.level !== "number") return { raw, parsed: false };
    const { level, time, msg, ...rest } = obj;
    // Strip noise fields
    const ctx: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (!HIDDEN_CTX_KEYS.has(k)) ctx[k] = v;
    }
    return {
      raw,
      parsed: true,
      level: level as number,
      time: typeof time === "string" ? time : undefined,
      msg: typeof msg === "string" ? msg : undefined,
      ctx,
    };
  } catch {
    return { raw, parsed: false };
  }
}

function formatBytes(b: number | null | undefined): string {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "hace un momento";
  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr} h`;
  const days = Math.floor(hr / 24);
  return `hace ${days} d`;
}

// ---------------------------------------------------------------------------
// Health Panel
// ---------------------------------------------------------------------------

function HealthPanel() {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/admin/health", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as HealthSnapshot;
        if (!cancelled) {
          setHealth(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Error");
      }
    };
    fetchHealth();
    const id = setInterval(fetchHealth, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return (
      <Card className="mb-4">
        <CardContent className="pt-4 text-sm text-red-500">
          Error al cargar el estado del sistema: {error}
        </CardContent>
      </Card>
    );
  }

  if (!health) {
    return (
      <Card className="mb-4">
        <CardContent className="pt-4 text-sm text-muted-foreground">
          Cargando estado del sistema…
        </CardContent>
      </Card>
    );
  }

  const stats: Array<{ label: string; value: string; hint?: string }> = [
    {
      label: "Tamaño BD",
      value: formatBytes(health.db.sizeBytes),
      hint: `WAL ${formatBytes(health.db.walSizeBytes)}`,
    },
    {
      label: "Último respaldo",
      value: health.latestBackup ? timeAgo(health.latestBackup.at) : "Ninguno",
      hint: health.latestBackup?.name,
    },
    {
      label: "Trabajos activos",
      value: String(health.activeJobCount),
    },
    {
      label: "Memoria (RSS)",
      value: formatBytes(health.rssBytes),
      hint: `heap ${formatBytes(health.heapUsedBytes)}`,
    },
    {
      label: "Tiempo activo",
      value: formatUptime(health.uptimeSec),
      hint: health.nodeVersion,
    },
    {
      label: "ML venv",
      value: health.mlVenvReady ? "Listo" : "No instalado",
    },
    {
      label: "Log portal",
      value: formatBytes(health.logs.portal?.sizeBytes ?? null),
      hint: health.logs.portal ? timeAgo(health.logs.portal.modifiedAt) : "—",
    },
    {
      label: "Log cron",
      value: formatBytes(health.logs.cron?.sizeBytes ?? null),
      hint: health.logs.cron ? timeAgo(health.logs.cron.modifiedAt) : "—",
    },
  ];

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Estado del sistema
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {stats.map((s) => (
          <div key={s.label} className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {s.label}
            </div>
            <div className="text-sm font-semibold">{s.value}</div>
            {s.hint && <div className="text-[10px] text-muted-foreground">{s.hint}</div>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Log Viewer
// ---------------------------------------------------------------------------

export function LogsViewerClient() {
  const [source, setSource] = useState<LogSource>("portal");

  return (
    <>
      <HealthPanel />
      {/* Keyed remount on source change resets stream + lines cleanly */}
      <LogStream key={source} source={source} onSourceChange={setSource} />
    </>
  );
}

interface LogStreamProps {
  source: LogSource;
  onSourceChange: (s: LogSource) => void;
}

function LogStream({ source, onSourceChange }: LogStreamProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [connected, setConnected] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const pausedRef = useRef(paused);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Open EventSource on mount; cleanup on unmount.
  // Parent passes a fresh `key` when source changes, so this effect runs once per source.
  useEffect(() => {
    const es = new EventSource(`/api/admin/logs/stream?source=${source}`);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      const parsed = parseLine(ev.data);
      setLines((prev) => {
        const next = [...prev, parsed];
        if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
        return next;
      });
    };

    es.addEventListener("meta", (ev) => {
      try {
        const obj = JSON.parse((ev as MessageEvent).data) as Record<string, unknown>;
        if (obj.warning) {
          setLines((prev) => [
            ...prev,
            { raw: String(obj.warning), parsed: false } as PlainLine,
          ]);
        }
      } catch {}
    });

    return () => {
      es.close();
    };
  }, [source]);

  // Auto-scroll to bottom on new lines
  useEffect(() => {
    if (autoScroll && !paused) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [lines, autoScroll, paused]);

  const filtered = filter
    ? lines.filter((l) => l.raw.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  const clearLines = useCallback(() => {
    setLines([]);
    setExpandedIdx(null);
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Source tabs */}
          <div className="inline-flex rounded-md border bg-muted p-1">
            <button
              onClick={() => onSourceChange("portal")}
              className={`px-3 py-1 text-sm rounded ${
                source === "portal" ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              Portal
            </button>
            <button
              onClick={() => onSourceChange("cron")}
              className={`px-3 py-1 text-sm rounded ${
                source === "cron" ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              Cron
            </button>
          </div>

          {/* Connection indicator */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={`h-2 w-2 rounded-full ${
                connected ? "bg-green-500" : "bg-zinc-400"
              }`}
            />
            {connected ? "Conectado" : "Desconectado"}
            <span className="text-zinc-500">·</span>
            <span>{filtered.length} líneas</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Input
            placeholder="Filtrar líneas…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 max-w-xs text-sm"
          />
          <Button
            size="sm"
            variant={paused ? "default" : "outline"}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? "Reanudar" : "Pausar"}
          </Button>
          <Button
            size="sm"
            variant={autoScroll ? "default" : "outline"}
            onClick={() => setAutoScroll((a) => !a)}
          >
            Auto-desplazar
          </Button>
          <Button size="sm" variant="outline" onClick={clearLines}>
            Limpiar
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="h-[70vh] overflow-y-auto bg-zinc-950 font-mono text-xs">
          {filtered.length === 0 && (
            <div className="p-4 text-center text-zinc-500">
              Sin líneas que mostrar.
            </div>
          )}
          {filtered.map((line, i) => {
            const idx = i;
            if (line.parsed) {
              const cls = levelClass(line.level);
              const ctxKeys = Object.keys(line.ctx);
              const expanded = expandedIdx === idx && ctxKeys.length > 0;
              const time = line.time ? line.time.split("T")[1]?.slice(0, 12) ?? line.time : "";
              return (
                <div key={idx} className={`px-3 py-0.5 ${cls}`}>
                  <div
                    className={ctxKeys.length > 0 ? "cursor-pointer" : ""}
                    onClick={() => ctxKeys.length > 0 && setExpandedIdx(expanded ? null : idx)}
                  >
                    <span className="text-zinc-500">{time}</span>{" "}
                    <span className="font-semibold">{levelLabel(line.level)}</span>{" "}
                    <span>{line.msg ?? ""}</span>
                    {ctxKeys.length > 0 && !expanded && (
                      <span className="ml-2 text-zinc-500">
                        {`{${ctxKeys.slice(0, 4).join(", ")}${
                          ctxKeys.length > 4 ? ", …" : ""
                        }}`}
                      </span>
                    )}
                  </div>
                  {expanded && (
                    <pre className="mt-1 ml-6 overflow-x-auto whitespace-pre-wrap text-[11px] text-zinc-400">
                      {JSON.stringify(line.ctx, null, 2)}
                    </pre>
                  )}
                </div>
              );
            }
            return (
              <div
                key={idx}
                className={`whitespace-pre-wrap break-all px-3 py-0.5 ${plainLineClass(
                  line.raw
                )}`}
              >
                {line.raw}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </CardContent>
    </Card>
  );
}
