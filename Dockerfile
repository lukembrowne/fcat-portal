FROM node:22-slim AS base

# --- Dependencies ---
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- R runtime for occupancy modeling (conda-forge; cross-arch) ---
# Built once here and copied into the dev + runner stages. Why conda-forge and
# not apt/CRAN: Debian's R is 4.2 (unmarked 1.5.x throws "invalid subscript type
# 'list'" on it), and NO prebuilt modern-R unmarked binary exists for arm64
# (CRAN's Debian repo + Posit P3M are amd64-only; host source builds hit the
# OpenMP link error "___kmpc_critical"). conda-forge ships r-base 4.5 + all of
# unmarked's heavy deps (Rcpp/RcppArmadillo/TMB/lme4/RcppEigen/jsonlite) as
# native arm64 AND amd64 binaries. On amd64 r-unmarked itself is a binary too; on
# arm64 only unmarked compiles from source — cleanly, against modern R +
# conda's llvm-openmp. The runner is pointed here via OCCUPANCY_RSCRIPT_PATH.
FROM base AS rbuild
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    ARCH="$(uname -m)"; \
    case "$ARCH" in \
      x86_64)  MSUB=linux-64 ;; \
      aarch64) MSUB=linux-aarch64 ;; \
      *) echo "unsupported arch $ARCH"; exit 1 ;; \
    esac; \
    mkdir -p /opt/micromamba/bin; \
    curl -Ls "https://micro.mamba.pm/api/micromamba/${MSUB}/latest" \
      | tar -xj -C /opt/micromamba/bin --strip-components=1 bin/micromamba; \
    if [ "$MSUB" = linux-64 ]; then \
      /opt/micromamba/bin/micromamba create -y -p /opt/rocc -c conda-forge \
        r-base r-jsonlite r-unmarked; \
    else \
      /opt/micromamba/bin/micromamba create -y -p /opt/rocc -c conda-forge \
        r-base r-jsonlite r-rcpp r-rcpparmadillo r-tmb r-lme4 r-rcppeigen r-pbapply \
        c-compiler cxx-compiler make llvm-openmp; \
      /opt/micromamba/bin/micromamba run -p /opt/rocc \
        Rscript -e 'install.packages("unmarked", repos="https://cloud.r-project.org")'; \
    fi; \
    /opt/micromamba/bin/micromamba run -p /opt/rocc \
      Rscript -e 'stopifnot(requireNamespace("unmarked", quietly=TRUE), requireNamespace("jsonlite", quietly=TRUE))'; \
    /opt/micromamba/bin/micromamba clean -a -y; \
    rm -rf /opt/micromamba

# --- Dev (deps + ML tooling for development) ---
FROM deps AS dev
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-venv curl libgl1 libglib2.0-0 ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv
# R runtime for occupancy modeling (see rbuild stage).
COPY --from=rbuild /opt/rocc /opt/rocc
ENV OCCUPANCY_RSCRIPT_PATH=/opt/rocc/bin/Rscript

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

# R runtime for occupancy modeling (see rbuild stage).
COPY --from=rbuild /opt/rocc /opt/rocc
ENV OCCUPANCY_RSCRIPT_PATH=/opt/rocc/bin/Rscript

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
