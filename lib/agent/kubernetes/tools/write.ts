import { tool } from "@langchain/core/tools"
import { z } from "zod"

import type { ActionProposal } from "@/lib/chat-types"
import { getKubernetesClients } from "@/lib/agent/kubernetes/client"
import {
  applyManifestInputSchema,
  deletePodInputSchema,
  deleteResourceInputSchema,
  labelNodeInputSchema,
  patchResourceInputSchema,
  recreatePodWithoutNodeSelectorInputSchema,
  removeDeploymentNodeSelectorInputSchema,
  restartWorkloadInputSchema,
  scaleWorkloadInputSchema,
} from "@/lib/agent/kubernetes/proposals"

// Every mutation tool returns the same envelope: a JSON object the chat route
// recognises as an approval proposal. Nothing here touches the cluster.
function proposalTool<Schema extends z.ZodType>(
  name: string,
  description: string,
  schema: Schema,
  build: (input: z.infer<Schema>) => ActionProposal
) {
  return tool(
    async (input): Promise<string> => {
      const parsed = schema.parse(input)
      const proposal = build(parsed)
      return JSON.stringify({ kind: "action_proposal", ...proposal })
    },
    { name, description, schema }
  )
}

export const labelNodeTool = proposalTool(
  "label_node",
  "Prepare a proposal to add or update one Kubernetes node label. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
  labelNodeInputSchema,
  (input) => ({
    action: "label_node",
    summary: `Label node ${input.node} with ${input.key}=${input.value}`,
    input,
  })
)

export const removeDeploymentNodeSelectorTool = tool(
  async ({ namespace, deployment }): Promise<string> => {
    const { apps } = getKubernetesClients()
    try {
      const current = await apps.readNamespacedDeployment({
        name: deployment,
        namespace,
      })
      if (!current.spec?.template?.spec?.nodeSelector) {
        return JSON.stringify({
          kind: "proposal_unavailable",
          reason: `Deployment ${namespace}/${deployment} exists but has no nodeSelector to remove.`,
        })
      }
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined
      if (code === 404) {
        return JSON.stringify({
          kind: "proposal_unavailable",
          reason: `${namespace}/${deployment} is not a Deployment. Inspect the Pod and use recreate_pod_without_node_selector for an unmanaged standalone pod.`,
        })
      }
      throw error
    }

    const proposal: ActionProposal = {
      action: "remove_deployment_node_selector",
      summary: `Remove the nodeSelector from deployment ${namespace}/${deployment}`,
      input: { namespace, deployment },
    }
    return JSON.stringify({ kind: "action_proposal", ...proposal })
  },
  {
    name: "remove_deployment_node_selector",
    description:
      "Prepare a proposal to remove a Deployment pod template nodeSelector. Only call this after get_deployment confirms that the target is an existing Deployment with a nodeSelector. For an unmanaged standalone Pod, call recreate_pod_without_node_selector instead. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
    schema: removeDeploymentNodeSelectorInputSchema,
  }
)

export const recreatePodWithoutNodeSelectorTool = proposalTool(
  "recreate_pod_without_node_selector",
  "Prepare a proposal to recreate an unmanaged standalone pod without its nodeSelector. This is required because pod scheduling fields cannot be edited in place. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
  recreatePodWithoutNodeSelectorInputSchema,
  (input) => ({
    action: "recreate_pod_without_node_selector",
    summary: `Recreate standalone pod ${input.namespace}/${input.pod} without its nodeSelector`,
    input,
  })
)

export const scaleWorkloadTool = proposalTool(
  "scale_workload",
  "Prepare a proposal to change the replica count of a Deployment, StatefulSet, or ReplicaSet. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
  scaleWorkloadInputSchema,
  (input) => ({
    action: "scale_workload",
    summary: `Scale ${input.kind} ${input.namespace}/${input.name} to ${input.replicas} replica(s)`,
    input,
  })
)

export const restartWorkloadTool = proposalTool(
  "restart_workload",
  "Prepare a proposal to perform a rolling restart of a Deployment, StatefulSet, or DaemonSet by patching the pod template restart annotation. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
  restartWorkloadInputSchema,
  (input) => ({
    action: "restart_workload",
    summary: `Restart ${input.kind} ${input.namespace}/${input.name} (rolling restart)`,
    input,
  })
)

export const deletePodTool = proposalTool(
  "delete_pod",
  "Prepare a proposal to delete a pod. The pod's controller (if any) will recreate it according to its spec. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
  deletePodInputSchema,
  (input) => ({
    action: "delete_pod",
    summary: `Delete pod ${input.namespace}/${input.pod}`,
    input,
  })
)

const nodeOnlySchema = z.object({
  node: z.string().trim().min(1).max(253),
})

export const cordonNodeTool = proposalTool(
  "cordon_node",
  "Prepare a proposal to mark a node as unschedulable (cordon) so no new pods are placed on it. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
  nodeOnlySchema,
  (input) => ({
    action: "set_node_unschedulable",
    summary: `Cordon node ${input.node} (mark unschedulable)`,
    input: { node: input.node, unschedulable: true },
  })
)

export const uncordonNodeTool = proposalTool(
  "uncordon_node",
  "Prepare a proposal to mark a node as schedulable again (uncordon). This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
  nodeOnlySchema,
  (input) => ({
    action: "set_node_unschedulable",
    summary: `Uncordon node ${input.node} (mark schedulable)`,
    input: { node: input.node, unschedulable: false },
  })
)

export const patchResourceTool = proposalTool(
  "patch_resource",
  "Prepare a proposal to merge-patch any Kubernetes resource (built-in or CRD) by apiVersion, kind, and name. The patch is an RFC 7386 merge document, e.g. {\"spec\":{\"replicas\":3}} or {\"metadata\":{\"labels\":{\"env\":\"prod\"}}}; null deletes a key. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
  patchResourceInputSchema,
  (input) => ({
    action: "patch_resource",
    summary: `Patch ${input.kind} ${input.namespace ? `${input.namespace}/` : ""}${input.name} (${input.apiVersion})`,
    input,
  })
)

export const deleteResourceTool = proposalTool(
  "delete_resource",
  "Prepare a proposal to delete any Kubernetes resource by apiVersion, kind, and name. Cluster-scoped infrastructure kinds and RBAC objects are refused. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
  deleteResourceInputSchema,
  (input) => ({
    action: "delete_resource",
    summary: `Delete ${input.kind} ${input.namespace ? `${input.namespace}/` : ""}${input.name} (${input.apiVersion})`,
    input,
  })
)

export const applyManifestTool = proposalTool(
  "apply_manifest",
  "Prepare a proposal to server-side apply a Kubernetes manifest (YAML or JSON, multi-document supported) create-or-update style. Protected namespaces and infrastructure/RBAC kinds are refused. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
  applyManifestInputSchema,
  (input) => ({
    action: "apply_manifest",
    summary: `Apply manifest (${input.manifest.split("\n").length} lines)`,
    input,
  })
)
