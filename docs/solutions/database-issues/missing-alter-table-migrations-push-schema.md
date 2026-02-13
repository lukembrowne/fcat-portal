---
title: Missing ALTER TABLE Migrations for New Schema Columns
category: database-issues
tags: [sqlite, drizzle, migrations, schema, push-schema]
module: camera-trap
symptoms:
  - 'SqliteError: no such column: "project_label"'
  - 'SqliteError: no such column: "some_new_column"'
  - New column works on fresh DB but fails on existing DB
date: 2026-02-13
---

# Missing ALTER TABLE Migrations for New Schema Columns

## Problem

Adding new columns to a table definition in `src/db/schema.ts` does not automatically migrate existing databases. The column exists in the Drizzle schema (so TypeScript/queries reference it) but is missing from the actual SQLite table on deployed databases.

## Symptoms

1. **Runtime SqliteError**: `no such column: "column_name"` when querying a table that has new columns in the schema
2. **Works locally but fails in production**: Fresh databases (created after the schema change) work fine; existing databases (created before the change) crash
3. **Works after deleting the DB**: Deleting `data/portal.db` and re-running `push-schema.mjs` "fixes" it because the table is recreated from scratch

## Root Cause

`scripts/push-schema.mjs` uses `CREATE TABLE IF NOT EXISTS` for each table. When deploying to an existing database:

- The table already exists, so `CREATE TABLE IF NOT EXISTS` is a **no-op**
- The new columns defined in the `CREATE TABLE` statement are **silently ignored**
- No error is raised — the table just keeps its old schema
- Queries referencing the new column then fail at runtime

## Solution

Add an `ALTER TABLE ADD COLUMN` statement to the `migrations` array in `scripts/push-schema.mjs`:

```javascript
const migrations = [
  // ... existing migrations ...

  // Add new_column to existing_table (added YYYY-MM-DD)
  `ALTER TABLE existing_table ADD COLUMN new_column TEXT`,
];
```

The migrations array runs after table creation. Each `ALTER TABLE` is wrapped in a try/catch that ignores "duplicate column name" errors, making them safe to run repeatedly (idempotent).

### Example: Adding `project_label` to `ct_jobs`

```javascript
// In the migrations array:
`ALTER TABLE ct_jobs ADD COLUMN project_label TEXT`,
```

This was needed when `ct_jobs` gained a `project_label` column in `schema.ts`. Fresh databases got the column via `CREATE TABLE`, but existing databases needed this migration.

## Prevention Checklist

Whenever you add a column to any table in `src/db/schema.ts`:

1. **Add an ALTER TABLE migration** in `scripts/push-schema.mjs` → `migrations` array
2. **Include a DEFAULT value** if the column is `NOT NULL` (SQLite requires a default for `ADD COLUMN ... NOT NULL`)
3. **Test on an existing database** — don't just test with a fresh DB
4. **Deploy and run** `docker compose exec portal node scripts/push-schema.mjs` on the server

## Related

- Schema definitions: `src/db/schema.ts`
- Migration runner: `scripts/push-schema.mjs`
- [Git Worktree Missing Gitignored Files](../build-errors/git-worktree-missing-gitignored-files.md) — another cause of "no such column" errors (missing DB file, not missing column)
