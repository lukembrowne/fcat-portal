# FCAT Portal

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Internal web application for [FCAT](https://www.fcat-ecuador.org/) (Fundación para la Conservación de los Andes Tropicales) staff and collaborators, running at `portal.fcat-ecuador.org`.

It is the working system behind FCAT's biodiversity monitoring in the Ecuadorian Chocó. Camera-trap images and passive audio recordings arrive from the field in Google Drive; the portal ingests them, runs species detection and classification, lets biologists review and correct what the models found, and turns the reviewed data into occupancy models, dashboards, and public pages. Alongside that it carries the day-to-day administrative modules — field schedules, climate data, finances, grant tracking, research applications.

The interface is in Spanish; routes and code are in English.

**Stack:** Next.js 16 (App Router, React 19, TypeScript) · SQLite + Drizzle ORM · Python (PyTorch-Wildlife, BirdNET) for ML · R (`unmarked`) for occupancy models · Docker for everything.

## Modules

| Module | Route | What it does |
|---|---|---|
| Cámaras Trampa | `/camera-trap` | Drive sync, MegaDetector + species classifier pipeline, annotation review, exports |
| Grabaciones | `/audio` | Audio sync, BirdNET analysis, acoustic indices, spectrogram review, confidence-threshold validation |
| BioChocó | `/biochoco` | Field schedule, deployment data, habitat, iButton temperature, results dashboards, landowner pages |
| Ocupación | `/ocupacion` | Occupancy models fit in R, with predicted-occurrence maps |
| Datos Climáticos | `/climate` | Weather-station uploads and dashboards |
| Finanzas | `/finance` | Cash flow, revenue, expenses, payroll, budget |
| Grant Tracking | `/grants` | Proposals, deadlines, reminders (intentionally in English — shared with external collaborators) |
| Aplicaciones de Investigadores | `/research-applications` | Visiting-researcher application workflow |
| Admin | `/admin` | Users and permissions, job queue, system activity, logs, Shared Drive capacity |

## Quick start

Everything runs in Docker — you do not need Node, Python, or R installed locally.

**Prerequisites:** Docker Desktop (or Docker Engine + Compose v2) and git.

```bash
git clone https://github.com/lukembrowne/fcat-portal.git
cd fcat-portal

# 1. Config files (both are gitignored; the examples are the templates)
cp .env.example .env.local
cp docker-compose.override.yml.example docker-compose.override.yml

# 2. Open docker-compose.override.yml and put YOUR email in both
#    DEV_USER_EMAIL and SUPER_ADMIN_EMAILS. They have to match — that is
#    how you're logged in locally.

# 3. Start it. The first build takes a while — it compiles better-sqlite3
#    and builds the R/unmarked runtime from source.
docker compose up -d

# 4. Create the database schema and seed dev data
docker compose exec portal node scripts/push-schema.mjs
docker compose exec portal npx tsx scripts/seed-dev.ts

# 5. Watch it boot
docker compose logs -f portal
```

Open **http://localhost:3003**.

There is no login screen in development. `src/proxy.ts` reads `DEV_USER_EMAIL` from the compose override and looks that email up in the `users` table — which is exactly the row `seed-dev.ts` created from `SUPER_ADMIN_EMAILS`. If the two don't match you'll be signed in as a user who doesn't exist, and every page will refuse you.

You can browse the whole portal at this point; it just has no data in it yet. The Google Drive, ODK Central, and email integrations stay dormant until you supply their credentials (see [Environment variables](#environment-variables)), and the ML pipeline installs itself in the background (see [ML pipeline](#ml-pipeline)).

### Getting something to look at

`seed-dev.ts` creates projects and your user, and nothing else — most pages will be empty. To populate the portal with realistic structure (deployments, camera images, detections, audio identifications) without touching production data:

```bash
docker compose exec portal npx tsx scripts/seed-occupancy-dev.ts --synthetic
```

Everything it writes hangs off deployments named `OCC-SEED-*`, and `--clean` removes the lot. `scripts/seed-detected-species.mjs` and `scripts/seed-test-verified-detections.mjs` fill in species and verified-detection data for the annotation and export flows.

**A copy of the production database is not a dev fixture.** It holds landowner names paired with precise site coordinates, staff salaries, and contact details. Work from the synthetic seeds; if a task genuinely needs real data, ask for a narrowed extract rather than the whole file.

### How dev mode works

`docker-compose.yml` describes production. `docker-compose.override.yml` — which Compose loads automatically when present — swaps in the development setup:

- builds the `dev` image target instead of the production one,
- runs `next dev` with hot reload, with your working tree bind-mounted at `/app`,
- reads `.env.local`,
- sets `DEV_USER_EMAIL` so the auth proxy has someone to be,
- keeps `oauth2-proxy` from starting (it sits behind a `production` profile).

So `docker compose up` is dev, and `docker compose -f docker-compose.yml up --build` — ignoring the override — is production.

### Everyday commands

```bash
docker compose up -d                  # start
docker compose logs -f portal         # follow logs
docker compose restart portal         # restart after changing env vars
docker compose down                   # stop

docker compose exec portal sh         # shell inside the container
docker compose exec portal npm test   # anything else runs the same way
```

Editing files under `src/` hot-reloads. Everything else needs a nudge:

| You changed | Do this |
|---|---|
| `package.json` dependencies | `docker compose up -d -V --build` — the `-V` matters, see below |
| `src/db/schema.ts` | `docker compose exec portal node scripts/push-schema.mjs` |
| `.env.local` or compose env | `docker compose restart portal` |
| `Dockerfile` | `docker compose up -d --build` |

**Why `-V`:** `node_modules` and `.next` live in anonymous volumes so the container's Linux-native builds aren't clobbered by the host mount. Without `-V`, Compose reuses the old volumes and your new dependency is silently missing.

**Don't run scripts from the host.** Run them with `docker compose exec portal ...`. A host `node`/`npx` process touching `data/portal.db` while the container has it open corrupts the WAL across the macOS bind mount — the symptom is transient `IOERR_SHORT_READ` and phantom index corruption.

## ML pipeline

Species detection (camera traps), BirdNET (audio), acoustic indices, and spectrograms run as Python subprocesses. The venv is **not** baked into the image — `scripts/ensure-ml-venv.sh` builds it with `uv` on first boot into `data/ml-venv/`, which is a named Docker volume, so it survives restarts and rebuilds.

- Expect **5–10 minutes** on first run: PyTorch, PyTorch-Wildlife, BirdNET, librosa, rasterio, and friends, plus a pre-warm that downloads the MegaDetector and classifier weights (~400 MB, cached under `data/ml-cache/`).
- Follow it with `docker compose logs -f portal | grep ml-setup`. The app serves requests the whole time; only ML jobs wait.
- To force a clean reinstall: `docker compose down`, then `docker volume ls | grep ml-venv` and `docker volume rm <name>`, then `docker compose up -d`.
- There is no mock fallback. If the venv isn't ready, ML jobs fail with an explicit error rather than inventing results.
- The venv is built for the container's platform. Running `data/ml-venv/bin/python3` from the host gives spurious `ModuleNotFoundError`s — always verify through `docker compose exec`.

R (`r-base` 4.5 + `unmarked`, for `/ocupacion`) is a different story: it *is* baked into the image, built from conda-forge in a separate Dockerfile stage. That stage is most of the first build's runtime, and it's cached afterwards.

## Environment variables

`.env.example` is the annotated list. Copy it to `.env.local` and fill in only what you need — every integration degrades to "unavailable" rather than crashing.

Nothing is required for a basic local run. The ones you're most likely to want:

| Variable | Purpose |
|---|---|
| `DEV_USER_EMAIL` | Who you are in dev (set in the compose override, not `.env.local`) |
| `SUPER_ADMIN_EMAILS` | Comma-separated super admins; the first is the user `seed-dev.ts` creates |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Base64 service-account JSON for Drive + Sheets |
| `CAMERA_TRAP_ROOT_FOLDER_ID` | Drive folder holding camera-trap deployments |
| `ODK_CENTRAL_URL` / `_EMAIL` / `_PASSWORD` | ODK Central, the source of field forms |
| `RESEND_API_KEY` | Outbound email (reports, reminders, alerts) |
| `CRON_SECRET` | Bearer token the scheduled jobs authenticate with |

Google Drive lives on Shared Drives, so every Drive API call needs `supportsAllDrives: true` — without it the API returns empty results and no error.

## Testing

Unit and integration tests, and the production build, run in the container:

```bash
docker compose exec portal npm run test:run   # Vitest, single run
docker compose exec portal npm test           # Vitest, watch
docker compose exec portal npm run build      # type check + production build
```

End-to-end tests need Playwright's browsers, which aren't in the image, so run those on the host:

```bash
npm install && npx playwright install chromium
npm run test:e2e
```

`playwright.config.ts` starts its own dev server on port 3000, separate from the container on 3003.

`tests/unit` and `tests/integration` are Vitest, `tests/e2e` is Playwright, `tests/python` covers the ML runners.

## Layout

```
src/
├── app/            # App Router: one directory per module, plus api/ (Drive proxying,
│                   # image serving, SSE progress, cron endpoints)
├── components/     # Shared UI (shadcn/ui + Radix in components/ui)
├── db/             # Drizzle schema + the SQLite singleton
├── lib/            # Domain logic: Drive client, ML runners, job queue, auth,
│                   # occupancy, birdnet-validation, finance, grants
└── proxy.ts        # Auth header handling (Next.js 16's renamed middleware.ts)

scripts/            # Python/R runners, schema push, seeds, backups, one-off migrations
tests/              # unit · integration · e2e · python
docs/               # Brainstorms, plans, runbooks, and solutions to past problems
data/               # Gitignored: SQLite DB, caches, ML venv, backups
nginx/              # Production vhost, synced by deploy.sh
```

## Architecture notes

**Auth.** In production, oauth2-proxy authenticates against Google and passes `X-Forwarded-Email`; `src/proxy.ts` forwards the header and `getCurrentUser()` resolves it against the `users` table. Authorization is per-project: every server action calls `requirePermission(projectId, minRole)` or `requireAdmin()`. Hiding a button is never the control.

**Database.** One SQLite file (`data/portal.db`) in WAL mode, through a Drizzle singleton. Schema changes go through `scripts/push-schema.mjs`, which is idempotent and runs automatically at production boot.

**Background jobs.** Long work (ML inference, Drive sync, audio compression, occupancy fitting) is queued as job rows and drained by an in-process worker, with progress streamed to the UI over SSE. In-container cron handles the recurring work: hourly DB backup, nightly data refresh and audio batch, weekly occupancy refits, daily alert emails.

**Scale.** Camera-trap folders fan out across several Google Shared Drives to stay under Google's 500,000-item-per-drive cap, and ML jobs download in disk-budgeted chunks so a large deployment can't fill the host.

`CLAUDE.md` documents the conventions and accumulated gotchas in far more detail; `docs/solutions/` records specific problems and their fixes.

## Contributing

Work on a branch and open a pull request against `main`; the maintainer reviews and merges, and deployment follows separately.

```bash
git checkout -b feat/short-description
# ...work, with the dev container running...
docker compose exec portal npm run test:run
docker compose exec portal npm run build     # catches type errors CI would catch
git push -u origin feat/short-description
```

Before pushing, a few rules that matter more than usual here because this repository is public and the data behind it is not:

- **Never commit real personal data.** Landowner or staff names paired with coordinates, salaries, or contact details. Test fixtures use invented names and synthetic amounts.
- **Never commit screenshots of the portal.** A single UI capture can carry landowner names and precise site coordinates into git history permanently. `.gitignore` blocks `screenshots/`; keep documentation text-only.
- `data/`, `.env.local`, and `docker-compose.override.yml` are gitignored and should stay that way — they hold the database, credentials, and your personal dev settings.
- Check `git diff --cached` before committing. The working tree often carries changes from more than one thread of work; `git add -p` helps.

`CLAUDE.md` is the detailed convention guide — UI strings in Spanish, `ActionResult<T>` return types, `requirePermission()` on every server action, sortable tables — and is worth reading before the first substantial change.

## Production

Deployed on a DigitalOcean droplet behind nginx, with oauth2-proxy for Google SSO.

```bash
./deploy.sh            # pull, build, restart, sync nginx, migrate
./deploy.sh --quick    # skip the rebuild (config/data changes only)
./deploy.sh --logs     # deploy, then tail logs
```

**Deploying requires direct access to the production droplet, which contributors do not have.** `deploy.sh` shells into the server over an SSH alias named `digitalocean`, so it only works from a machine whose key is authorized there — in practice, the maintainer's. Running it without that access fails at the first `ssh` and changes nothing. Getting a feature into production means opening a pull request; the deploy is a separate step someone else runs after merging.

Build and restart are separate steps so a failed build leaves the running container alone. First-time server setup is documented in the header of `deploy.sh`.

## License

Source code is [MIT licensed](LICENSE). Use it, change it, build on it.
