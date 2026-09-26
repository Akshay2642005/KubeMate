import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import * as schema from "./schema"

// Reuse the pool across HMR reloads in development
const globalForDb = globalThis as unknown as { pool?: Pool }

function createPool() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl)
    throw new Error("Missing required environment variable: DATABASE_URL")
  return new Pool({ connectionString: databaseUrl })
}

const pool = globalForDb.pool ?? createPool()

if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = pool
}

export const db = drizzle({ client: pool, schema, casing: "snake_case" })
