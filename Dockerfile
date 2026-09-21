FROM oven/bun:1.4.3 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# Next.js evaluates the database module while collecting routes. The real
# runtime URL is injected by Kubernetes; this placeholder is build-only.
ENV DATABASE_URL=postgresql://kubernetes_agent:kubernetes_agent@localhost:5432/kubernetes_agent
RUN bun run build

FROM oven/bun:1.4.3-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_PRIVATE_MINIMAL_MODE=1

COPY --from=builder --chown=bun:bun /app/public ./public
COPY --from=builder --chown=bun:bun /app/.next/standalone ./
COPY --from=builder --chown=bun:bun /app/.next/static ./.next/static
COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
COPY --from=builder --chown=bun:bun /app/bun.lock ./bun.lock
COPY --from=builder --chown=bun:bun /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder --chown=bun:bun /app/db ./db

USER bun

EXPOSE 3000

CMD ["bun", "server.js"]
