# syntax=docker/dockerfile:1
# Enterprise-grade multi-stage build for the Next.js standalone server.
# Final stage is a non-root runner based on oven/bun slim; builder stages are
# discarded and never ship to the registry. Based on the official
# with-docker example (vercel/next.js) for Bun projects.

# ============================================
# Stage 1: Install dependencies (cached layer)
# ============================================
FROM oven/bun:1.4.3-slim AS dependencies

WORKDIR /app

# Copy only the manifest files first to leverage Docker's layer caching.
COPY package.json bun.lock ./

# BuildKit cache mount keeps the bun install cache across builds without
# baking it into the image. --no-save mirrors the official example.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --no-save --frozen-lockfile

# ============================================
# Stage 2: Build the Next.js app (standalone output)
# ============================================
FROM oven/bun:1.4.3-slim AS builder

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Next.js evaluates the database module while collecting routes. The real
# runtime URL is injected by Kubernetes; this placeholder is build-only and
# never reaches the final image.
ENV DATABASE_URL=postgresql://kubernetes_agent:kubernetes_agent@localhost:5432/kubernetes_agent

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun run build

# ============================================
# Stage 3: Minimal migrator payload for the db-push job
# ============================================
# Keeps the ~1.3GB development node_modules out of the runtime image while
# giving the schema job exactly the dependencies it needs (drizzle-kit,
# drizzle-orm, pg, drizzle-zod, nanoid and zod) to push the schema.
FROM oven/bun:1.4.3-slim AS migrator

WORKDIR /opt/migrator

RUN printf '{"name":"kubemate-migrator","type":"module","private":true,"version":"0.0.0"}\n' > package.json
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun add drizzle-kit@0.31.11 drizzle-orm@0.45.3 pg@8.23.1 drizzle-zod@0.8.3 nanoid@6.0.1 zod@4.6.5

COPY drizzle.config.ts ./
COPY db ./db

# ============================================
# Stage 4: Runner (final image)
# ============================================
FROM oven/bun:1.4.3-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    # Internal minimal mode for self-hosted standalone servers: skips route
    # pathname normalization the platform ingress handles anyway.
    NEXT_PRIVATE_MINIMAL_MODE=1

LABEL org.opencontainers.image.title="KubeMate" \
      org.opencontainers.image.description="The AI command center for Kubernetes teams." \
      org.opencontainers.image.source="https://github.com/Akshay2642005/KubeMate"

# Standalone output bundles the server and the minimal node_modules it needs.
# public/ and .next/static are not part of the standalone trace and are
# copied explicitly.
COPY --from=builder --chown=bun:bun /app/public ./public
COPY --from=builder --chown=bun:bun /app/.next/standalone ./
COPY --from=builder --chown=bun:bun /app/.next/static ./.next/static
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
COPY --from=migrator --chown=bun:bun /opt/migrator /opt/migrator

USER bun

EXPOSE 3000

CMD ["bun", "server.js"]
