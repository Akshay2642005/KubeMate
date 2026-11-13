import { z } from "zod"

export const MAX_TOOL_OUTPUT_CHARS = 6000

export function serializeToolOutput(value: unknown) {
  const json = JSON.stringify(value)
  if (json.length <= MAX_TOOL_OUTPUT_CHARS) return json

  return JSON.stringify({
    truncated: true,
    preview: json.slice(0, MAX_TOOL_OUTPUT_CHARS),
    note: `Output was truncated at ${MAX_TOOL_OUTPUT_CHARS} characters. Use a narrower query if more detail is needed.`,
  })
}

export function limitText(value: string) {
  if (value.length <= MAX_TOOL_OUTPUT_CHARS) return value
  return `${value.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[output truncated]`
}

export const namespaceSchema = z.object({
  namespace: z.string().trim().min(1).default("default"),
})

// Optional namespace: omit it to list across all namespaces.
export const optionalNamespaceSchema = z.object({
  namespace: z.string().trim().min(1).optional(),
})

export const labelSelectorSchema = z
  .string()
  .trim()
  .max(500)
  .optional()

export const fieldSelectorSchema = z
  .string()
  .trim()
  .max(500)
  .optional()

export const limitSchema = z.number().int().min(1).max(500).default(100)

// Compact per-item projection for generic list calls so a namespace-wide list
// stays readable instead of dumping full object specs.
export function summarizeResource(item: {
  apiVersion?: string
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
    labels?: Record<string, string>
    creationTimestamp?: unknown
  }
  status?: Record<string, unknown>
}) {
  const status = item.status ?? {}
  const summary: Record<string, unknown> = {
    apiVersion: item.apiVersion,
    kind: item.kind,
    name: item.metadata?.name,
    namespace: item.metadata?.namespace,
    labels: item.metadata?.labels,
    creationTimestamp: item.metadata?.creationTimestamp,
  }

  for (const key of [
    "phase",
    "replicas",
    "readyReplicas",
    "availableReplicas",
    "updatedReplicas",
    "currentReplicas",
    "desiredReplicas",
  ]) {
    if (status[key] !== undefined) summary[key] = status[key]
  }

  const conditions = status.conditions
  if (Array.isArray(conditions)) {
    summary.conditions = conditions.slice(0, 8).map((condition) => {
      const c = condition as Record<string, unknown>
      return {
        type: c.type,
        status: c.status,
        reason: c.reason,
        message:
          typeof c.message === "string" ? c.message.slice(0, 160) : undefined,
      }
    })
  }

  return summary
}
