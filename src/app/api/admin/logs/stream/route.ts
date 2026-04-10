/**
 * SSE Endpoint — Live Log Tail
 *
 * Streams new lines appended to a log file as Server-Sent Events.
 * Used by /admin/logs to watch portal/cron output without SSHing.
 *
 * Security: requireAdmin() — super admins only.
 *
 * Sources:
 *   ?source=portal → data/logs/portal.log    (main app + subprocesses)
 *   ?source=cron   → data/backups/cron.log   (backup cron + others)
 *
 * Behavior:
 *   1. On connect, send the last ~200 lines from the file
 *   2. Then watch the file via fs.watch + 1s stat poll fallback
 *   3. On each new chunk, split into lines and emit as SSE `data:` events
 *   4. If the file shrinks (rotation/truncate), reset the offset to 0
 *   5. Clean up watcher + poll on client disconnect
 *
 * Lifecycle pattern mirrors src/app/api/progress/route.ts.
 */

import { requireAdmin } from "@/lib/auth";
import { promises as fsp } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

const LOG_PATHS = {
  portal: path.join(process.cwd(), "data", "logs", "portal.log"),
  cron: path.join(process.cwd(), "data", "backups", "cron.log"),
} as const;

type Source = keyof typeof LOG_PATHS;

const TAIL_BYTES = 64 * 1024;
const TAIL_LINES = 200;
const POLL_MS = 1000;

async function readTail(filePath: string): Promise<{ lines: string[]; size: number }> {
  const stat = await fsp.stat(filePath);
  const readSize = Math.min(stat.size, TAIL_BYTES);
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, stat.size - readSize);
    const text = buf.toString("utf8");
    // Drop the first (potentially partial) line if we didn't start at offset 0.
    const allLines = text.split("\n");
    const lines = stat.size > readSize ? allLines.slice(1) : allLines;
    return {
      lines: lines.filter((l) => l.length > 0).slice(-TAIL_LINES),
      size: stat.size,
    };
  } finally {
    await fh.close();
  }
}

async function readFrom(filePath: string, offset: number): Promise<{ chunk: string; size: number }> {
  const stat = await fsp.stat(filePath);
  if (stat.size <= offset) return { chunk: "", size: stat.size };
  const len = stat.size - offset;
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    return { chunk: buf.toString("utf8"), size: stat.size };
  } finally {
    await fh.close();
  }
}

export async function GET(request: Request) {
  await requireAdmin();

  const { searchParams } = new URL(request.url);
  const sourceParam = searchParams.get("source") ?? "portal";
  if (!(sourceParam in LOG_PATHS)) {
    return new Response("Invalid source", { status: 400 });
  }
  const source = sourceParam as Source;
  const filePath = LOG_PATHS[source];

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let isActive = true;
      let watcher: FSWatcher | null = null;
      let pollTimer: NodeJS.Timeout | null = null;
      let offset = 0;
      let buffer = "";
      let reading = false;

      const sendLine = (line: string) => {
        if (!isActive || line.length === 0) return;
        try {
          // SSE: each line of data is one `data:` field; events terminate with \n\n.
          // Pino lines are single-line JSON so this is one event per log entry.
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        } catch {
          isActive = false;
        }
      };

      const sendMeta = (obj: object) => {
        if (!isActive) return;
        try {
          controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify(obj)}\n\n`));
        } catch {
          isActive = false;
        }
      };

      const cleanup = () => {
        isActive = false;
        if (watcher) {
          try { watcher.close(); } catch {}
          watcher = null;
        }
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        try { controller.close(); } catch {}
      };

      const drainNew = async () => {
        if (!isActive || reading) return;
        reading = true;
        try {
          const stat = await fsp.stat(filePath);
          if (stat.size < offset) {
            // file rotated or truncated — start over
            offset = 0;
            buffer = "";
            sendMeta({ rotated: true });
          }
          if (stat.size === offset) return;
          const { chunk, size } = await readFrom(filePath, offset);
          offset = size;
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) sendLine(line);
        } catch {
          // file may have been deleted; ignore and rely on next poll
        } finally {
          reading = false;
        }
      };

      // 1. Initial tail
      try {
        const { lines, size } = await readTail(filePath);
        offset = size;
        sendMeta({ source, tailLines: lines.length });
        for (const line of lines) sendLine(line);
      } catch {
        sendMeta({
          source,
          warning: `Log file not found yet: ${filePath}. Waiting for it to appear...`,
        });
      }

      // 2. Watch for changes (fs.watch is best-effort across filesystems)
      try {
        watcher = watch(filePath, { persistent: false }, () => {
          drainNew();
        });
      } catch {
        // file may not exist yet; rely on poll
      }

      // 3. Poll fallback — covers Docker bind-mounts where fs.watch is unreliable
      pollTimer = setInterval(drainNew, POLL_MS);

      // 4. Heartbeat comment every 15s to keep proxies from closing the connection
      const heartbeat = setInterval(() => {
        if (!isActive) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          isActive = false;
        }
      }, 15000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        cleanup();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
