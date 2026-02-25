FROM node:22-slim AS base

# --- Dependencies ---
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Dev (deps + ML tooling for development) ---
FROM deps AS dev
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-venv curl libgl1 libglib2.0-0 ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv

# --- Builder ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build

# --- Runner ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# System deps: python3 for ML, curl for uv, libgl1/libglib2 for OpenCV, cron for backups, libsndfile1 for librosa
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv curl wget libgl1 libglib2.0-0 cron ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Timezone: US Eastern (for backup filenames and cron logs)
ENV TZ=America/New_York
RUN ln -sf /usr/share/zoneinfo/America/New_York /etc/localtime

# Install uv (fast Python package manager) for ML venv setup
RUN curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs scripts ./scripts
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh

# Hourly backup cron — Debian /etc/cron.d/ format (requires root user field)
COPY scripts/crontab /etc/cron.d/portal-backup
RUN chmod 0644 /etc/cron.d/portal-backup

EXPOSE 3000
ENV PORT=3000 HOSTNAME="0.0.0.0"
ENTRYPOINT ["sh", "docker-entrypoint.sh"]
