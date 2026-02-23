---
module: Camera Trap
date: 2026-02-23
problem_type: runtime_error
component: database
symptoms:
  - "TypeError: Transaction function cannot return a promise"
  - "Job fails immediately during video frame extraction phase"
  - "Error at db.transaction(async (tx) => {...}) call site"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [better-sqlite3, drizzle, transaction, async, synchronous, sqlite]
---

# Troubleshooting: Async Transaction Callback with better-sqlite3

## Problem
Using `await db.transaction(async (tx) => {...})` with Drizzle ORM + better-sqlite3 throws `TypeError: Transaction function cannot return a promise`. The better-sqlite3 driver wraps transactions synchronously and rejects async callbacks.

## Environment
- Module: Camera Trap processing pipeline
- Affected Component: `src/app/camera-trap/actions.ts:311` (video frame insertion)
- Database: SQLite via better-sqlite3 + Drizzle ORM
- Date: 2026-02-23

## Symptoms
- `TypeError: Transaction function cannot return a promise` at runtime
- Processing jobs fail during video frame extraction phase
- Error only appears at runtime — `npm run build` and `tsc --noEmit` do NOT catch this
- Multiple jobs failed in sequence (queue auto-advanced through each, all hitting the same error)

## What Didn't Work

**Direct solution:** The problem was identified from the error message and fixed by removing the async/await from the transaction callback.

## Solution

Remove `async`/`await` from the transaction callback. With better-sqlite3, Drizzle queries inside transactions execute synchronously — they return results directly, not Promises.

**Code changes:**

```typescript
// Before (broken):
await db.transaction(async (tx) => {
  for (const frame of result.frames) {
    const [frameImage] = await tx
      .insert(images)
      .values({ /* ... */ })
      .returning();
    // ...
  }
});

// After (fixed) — option A: synchronous transaction
db.transaction((tx) => {
  for (const frame of result.frames) {
    const [frameImage] = tx
      .insert(images)
      .values({ /* ... */ })
      .returning();
    // ...
  }
});

// After (fixed) — option B: no transaction, sequential awaits (used in this case)
// When you need .returning() for IDs and the async Drizzle API:
for (const frame of result.frames) {
  const [frameImage] = await db
    .insert(images)
    .values({ /* ... */ })
    .returning();
  // Use frameImage.id for thumbnails etc.
}
```

**In this case, option B was chosen** because the frame insertion needed `.returning()` to get auto-increment IDs for thumbnail filename generation, and the synchronous Drizzle `.returning()` has different TypeScript types that don't destructure the same way as the async version.

## Why This Works

1. **Root cause:** `better-sqlite3` is a synchronous SQLite driver. Its `.transaction()` method wraps a synchronous function — it calls `BEGIN`, runs the callback synchronously, then calls `COMMIT` or `ROLLBACK`. If the callback returns a Promise (i.e., is `async`), it throws immediately.

2. **Drizzle has two APIs:** The Drizzle ORM `db` object with better-sqlite3 exposes both sync methods (`.run()`, `.all()`, `.get()`) and async-looking methods (`.returning()` which can be awaited outside transactions). Inside a synchronous `db.transaction()` callback, you must use the sync API only.

3. **TypeScript doesn't catch this:** The Drizzle type definitions for `db.transaction()` accept both sync and async callbacks (the types are generic). The error only surfaces at runtime when better-sqlite3's native code rejects the Promise return value.

## Prevention

- **Always check existing transaction patterns** in the codebase before adding new ones. In this project, all working transactions use synchronous callbacks:
  - `src/app/finance/data/actions.ts` — `db.transaction((tx) => { tx.run(sql\`...\`); })`
  - `src/app/climate/upload/actions.ts` — `db.transaction((tx) => { tx.run(sql\`...\`); })`
- **If you need `.returning()` with auto-increment IDs** for subsequent I/O (like thumbnail generation), skip the transaction wrapper and use sequential `await db.insert().returning()` calls. SQLite WAL mode + `busy_timeout` handles concurrent writes safely.
- **The `better-sqlite3` transaction callback must be a plain function** — never `async`. If TypeScript allows it, the types are lying.

## Related Issues

No related issues documented yet.
