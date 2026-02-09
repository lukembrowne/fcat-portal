# Portal FCAT

Plataforma interna de FCAT para personal y colaboradores. Reemplaza los dashboards Streamlit en `internal.dashboards.fcat-ecuador.org`.

**Dominio:** `portal.fcat-ecuador.org`

## Quick Start (Development)

```bash
# Requires Node.js 22
nvm use 22

# Install dependencies
npm install

# Create database and seed
node scripts/push-schema.mjs
npx tsx scripts/seed-dev.ts

# Start dev server
npm run dev
```

Open http://localhost:3000. The dev server uses `DEV_USER_EMAIL` from `.env.local` for authentication.

## Environment Variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

| Variable | Default | Description |
|----------|---------|-------------|
| `DEV_USER_EMAIL` | — | Email for dev auth (required for local dev) |
| `DEV_USER_ROLE` | — | Optional role override for dev |
| `SUPER_ADMIN_EMAILS` | `lukebrowne@fcat-ecuador.org` | Comma-separated super admin emails |
| `DB_PATH` | `data/portal.db` | SQLite database path |
| `ML_PYTHON_PATH` | — | Path to Python with pytorch-wildlife |
| `ALLOWED_EMAILS_PATH` | `data/allowed_external_emails.txt` | oauth2-proxy email allowlist |

## ML Setup

The ML pipeline requires a Python virtual environment with `pytorch-wildlife` installed. This venv lives on the **host machine**, not in Docker.

```bash
# Create venv (on host)
python3 -m venv ~/ml-venv
source ~/ml-venv/bin/activate
pip install pytorch-wildlife torch torchvision

# Set in .env.local
ML_PYTHON_PATH=~/ml-venv/bin/python3
```

**CRITICAL:** If the host is rebuilt without reinstalling the venv, ML processing silently fails.

## Docker

### Development

```bash
docker compose up
```

Uses hot reload with source mounted.

### Production

```bash
docker compose -f docker-compose.yml up --build
```

### Deployment

```bash
./deploy.sh
```

Separates `docker compose build` from `docker compose up -d` so a build failure won't tear down the running container.

## Testing

```bash
npm test              # Vitest (watch mode)
npm run test:run      # Vitest (single run)
npm run test:e2e      # Playwright E2E tests
npm run test:all      # All tests
npm run build         # Type check + production build
```

## Project Structure

```
src/
├── app/
│   ├── camera-trap/    # Camera trap module
│   ├── admin/          # User management (super_admin only)
│   └── api/            # Image serving, SSE progress
├── components/         # Shared UI components
├── db/                 # Schema + connection
└── lib/                # Auth, ML runner, image scanner
scripts/                # ML inference, DB seed, schema push
tests/                  # Unit, integration, E2E tests
```

## Architecture

- **Auth:** oauth2-proxy → X-Forwarded-Email → proxy.ts → getCurrentUser() DB lookup
- **DB:** SQLite with WAL mode, Drizzle ORM, singleton connection
- **ML:** Python subprocess via NDJSON protocol, MPS/CUDA/CPU auto-detect
- **UI:** Spanish labels, English routes, Server Components for data, Client Components for interactivity
