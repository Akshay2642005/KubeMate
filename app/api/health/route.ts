// Kubernetes readiness/liveness endpoint. It says the server is up, not that
// the database or any other dependency is healthy.
export function GET() {
  return Response.json({ status: "ok" })
}
