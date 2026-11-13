import type {
  AppsV1Api,
  CoreV1Api,
  KubernetesObject,
  KubernetesObjectApi,
} from "@kubernetes/client-node"
import { PatchStrategy } from "@kubernetes/client-node"
import { parseAllDocuments } from "yaml"

import type { ActionProposal } from "@/lib/chat-types"
import { getKubernetesClients } from "@/lib/agent/kubernetes/client"
import {
  actionProposalSchema,
  assertMutableNamespace,
  assertMutableResource,
  assertNodeLabelKeyAllowed,
  isProtectedNamespace,
  isProtectedResourceKind,
} from "@/lib/agent/kubernetes/proposals"

const POD_DELETE_TIMEOUT_MS = 30_000
const POD_DELETE_POLL_MS = 500
const POD_READY_TIMEOUT_MS = 120_000
const DEPLOYMENT_ROLLOUT_TIMEOUT_MS = 120_000

const RESTART_ANNOTATION = "kubectl.kubernetes.io/restartedAt"
const FIELD_MANAGER = "kubemate-agent"

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 404
  )
}

async function waitForPodDeletion(
  core: CoreV1Api,
  namespace: string,
  pod: string
) {
  const deadline = Date.now() + POD_DELETE_TIMEOUT_MS

  while (Date.now() < deadline) {
    try {
      await core.readNamespacedPod({ name: pod, namespace })
    } catch (error) {
      // A 404 means the API server has fully removed the pod.
      if (isNotFound(error)) return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, POD_DELETE_POLL_MS))
  }

  throw new Error(
    `Pod ${namespace}/${pod} was still terminating after ${POD_DELETE_TIMEOUT_MS / 1000}s. It was not recreated.`
  )
}

type PodResponse = Awaited<ReturnType<CoreV1Api["readNamespacedPod"]>>

function isPodReady(pod: PodResponse) {
  return (
    pod.status?.phase === "Running" &&
    pod.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True"
    ) === true
  )
}

async function waitForPodReady(core: CoreV1Api, namespace: string, pod: string) {
  const deadline = Date.now() + POD_READY_TIMEOUT_MS
  let latest: PodResponse | undefined

  while (Date.now() < deadline) {
    latest = await core.readNamespacedPod({ name: pod, namespace })
    if (isPodReady(latest)) return latest

    if (latest.status?.phase === "Failed") {
      throw new Error(
        `Pod ${namespace}/${pod} failed verification: ${latest.status.reason ?? latest.status.message ?? "phase is Failed"}.`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POD_DELETE_POLL_MS))
  }

  throw new Error(
    `Pod ${namespace}/${pod} was recreated but did not become Ready within ${POD_READY_TIMEOUT_MS / 1000}s (phase: ${latest?.status?.phase ?? "unknown"}).`
  )
}

async function waitForDeploymentRollout(
  apps: AppsV1Api,
  namespace: string,
  deployment: string
) {
  const deadline = Date.now() + DEPLOYMENT_ROLLOUT_TIMEOUT_MS
  let latest: Awaited<ReturnType<AppsV1Api["readNamespacedDeployment"]>> | undefined

  while (Date.now() < deadline) {
    latest = await apps.readNamespacedDeployment({ name: deployment, namespace })
    const desired = latest.spec?.replicas ?? 1
    const status = latest.status
    const observed = status?.observedGeneration === latest.metadata?.generation
    const available = (status?.availableReplicas ?? 0) >= desired
    const updated = (status?.updatedReplicas ?? 0) >= desired
    if (observed && available && updated) return latest
    await new Promise((resolve) => setTimeout(resolve, POD_DELETE_POLL_MS))
  }

  throw new Error(
    `Deployment ${namespace}/${deployment} was patched but did not become available within ${DEPLOYMENT_ROLLOUT_TIMEOUT_MS / 1000}s (available: ${latest?.status?.availableReplicas ?? 0}).`
  )
}

