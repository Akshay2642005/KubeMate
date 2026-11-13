import { defineConfig } from "drizzle-kit"
import { existsSync } from "node:fs"

if (existsSync(".env.local")) process.loadEnvFile(".env.local")

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL

  // The Kubernetes job injects discrete PG* variables instead of a URL so
  // passwords never need percent-encoding. Assemble the URL here with proper
  // encoding for the migrator.
  const { PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD } = process.env
  if (!PGHOST || !PGDATABASE || !PGUSER) {
    throw new Error(
      "Set DATABASE_URL or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD."
    )
  }
  const user = encodeURIComponent(PGUSER)
  const password = PGPASSWORD ? `:${encodeURIComponent(PGPASSWORD)}` : ""
  return `postgresql://${user}${password}@${PGHOST}:${PGPORT ?? 5432}/${PGDATABASE}`
}

export default defineConfig({
  schema: "./db/schema.ts",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    // Direct (non-pooled) connection: schema changes need session state
    url: databaseUrl(),
  },
})
