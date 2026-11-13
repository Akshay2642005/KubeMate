import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import * as schema from "./schema"

// Reuse the pool across HMR reloads in development
const globalForDb = globalThis as unknown as { pool?: Pool }

function createPool() {
  // Kubernetes injects discrete PG* variables (PGHOST, PGPORT, PGDATABASE,
  // PGUSER, PGPASSWORD) which pg picks up natively — no URL encoding needed,
  // so passwords with reserved characters cannot break the connection.
  // Local development keeps using DATABASE_URL from .env.local.
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
    })
  }
  return new Pool({ connectionTimeoutMillis: 5000 })
}

const pool = globalForDb.pool ?? createPool()

if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = pool
}

export const db = drizzle({ client: pool, schema, casing: "snake_case" })
