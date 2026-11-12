FROM oven/bun:1.4.3 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# Next.js evaluates the database module while collecting routes. The real
# runtime URL is injected by Kubernetes; this placeholder is build-only.
ENV DATABASE_URL=postgresql://kubernetes_agent:kubernetes_agent@localhost:5432/kubernetes_agent
RUN bun run build

# Minimal migrator payload for the db-push job. This keeps the ~1.3GB
# development node_modules out of the runtime image while giving the schema job
# exactly the dependencies it needs (drizzle-kit, drizzle-orm, pg, drizzle-zod,
# nanoid and zod) to push the schema.
FROM oven/bun:1.4.3 AS migrator

WORKDIR /opt/migrator

RUN printf '{"name":"kubemate-migrator","type":"module","private":true,"version":"0.0.0"}\n' > package.json
RUN bun add drizzle-kit@0.31.11 drizzle-orm@0.45.3 pg@8.23.1 drizzle-zod@0.8.3 nanoid@6.0.1 zod@4.6.5

COPY drizzle.config.ts ./
COPY db ./db

FROM oven/bun:1.4.3-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_PRIVATE_MINIMAL_MODE=1

COPY --from=builder --chown=bun:bun /app/public ./public
COPY --from=builder --chown=bun:bun /app/.next/standalone ./
COPY --from=builder --chown=bun:bun /app/.next/static ./.next/static
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
COPY --from=migrator --chown=bun:bun /opt/migrator /opt/migrator

USER bun

EXPOSE 3000

CMD ["bun", "server.js"]