type ScaleClient = Pick<
  AppsV1Api,
  | "patchNamespacedDeployment"
  | "patchNamespacedStatefulSet"
  | "patchNamespacedReplicaSet"
  | "readNamespacedDeployment"
  | "readNamespacedStatefulSet"
  | "readNamespacedReplicaSet"
>

const SCALE_KIND_API = {
  deployment: {
    patch: "patchNamespacedDeployment",
    read: "readNamespacedDeployment",
    kind: "Deployment",
  },
  statefulset: {
    patch: "patchNamespacedStatefulSet",
    read: "readNamespacedStatefulSet",
    kind: "StatefulSet",
  },
  replicaset: {
    patch: "patchNamespacedReplicaSet",
    read: "readNamespacedReplicaSet",
    kind: "ReplicaSet",
  },
} as const

async function applyScaleWorkload(
  clients: ScaleClient,
  namespace: string,
  kind: keyof typeof SCALE_KIND_API,
  name: string,
  replicas: number
) {
  const api = SCALE_KIND_API[kind]
  // JSON Patch "add" on an object member inserts or replaces it, so this works
  // whether or not spec.replicas was explicitly set.
  const patcher = clients[api.patch] as unknown as (
    args: Record<string, unknown>
  ) => Promise<unknown>
  await patcher({
    name,
    namespace,
    body: [{ op: "add", path: "/spec/replicas", value: replicas }],
  })
  const reader = clients[api.read] as (args: {
    name: string
    namespace: string
  }) => Promise<{ spec?: { replicas?: number } }>
  const verified = await reader({ name, namespace })
  const actual = verified.spec?.replicas
  if (actual !== undefined && actual !== replicas) {
    throw new Error(
      `${api.kind} ${namespace}/${name} was patched but reports ${actual} replicas instead of ${replicas}.`
    )
  }
  return { kind: api.kind, name, namespace, replicas: actual ?? replicas }
}

const RESTART_KIND_API = {
  deployment: {
    patch: "patchNamespacedDeployment",
    read: "readNamespacedDeployment",
    kind: "Deployment",
  },
  statefulset: {
    patch: "patchNamespacedStatefulSet",
    read: "readNamespacedStatefulSet",
    kind: "StatefulSet",
  },
  daemonset: {
    patch: "patchNamespacedDaemonSet",
    read: "readNamespacedDaemonSet",
    kind: "DaemonSet",
  },
} as const

type RestartClient = Pick<
  AppsV1Api,
  | "patchNamespacedDeployment"
  | "patchNamespacedStatefulSet"
  | "patchNamespacedDaemonSet"
  | "readNamespacedDeployment"
  | "readNamespacedStatefulSet"
  | "readNamespacedDaemonSet"
>

async function applyRestartWorkload(
  clients: RestartClient,
  namespace: string,
  kind: keyof typeof RESTART_KIND_API,
  name: string
) {
  const api = RESTART_KIND_API[kind]
  const timestamp = new Date().toISOString()

  const reader = clients[api.read] as (args: {
    name: string
    namespace: string
  }) => Promise<{
    spec?: { template?: { metadata?: { annotations?: Record<string, string> } } }
  }>
  const current = await reader({ name, namespace })
  const annotations =
    current.spec?.template?.metadata?.annotations ?? undefined

  // kubectl rollout restart works by stamping this annotation into the pod
  // template, which changes the pod-template-hash and triggers a rolling
  // update. JSON Pointer escapes "/" as "~1".
  const escapedKey = RESTART_ANNOTATION.replaceAll("~", "~0").replaceAll(
    "/",
    "~1"
  )
  const operations = annotations
    ? [
        {
          op: "add",
          path: `/spec/template/metadata/annotations/${escapedKey}`,
          value: timestamp,
        },
      ]
    : [
        {
          op: "add",
          path: "/spec/template/metadata/annotations",
          value: { [RESTART_ANNOTATION]: timestamp },
        },
      ]

  const patcher = clients[api.patch] as unknown as (
    args: Record<string, unknown>
  ) => Promise<unknown>
  await patcher({ name, namespace, body: operations })

  const verified = await reader({ name, namespace })
  const stamped =
    verified.spec?.template?.metadata?.annotations?.[RESTART_ANNOTATION]
  return {
    kind: api.kind,
    name,
    namespace,
    restartedAt: stamped ?? timestamp,
    verification: { status: stamped ? "verified" : "patched" },
  }
}

