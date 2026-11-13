import { sql } from "drizzle-orm"

import { db } from "@/db"

// Readiness checks dependencies. Liveness stays on /api/health so a database
// blip does not restart otherwise healthy pods.
export async function GET() {
  try {
    await db.execute(sql`select 1`)
    return Response.json({ status: "ready" })
  } catch (error) {
    // Surface the cause in pod logs; the probe response stays generic.
    console.error("[ready] database check failed", error)
    return Response.json({ status: "unavailable" }, { status: 503 })
  }
}
