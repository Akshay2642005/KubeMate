import { defineConfig } from "drizzle-kit"
import { existsSync } from "node:fs"

if (existsSync(".env.local")) process.loadEnvFile(".env.local")

export default defineConfig({
  schema: "./db/schema.ts",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    // Direct (non-pooled) connection: schema changes need session state
    url: process.env.DATABASE_URL!,
  },
})