function objectSpec(
  apiVersion: string,
  kind: string,
  namespace: string | undefined,
  name: string
): KubernetesObject {
  return {
    apiVersion,
    kind,
    metadata: { name, ...(namespace ? { namespace } : {}) },
  }
}

async function applyPatchResource(
  object: KubernetesObjectApi,
  input: {
    apiVersion: string
    kind: string
    namespace?: string
    name: string
    patch: Record<string, unknown>
  }
) {
  assertMutableResource(input.kind, input.namespace)

  const { metadata: patchMetadata, ...rest } = input.patch as {
    metadata?: Record<string, unknown>
  } & Record<string, unknown>

  // Identity fields always win over whatever the patch document contains, so a
  // patch cannot retarget the request at a different object.
  const spec = {
    apiVersion: input.apiVersion,
    kind: input.kind,
    metadata: {
      ...(patchMetadata ?? {}),
      name: input.name,
      ...(input.namespace ? { namespace: input.namespace } : {}),
    },
    ...rest,
  } as KubernetesObject

  const patched = await object.patch(
    spec,
    undefined,
    undefined,
    FIELD_MANAGER,
    undefined,
    PatchStrategy.MergePatch
  )
  return {
    apiVersion: input.apiVersion,
    kind: input.kind,
    name: patched.metadata?.name ?? input.name,
    namespace: patched.metadata?.namespace,
  }
}

async function applyDeleteResource(
  object: KubernetesObjectApi,
  input: {
    apiVersion: string
    kind: string
    namespace?: string
    name: string
    gracePeriodSeconds?: number
    propagationPolicy?: string
  }
) {
  assertMutableResource(input.kind, input.namespace)

  const status = await object.delete(
    objectSpec(input.apiVersion, input.kind, input.namespace, input.name),
    undefined,
    undefined,
    input.gracePeriodSeconds,
    undefined,
    input.propagationPolicy
  )
  return {
    apiVersion: input.apiVersion,
    kind: input.kind,
    name: input.name,
    namespace: input.namespace,
    deletionStatus: status.status,
    message: status.message,
  }
}

type ManifestDocument = {
  apiVersion?: string
  kind?: string
  metadata?: { name?: string; namespace?: string }
  spec?: unknown
  data?: unknown
  [key: string]: unknown
}

function parseManifestDocuments(manifest: string): ManifestDocument[] {
  const documents: ManifestDocument[] = []
  for (const doc of parseAllDocuments(manifest)) {
    if (doc.errors.length > 0) {
      throw new Error(
        `Invalid manifest YAML: ${doc.errors[0]?.message ?? "parse error"}`
      )
    }
    const json = doc.toJSON() as ManifestDocument | null | undefined
    if (!json || typeof json !== "object") continue

    // A v1 List wraps several resources; flatten it into individual applies.
    if (json.kind === "List" && Array.isArray(json.items)) {
      for (const item of json.items) {
        if (item && typeof item === "object") documents.push(item)
      }
      continue
    }
    documents.push(json)
  }
  return documents
}

