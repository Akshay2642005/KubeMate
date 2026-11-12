import { z } from "zod"

const resourceNameSchema = z.string().trim().min(1).max(253)
const namespaceNameSchema = z.string().trim().min(1).max(63)

const nodeLabelKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9][-A-Za-z0-9_.\/]*[A-Za-z0-9]$/, "Invalid label key.")

const nodeLabelValueSchema = z.string().trim().min(1).max(63)

export const labelNodeInputSchema = z
  .object({
    node: resourceNameSchema,
    key: nodeLabelKeySchema,
    value: nodeLabelValueSchema,
  })
  .strict()

export const removeDeploymentNodeSelectorInputSchema = z
  .object({
    namespace: namespaceNameSchema.default("default"),
    deployment: resourceNameSchema,
  })
  .strict()

export const recreatePodWithoutNodeSelectorInputSchema = z
  .object({
    namespace: namespaceNameSchema.default("default"),
    pod: resourceNameSchema,
  })
  .strict()

// One schema per action, discriminated by `action`, so stored proposals and
// tool input are validated the same way and the input type narrows correctly.
export const actionProposalSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("label_node"),
    summary: z.string().trim().min(1).max(500),
    input: labelNodeInputSchema,
  }),
  z.object({
    action: z.literal("remove_deployment_node_selector"),
    summary: z.string().trim().min(1).max(500),
    input: removeDeploymentNodeSelectorInputSchema,
  }),
  z.object({
    action: z.literal("recreate_pod_without_node_selector"),
    summary: z.string().trim().min(1).max(500),
    input: recreatePodWithoutNodeSelectorInputSchema,
  }),
])

export type ActionProposal = z.infer<typeof actionProposalSchema>
export type ActionName = ActionProposal["action"]

// Namespaces the agent must never mutate, regardless of what the model proposes.
const PROTECTED_NAMESPACES = new Set([
  "kube-system",
  "kube-node-lease",
  "kube-public",
])

// The namespace the agent itself runs in, unless deployment overrides it.
const AGENT_NAMESPACE = process.env.AGENT_NAMESPACE ?? "kubernetes-agent"

// Label prefixes owned by Kubernetes or node lifecycle controllers. Allowing
// these to be overwritten can make nodes unschedulable or break the cluster.
const RESERVED_LABEL_PREFIXES = [
  "kubernetes.io/",
  "k8s.io/",
  "node.kubernetes.io/",
  "node-role.kubernetes.io/",
]

export function isProtectedNamespace(namespace: string) {
  return (
    PROTECTED_NAMESPACES.has(namespace) || namespace === AGENT_NAMESPACE
  )
}

export function assertMutableNamespace(namespace: string) {
  if (isProtectedNamespace(namespace)) {
    throw new Error(
      `Refusing to modify resources in protected namespace "${namespace}".`
    )
  }
}

export function assertNodeLabelKeyAllowed(key: string) {
  const reserved = RESERVED_LABEL_PREFIXES.find((prefix) =>
    key.startsWith(prefix)
  )
  if (reserved) {
    throw new Error(
      `Refusing to modify reserved node label "${key}" (prefix "${reserved}").`
    )
  }
}
