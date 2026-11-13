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

// apiVersion is either a bare version ("v1") or a group/version pair
// ("apps/v1", "monitoring.coreos.com/v1").
const apiVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)?$/,
    "Invalid apiVersion."
  )

const kindSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z][A-Za-z0-9]*$/, "Invalid kind.")

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

export const scaleWorkloadInputSchema = z
  .object({
    namespace: namespaceNameSchema.default("default"),
    kind: z.enum(["deployment", "statefulset", "replicaset"]),
    name: resourceNameSchema,
    replicas: z.number().int().min(0).max(1000),
  })
  .strict()

export const restartWorkloadInputSchema = z
  .object({
    namespace: namespaceNameSchema.default("default"),
    kind: z.enum(["deployment", "statefulset", "daemonset"]),
    name: resourceNameSchema,
  })
  .strict()

export const deletePodInputSchema = z
  .object({
    namespace: namespaceNameSchema.default("default"),
    pod: resourceNameSchema,
    gracePeriodSeconds: z.number().int().min(0).max(86400).optional(),
  })
  .strict()

export const setNodeUnschedulableInputSchema = z
  .object({
    node: resourceNameSchema,
    unschedulable: z.boolean(),
  })
  .strict()

// A merge-patch (RFC 7386) document: top-level fields like "spec" or
// "metadata" are merged into the live object; null deletes a key.
export const patchResourceInputSchema = z
  .object({
    apiVersion: apiVersionSchema,
    kind: kindSchema,
    namespace: namespaceNameSchema.optional(),
    name: resourceNameSchema,
    patch: z.record(z.string(), z.unknown()),
  })
  .strict()

export const deleteResourceInputSchema = z
  .object({
    apiVersion: apiVersionSchema,
    kind: kindSchema,
    namespace: namespaceNameSchema.optional(),
    name: resourceNameSchema,
    gracePeriodSeconds: z.number().int().min(0).max(86400).optional(),
    propagationPolicy: z
      .enum(["Orphan", "Background", "Foreground"])
      .optional(),
  })
  .strict()

export const applyManifestInputSchema = z
  .object({
    manifest: z.string().trim().min(1).max(200_000),
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
  z.object({
    action: z.literal("scale_workload"),
    summary: z.string().trim().min(1).max(500),
    input: scaleWorkloadInputSchema,
  }),
  z.object({
    action: z.literal("restart_workload"),
    summary: z.string().trim().min(1).max(500),
    input: restartWorkloadInputSchema,
  }),
  z.object({
    action: z.literal("delete_pod"),
    summary: z.string().trim().min(1).max(500),
    input: deletePodInputSchema,
  }),
  z.object({
    action: z.literal("set_node_unschedulable"),
    summary: z.string().trim().min(1).max(500),
    input: setNodeUnschedulableInputSchema,
  }),
  z.object({
    action: z.literal("patch_resource"),
    summary: z.string().trim().min(1).max(500),
    input: patchResourceInputSchema,
  }),
  z.object({
    action: z.literal("delete_resource"),
    summary: z.string().trim().min(1).max(500),
    input: deleteResourceInputSchema,
  }),
  z.object({
    action: z.literal("apply_manifest"),
    summary: z.string().trim().min(1).max(500),
    input: applyManifestInputSchema,
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

// Kinds the generic patch/delete/apply tools must never touch. Cluster-scoped
// infrastructure (namespaces, nodes, PVs, storage classes, admission
// webhook configurations, CRDs) stays out of reach, and RBAC kinds are denied
// because a crafted RoleBinding could escalate the agent's own permissions.
const PROTECTED_RESOURCE_KINDS = new Set([
  "Namespace",
  "Node",
  "PersistentVolume",
  "StorageClass",
  "PriorityClass",
  "APIService",
  "MutatingWebhookConfiguration",
  "ValidatingWebhookConfiguration",
  "CustomResourceDefinition",
  "CSIDriver",
  "CSINode",
  "VolumeAttachment",
  "Role",
  "RoleBinding",
  "ClusterRole",
  "ClusterRoleBinding",
])

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

export function assertMutableResource(
  kind: string,
  namespace?: string
) {
  if (PROTECTED_RESOURCE_KINDS.has(kind)) {
    throw new Error(
      `Refusing to modify ${kind} resources through the generic tools. Use a dedicated, audited action instead.`
    )
  }
  if (namespace) assertMutableNamespace(namespace)
}

export function isProtectedResourceKind(kind: string) {
  return PROTECTED_RESOURCE_KINDS.has(kind)
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