async function applyManifest(
  object: KubernetesObjectApi,
  manifest: string
) {
  const documents = parseManifestDocuments(manifest)
  if (documents.length === 0) {
    throw new Error("The manifest did not contain any Kubernetes resources.")
  }
  if (documents.length > 50) {
    throw new Error("The manifest contains too many resources (max 50).")
  }

  const results: Array<Record<string, unknown>> = []
  for (const doc of documents) {
    const { apiVersion, kind, metadata } = doc
    const name = metadata?.name
    if (!apiVersion || !kind || !name) {
      throw new Error(
        "Every manifest document needs apiVersion, kind, and metadata.name."
      )
    }
    assertMutableResource(kind, metadata?.namespace)
    if (kind === "Namespace" && isProtectedNamespace(name)) {
      throw new Error(
        `Refusing to apply a manifest for protected namespace "${name}".`
      )
    }

    // Server-side apply creates or updates in one call; status is read-only
    // and must never be sent back to the API server.
    const desired = { ...doc }
    delete desired.status
    const applied = await object.patch(
      desired as KubernetesObject,
      undefined,
      undefined,
      FIELD_MANAGER,
      undefined,
      PatchStrategy.ServerSideApply
    )
    results.push({
      apiVersion,
      kind,
      name: applied.metadata?.name ?? name,
      namespace: applied.metadata?.namespace,
      operation: "applied",
    })
  }
  return { applied: results.length, resources: results }
}

