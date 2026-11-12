import type { CoreV1Api } from "@kubernetes/client-node"

import type { ActionProposal } from "@/lib/chat-types"
import { getKubernetesClients } from "@/lib/agent/kubernetes/client"
import {
  actionProposalSchema,
  assertMutableNamespace,
  assertNodeLabelKeyAllowed,
} from "@/lib/agent/kubernetes/proposals"

const POD_DELETE_TIMEOUT_MS = 30_000
const POD_DELETE_POLL_MS = 500

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
  const { core, apps } = getKubernetesClients()

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
    return {
      action: action.action,
      node: response.metadata?.name ?? node,
      labels: response.metadata?.labels,
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
    return {
      action: action.action,
      deployment: response.metadata?.name ?? deployment,
      namespace: response.metadata?.namespace ?? namespace,
      nodeSelector: response.spec?.template?.spec?.nodeSelector,
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
      return {
        action: action.action,
        namespace,
        pod: recreated.metadata?.name ?? pod,
        phase: recreated.status?.phase ?? "Pending",
      }
    } catch (error) {
      throw new Error(
        `Pod ${namespace}/${pod} was deleted but could not be recreated: ${errorMessage(error)}. Recreate it manually from the recorded spec.`
      )
    }
  }

  throw new Error("Unsupported Kubernetes action.")
}
