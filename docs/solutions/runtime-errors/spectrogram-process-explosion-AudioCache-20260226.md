---
module: Grabaciones
date: 2026-02-26
problem_type: runtime_error
component: background_job
symptoms:
  - "Dozens of concurrent generate-spectrogram.py processes visible in top/htop"
  - "Repeated oauth2/auth requests every ~2 seconds on production"
  - "403 Forbidden on spectrogram/stream API for users with grabaciones but not camera-trap access"
  - "Server memory exhaustion from duplicate Python processes"
root_cause: async_timing
resolution_type: code_fix
severity: critical
tags: [fire-and-forget, deduplication, inflight, spectrogram, polling, process-spawn, grabaciones, permissions]
---

# Troubleshooting: Spectrogram Process Explosion + Stale Permission Check

## Problem

After splitting the grabaciones module from camera-trap, three audio API routes still checked `camera-trap` permissions (causing 403s). Separately, the spectrogram metadata endpoint used fire-and-forget background generation with no deduplication — every 2-second poll from the client spawned a new Python subprocess, leading to dozens of concurrent `generate-spectrogram.py` processes consuming all server memory.

## Environment
- Module: Grabaciones (audio annotation system)
- Framework: Next.js 16 / TypeScript
- Affected Component: `src/lib/audio-cache.ts`, `src/app/api/audio/` routes, annotation client
- Date: 2026-02-26

## Symptoms
- `top` showed 20+ concurrent `generate-spectrogram.py` Python processes for the same audio file
- Production logs showed oauth2/auth requests every ~2 seconds (the polling requests hitting oauth2-proxy)
- Users with `grabaciones` permission but not `camera-trap` got 403 on spectrogram, metadata, and stream endpoints
- Server memory usage spiked when users opened the annotation page

## What Didn't Work

**Direct solution:** The problems were identified through code review and server process inspection. The permission issue was a straightforward grep for stale project IDs. The process explosion required tracing the request flow from client poll → API route → audio-cache module.

## Solution

### Fix 1: Update permission checks (3 API routes)

Replace `"camera-trap"` with `"grabaciones"` in all audio API route permission checks:

```typescript
// Before (broken) — in spectrogram/route.ts, spectrogram/meta/route.ts, stream/route.ts:
user.permissions.some((p) => p.projectId === "camera-trap");

// After (fixed):
user.permissions.some((p) => p.projectId === "grabaciones");
```

### Fix 2: Add inflight deduplication to audio-cache.ts

```typescript
// Before: ensureAudioCached and ensureSpectrogramGenerated had no protection
// against concurrent calls. Each call to the /meta endpoint that saw
// spectrogramPath === null would fire off another background chain.

// After: Inflight map coalesces concurrent calls for the same file ID.
const inflight = new Map<string, Promise<unknown>>();

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// Public functions become thin wrappers:
export function ensureAudioCached(audioFileId: number): Promise<string> {
  return dedupe(`audio:${audioFileId}`, () => doEnsureAudioCached(audioFileId));
}

export function ensureSpectrogramGenerated(audioFileId: number) {
  return dedupe(`spec:${audioFileId}`, () => doEnsureSpectrogramGenerated(audioFileId));
}
```

### Fix 3: Client-side polling timeout + retry cap

```typescript
// Polling timeout: stop after ~3 minutes (90 polls x 2s)
const MAX_POLLS = 90;
// Inside useEffect:
if (pollCount >= MAX_POLLS) {
  setSpectrogramError("Tiempo de espera agotado generando espectrograma.");
  return;
}

// Image retry cap: stop after 3 failed image loads
const MAX_RETRIES = 3;
const handleImageError = useCallback(() => {
  setRetryCount((c) => {
    if (c >= MAX_RETRIES) {
      setSpectrogramError("No se pudo cargar la imagen del espectrograma.");
      return c;
    }
    setSpectrogramReady(false);
    setMetadata(null);
    return c + 1;
  });
}, []);
```

## Why This Works

**Permission bug:** When the grabaciones module was split from camera-trap (commit 8c4f304), the three API routes under `/api/audio/` were missed. They still gated access on the old `camera-trap` project ID, so users who had been granted `grabaciones` access (but not `camera-trap`) got 403 errors.

**Process explosion root cause:** The `/api/audio/spectrogram/meta` endpoint checks if `audioFile.cachePath` and `audioFile.spectrogramPath` exist in the DB. If not, it kicks off background work (fire-and-forget with `.catch(console.error)`). But the DB is only updated *after* the work completes. So every 2-second poll sees "not ready" and spawns another background chain. Each chain calls `ensureSpectrogramGenerated()` which spawns a Python subprocess via `execFile`. After 30 seconds: 15 concurrent Python processes for the same file.

The `dedupe()` function solves this by storing the in-progress promise in a Map keyed by file ID. Subsequent calls return the existing promise instead of starting new work. The `.finally()` cleanup ensures a fresh call can start after completion or failure.

The client-side caps are defense-in-depth — even if the server has issues, the client won't poll forever.

## Prevention

- **When using fire-and-forget patterns with polling:** Always add inflight deduplication. If a background task is triggered by an endpoint that gets polled, every poll will spawn a new instance unless you deduplicate.
- **When splitting modules/permissions:** Grep the entire codebase for the old project ID: `grep -r '"camera-trap"' src/` — don't just update the pages and actions, also check API routes.
- **Client polling should always have a max count.** Unbounded polling is a latent DoS if the server-side work fails silently.
- **Pattern:** Use `Map<string, Promise>` with `.finally(() => map.delete(key))` for any function that spawns expensive work and may be called concurrently with the same arguments.

## Related Issues

No related issues documented yet.