export async function applyKubernetesAction(proposal: ActionProposal) {
  const parsed = actionProposalSchema.safeParse(proposal)
  if (!parsed.success) {
    throw new Error(
      `Refusing to apply an invalid Kubernetes action: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    )
  }

  const action = parsed.data
  const { core, apps, object } = getKubernetesClients()

  if (action.action === "label_node") {
    assertNodeLabelKeyAllowed(action.input.key)

    const { node, key, value } = action.input
    const current = await core.readNode({ name: node })
    const labels = current.metadata?.labels ?? {}
    const escapedKey = key.replaceAll("~", "~0").replaceAll("/", "~1")
    const body = Object.keys(labels).length
      ? [{ op: "add", path: `/metadata/labels/${escapedKey}`, value }]
      : [{ op: "add", path: "/metadata/labels", value: { [key]: value } }]
    const response = await core.patchNode({ name: node, body })
    const verified = await core.readNode({ name: node })
    if (verified.metadata?.labels?.[key] !== value) {
      throw new Error(`Node ${node} was patched but its ${key} label could not be verified.`)
    }
    return {
      action: action.action,
      node: response.metadata?.name ?? node,
      labels: verified.metadata?.labels,
      verification: { status: "verified" },
    }
  }

  if (action.action === "remove_deployment_node_selector") {
    assertMutableNamespace(action.input.namespace)

    const { namespace, deployment } = action.input
    const response = await apps.patchNamespacedDeployment({
      name: deployment,
      namespace,
      body: [{ op: "remove", path: "/spec/template/spec/nodeSelector" }],
    })
    const verified = await waitForDeploymentRollout(apps, namespace, deployment)
    return {
      action: action.action,
      deployment: response.metadata?.name ?? deployment,
      namespace: response.metadata?.namespace ?? namespace,
      nodeSelector: verified.spec?.template?.spec?.nodeSelector,
      verification: {
        status: "verified",
        availableReplicas: verified.status?.availableReplicas ?? 0,
      },
    }
  }

  if (action.action === "recreate_pod_without_node_selector") {
    assertMutableNamespace(action.input.namespace)

    const { namespace, pod } = action.input
    const current = await core.readNamespacedPod({ name: pod, namespace })
    const owner = current.metadata?.ownerReferences?.[0]
    if (owner) {
      throw new Error(
        `Pod ${namespace}/${pod} is controlled by ${owner.kind} ${owner.name}; update the owning resource instead.`
      )
    }

    const replacement = JSON.parse(JSON.stringify(current)) as typeof current
    if (replacement.metadata) {
      delete replacement.metadata.uid
      delete replacement.metadata.resourceVersion
      delete replacement.metadata.creationTimestamp
      delete replacement.metadata.generation
      delete replacement.metadata.managedFields
      delete replacement.metadata.finalizers
      delete replacement.metadata.generateName
      delete replacement.metadata.deletionTimestamp
      delete replacement.metadata.deletionGracePeriodSeconds
    }
    delete replacement.status
    if (replacement.spec) {
      delete replacement.spec.nodeSelector
      delete replacement.spec.nodeName
    }

    // terminate immediately, then wait until the API server no longer returns
    // the pod; creating with the same name before that races with AlreadyExists.
    await core.deleteNamespacedPod({
      name: pod,
      namespace,
      gracePeriodSeconds: 0,
    })
    await waitForPodDeletion(core, namespace, pod)

    try {
      const recreated = await core.createNamespacedPod({
        namespace,
        body: replacement,
      })
      const verified = await waitForPodReady(core, namespace, pod)
      return {
        action: action.action,
        namespace,
        pod: recreated.metadata?.name ?? pod,
        phase: verified.status?.phase ?? recreated.status?.phase ?? "Pending",
        node: verified.spec?.nodeName,
        ready: isPodReady(verified),
        verification: { status: "verified" },
      }
    } catch (error) {
      throw new Error(
        `Pod ${namespace}/${pod} was deleted but could not be recreated: ${errorMessage(error)}. Recreate it manually from the recorded spec.`
      )
    }
  }

  if (action.action === "scale_workload") {
    assertMutableNamespace(action.input.namespace)
    return {
      action: action.action,
      ...(await applyScaleWorkload(
        apps,
        action.input.namespace,
        action.input.kind,
        action.input.name,
        action.input.replicas
      )),
      verification: { status: "verified" },
    }
  }

  if (action.action === "restart_workload") {
    assertMutableNamespace(action.input.namespace)
    return {
      action: action.action,
      ...(await applyRestartWorkload(
        apps,
        action.input.namespace,
        action.input.kind,
        action.input.name
      )),
    }
  }

  if (action.action === "delete_pod") {
    assertMutableNamespace(action.input.namespace)
    const { namespace, pod, gracePeriodSeconds } = action.input
    const response = await core.deleteNamespacedPod({
      name: pod,
      namespace,
      gracePeriodSeconds,
    })
    return {
      action: action.action,
      namespace,
      pod: response.metadata?.name ?? pod,
      deletionTimestamp: response.metadata?.deletionTimestamp,
      verification: { status: "deleted" },
    }
  }

  if (action.action === "set_node_unschedulable") {
    const { node, unschedulable } = action.input
    const current = await core.readNode({ name: node })
    const already = current.spec?.unschedulable ?? false
    if (already === unschedulable) {
      return {
        action: action.action,
        node,
        unschedulable,
        verification: { status: "verified", unchanged: true },
      }
    }
    const escaped = "/spec/unschedulable"
    const body = current.spec?.unschedulable === undefined
      ? [{ op: "add", path: escaped, value: unschedulable }]
      : [{ op: "replace", path: escaped, value: unschedulable }]
    await core.patchNode({ name: node, body })
    const verified = await core.readNode({ name: node })
    if ((verified.spec?.unschedulable ?? false) !== unschedulable) {
      throw new Error(
        `Node ${node} was patched but unschedulable=${unschedulable} could not be verified.`
      )
    }
    return {
      action: action.action,
      node,
      unschedulable,
      verification: { status: "verified" },
    }
  }

  if (action.action === "patch_resource") {
    if (isProtectedResourceKind(action.input.kind)) {
      throw new Error(
        `Refusing to patch ${action.input.kind} through the generic tool.`
      )
    }
    const result = await applyPatchResource(object, action.input)
    return { action: action.action, ...result, verification: { status: "patched" } }
  }

  if (action.action === "delete_resource") {
    const result = await applyDeleteResource(object, action.input)
    return { action: action.action, ...result, verification: { status: "deleted" } }
  }

  if (action.action === "apply_manifest") {
    const result = await applyManifest(object, action.input.manifest)
    return { action: action.action, ...result, verification: { status: "applied" } }
  }

  throw new Error("Unsupported Kubernetes action.")
}
