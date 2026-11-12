// Runtime split for the web tier and the Kubernetes-enabled agent runner.
//
// The web Deployment has no ServiceAccount token, so it cannot reach the
// Kubernetes API. The runner Deployment holds the read/write RBAC and serves
// the exact same routes in-process. When `INTERNAL_RUNNER_URL` is set, the
// web deployment forwards agent traffic there over the cluster network
// instead of executing the graph locally.
//
// In local development no environment variable is set, so everything runs
// in-process as usual.

const RUNNER_URL = process.env.INTERNAL_RUNNER_URL
const RUNNER_ROLE = process.env.KUBERNETES_AGENT_ROLE

export function isRunner() {
  return RUNNER_ROLE === "runner" || !RUNNER_URL
}

export async function proxyToRunner(
  path: string,
  body: string,
  signal?: AbortSignal
): Promise<Response> {
  // Propagate the browser's disconnect so the runner stops the graph
  // instead of burning model quota on a response nobody reads.
  let upstream: Response
  try {
    upstream = await fetch(`${RUNNER_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    })
  } catch (error) {
    // The browser already went away; there is nobody left to answer.
    if (signal?.aborted) return new Response(null, { status: 499 })
    throw error
  }

  const headers = new Headers()
  const contentType = upstream.headers.get("content-type")
  if (contentType) headers.set("content-type", contentType)

  // Streams the runner's SSE response straight back to the browser so the
  // client transport sees the exact same shapes it would in-process.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}