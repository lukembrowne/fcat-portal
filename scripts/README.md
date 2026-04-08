# Scripts

## Database

### push-schema.mjs

Create all tables, indexes, and seed core projects. Idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`).

```bash
node scripts/push-schema.mjs
```

Add new projects by appending to the `coreProjects` array, then re-run.

### seed-dev.ts

Seed development data: projects, a super admin user, and species list.

```bash
npx tsx scripts/seed-dev.ts
```

### backup-db.mjs

Hot backup using SQLite's online backup API. Safe to run while the portal is serving requests. Enforces retention: all hourly backups for 48h, one daily for 7 days, older deleted.

```bash
node scripts/backup-db.mjs
```

Runs automatically every hour via cron inside Docker (see `crontab`).

### restore-db.sh

Restore a database from backup. Creates a pre-restore copy at `data/portal.db.pre-restore`.

```bash
./scripts/restore-db.sh              # Interactive — lists backups to choose from
./scripts/restore-db.sh latest       # Restore most recent backup
./scripts/restore-db.sh portal-2026-02-12T14-00-00.db  # Restore specific file
```

### fix-species-list.mjs

One-off migration to fix species list issues (typos, wrong types, redundant entries). Dry-run by default.

```bash
node scripts/fix-species-list.mjs          # Preview changes
node scripts/fix-species-list.mjs --apply  # Apply changes
```

## Data Import

### import-species-csv.mjs

Import species from a CSV file into the `biochoco_species` table. Uses upsert on `scientific_name`.

```bash
node scripts/import-species-csv.mjs path/to/western_ecuador.csv
```

CSV format: `species_id,common_name,scientific_name,type`

### import-historical-camera-data.ts

Enrich camera trap deployments and pre-fill species identifications using historical 2014 CSV data. Run **after** Drive sync + MegaDetector processing.

```bash
# Preview what would change (no DB writes)
npx tsx scripts/import-historical-camera-data.ts --dry-run

# Debug a single deployment
npx tsx scripts/import-historical-camera-data.ts --dry-run --deployment TP-062

# Run for real (back up first!)
node scripts/backup-db.mjs
npx tsx scripts/import-historical-camera-data.ts
```

The script:
1. Parses `Camera_log` and `species detection data` CSVs
2. Matches portal deployments by TP code in folder name
3. Sets lat/lng (UTM Zone 17N → WGS84) and start/end dates
4. Matches video filenames to ML-generated detections
5. Updates identifications with historical species (verified or corrected)

Idempotent — only touches `unverified` identifications. Safe to re-run.

## ML Pipeline

### ensure-ml-venv.sh

Install the Python ML virtual environment (`data/ml-venv/`) using `uv`. Called automatically by `docker-entrypoint.sh` on container startup. Delete `data/ml-venv/` to force reinstall.

### model-server.py

Persistent model server for MegaDetector V6 + species classifier. Loads models once, then accepts job configs via stdin NDJSON. Managed by the portal's ML job queue — not run directly.

## Google Drive

### copy-deployments-to-test-drive.sh

Copy deployment folders from `BIOCHOCO_Data` to `BIOCHOCO_Data_test/Biochoco` on the same Shared Drive using rclone. Uses server-side copy (no local download/upload). Safe — uses `rclone copy` which is additive and won't delete existing files.

**Prerequisites:** rclone installed with `gdrive-biochoco:` remote configured.

```bash
# Copy specific deployments
./scripts/copy-deployments-to-test-drive.sh CCN-001_V1 CCN-003_V1 GIZ-009_V1

# Preview what would be copied without copying
./scripts/copy-deployments-to-test-drive.sh --dry-run CCN-001_V1 CCN-003_V1

# Verify the copy
rclone lsd "gdrive-biochoco:BIOCHOCO_Data_test/Biochoco/CCN-001_V1"
```

## Diagnostics

### test-drive.mjs

Test Google Drive API access for a specific folder. Useful for verifying service account permissions.

```bash
node scripts/test-drive.mjs <folder-id>
```

Requires `GOOGLE_SERVICE_ACCOUNT_KEY` in `.env.local`.
