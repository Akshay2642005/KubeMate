import type { ActionProposal } from "@/lib/chat-types"
import { getKubernetesClients } from "@/lib/agent/kubernetes/client"

export async function applyKubernetesAction(proposal: ActionProposal) {
  const { core, apps } = getKubernetesClients()

  if (proposal.action === "label_node") {
    const { node, key, value } = proposal.input as {
      node: string
      key: string
      value: string
    }
    const current = await core.readNode({ name: node })
    const labels = current.metadata?.labels ?? {}
    const escapedKey = key.replaceAll("~", "~0").replaceAll("/", "~1")
    const body = Object.keys(labels).length
      ? [{ op: "add", path: `/metadata/labels/${escapedKey}`, value }]
      : [{ op: "add", path: "/metadata/labels", value: { [key]: value } }]
    const response = await core.patchNode({ name: node, body })
    return {
      action: proposal.action,
      node: response.metadata?.name ?? node,
      labels: response.metadata?.labels,
    }
  }

  if (proposal.action === "remove_deployment_node_selector") {
    const { namespace, deployment } = proposal.input as {
      namespace: string
      deployment: string
    }
    const response = await apps.patchNamespacedDeployment({
      name: deployment,
      namespace,
      body: [{ op: "remove", path: "/spec/template/spec/nodeSelector" }],
    })
    return {
      action: proposal.action,
      deployment: response.metadata?.name ?? deployment,
      namespace: response.metadata?.namespace ?? namespace,
      nodeSelector: response.spec?.template?.spec?.nodeSelector,
    }
  }

  if (proposal.action === "recreate_pod_without_node_selector") {
    const { namespace, pod } = proposal.input as {
      namespace: string
      pod: string
    }
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
    }
    delete replacement.status
    if (replacement.spec) {
      delete replacement.spec.nodeSelector
      delete replacement.spec.nodeName
    }

    await core.deleteNamespacedPod({ name: pod, namespace })
    const recreated = await core.createNamespacedPod({
      namespace,
      body: replacement,
    })
    return {
      action: proposal.action,
      namespace,
      pod: recreated.metadata?.name ?? pod,
      phase: recreated.status?.phase ?? "Pending",
    }
  }

  throw new Error(`Unsupported Kubernetes action: ${proposal.action}`)
}
