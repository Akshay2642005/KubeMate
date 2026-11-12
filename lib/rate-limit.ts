// Simple in-memory sliding-window rate limiting for the internal workspace.
// This is a quota guard, not a security boundary: it stops model-quota and
// memory exhaustion from a loop stuck retrying a chat, nothing more.

const globalForRateLimit = globalThis as unknown as {
  __kubemateRateLimit?: Map<string, { count: number; resetAt: number }>
}

const store =
  globalForRateLimit.__kubemateRateLimit ??
  (globalForRateLimit.__kubemateRateLimit = new Map<
    string,
    { count: number; resetAt: number }
  >())

// Keep the map bounded; expired entries are swept lazily on insert.
const SWEEP_AT = 1000

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now()

  if (store.size >= SWEEP_AT) {
    for (const [k, bucket] of store) {
      if (bucket.resetAt <= now) store.delete(k)
    }
  }

  const bucket = store.get(key)
  if (!bucket || bucket.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true as const }
  }
  if (bucket.count >= limit) {
    return {
      ok: false as const,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    }
  }
  bucket.count += 1
  return { ok: true as const }
}

// A chat turn is a single user message; pasted logs can be large, but never
// larger than this.
export const MAX_CHAT_BODY_BYTES = 64 * 1024