import { sql } from "drizzle-orm"

import { db } from "@/db"

// Readiness checks dependencies. Liveness stays on /api/health so a database
// blip does not restart otherwise healthy pods.
export async function GET() {
  try {
    await db.execute(sql`select 1`)
    return Response.json({ status: "ready" })
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 })
  }
}
