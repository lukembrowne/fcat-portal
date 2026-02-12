---
title: Git Worktree Missing Gitignored Files
category: build-errors
tags: [git, worktree, docker, env, sqlite]
module: infrastructure
symptoms:
  - "oauth2-proxy: provider missing setting: client-id"
  - "failed opening authenticated-emails-file"
  - "SqliteError: no such column"
  - "Docker container can't find mounted files"
date: 2026-02-12
---

# Git Worktree Missing Gitignored Files

## Problem

When creating a git worktree for parallel development, `.gitignore`d files (`.env`, `data/portal.db`, `data/allowed_external_emails.txt`) don't exist in the new worktree. This causes cascading failures in both local dev and Docker.

## Symptoms

1. **oauth2-proxy fails**: `provider missing setting: client-id` — no `.env` with secrets
2. **Auth file missing**: `failed opening authenticated-emails-file` — `data/allowed_external_emails.txt` absent
3. **Schema errors**: `SqliteError: no such column: drive_folder_id` — database doesn't exist or has stale schema

## Root Cause

Git worktrees share the `.git` directory but create a fresh working tree. Files listed in `.gitignore` are never tracked, so they don't appear in new worktrees. For this project, that includes:

- `.env` / `.env.local` (secrets)
- `data/` directory (SQLite DB, external email allowlist, thumbnails, backups)
- `node_modules/`

## Solution

### Bootstrap checklist after `git worktree add`:

```bash
# 1. Symlink .env for local dev
ln -s /path/to/main-repo/.env.local .env
ln -s /path/to/main-repo/.env.local .env.local

# 2. Create data directory and COPY files Docker needs
mkdir -p data
cp /path/to/main-repo/data/allowed_external_emails.txt data/
cp /path/to/main-repo/data/portal.db data/   # or create fresh below

# 3. Install dependencies
npm install

# 4. Push schema (creates DB if missing, runs migrations)
node scripts/push-schema.mjs
```

### Critical: Docker volumes don't follow symlinks

Docker mounts resolve at the symlink path, not the target. If `data/allowed_external_emails.txt` is a symlink, Docker sees an empty/missing file inside the container.

**Rule: Always use real file copies for anything mounted into Docker.**

Symlinks are fine for local dev (Node.js/Next.js resolves them correctly).

## Prevention

- Keep a bootstrap script or document this checklist in the README
- Consider a `scripts/setup-worktree.sh` that automates the copy steps
- When adding new gitignored runtime files, remember they need manual setup in worktrees
