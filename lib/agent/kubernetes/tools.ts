import { tool } from "@langchain/core/tools"
import { z } from "zod"

import type { ActionProposal } from "@/lib/chat-types"
import { getKubernetesClients } from "@/lib/agent/kubernetes/client"

const MAX_TOOL_OUTPUT_CHARS = 8000

function serializeToolOutput(value: unknown) {
  const json = JSON.stringify(value)
  if (json.length <= MAX_TOOL_OUTPUT_CHARS) return json

  return JSON.stringify({
    truncated: true,
    preview: json.slice(0, MAX_TOOL_OUTPUT_CHARS),
    note: `Output was truncated at ${MAX_TOOL_OUTPUT_CHARS} characters. Use a narrower query if more detail is needed.`,
  })
}

function limitText(value: string) {
  if (value.length <= MAX_TOOL_OUTPUT_CHARS) return value
  return `${value.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[output truncated]`
}

const namespaceSchema = z.object({
  namespace: z.string().trim().min(1).default("default"),
})

export const listPodsTool = tool(
  async ({ namespace }) => {
    const { core } = getKubernetesClients()
    const response = await core.listNamespacedPod({ namespace })

    return serializeToolOutput(
      response.items.map((pod) => ({
        name: pod.metadata?.name,
        namespace: pod.metadata?.namespace,
        phase: pod.status?.phase,
        reason: pod.status?.reason,
        node: pod.spec?.nodeName,
        containers: pod.status?.containerStatuses?.map((container) => ({
          name: container.name,
          ready: container.ready,
          restartCount: container.restartCount,
          state: container.state,
        })),
      }))
    )
  },
  {
    name: "list_pods",
    description:
      "List pods and their current status in a Kubernetes namespace.",
    schema: namespaceSchema,
  }
)

export const listEventsTool = tool(
  async ({ namespace }) => {
    const { core } = getKubernetesClients()
    const response = await core.listNamespacedEvent({ namespace })

    return serializeToolOutput(
      response.items.map((event) => ({
        type: event.type,
        reason: event.reason,
        message: event.message,
        count: event.count,
        firstTimestamp: event.firstTimestamp,
        lastTimestamp: event.lastTimestamp,
        involvedObject: event.involvedObject,
      }))
    )
  },
  {
    name: "list_events",
    description: "List recent Kubernetes events in a namespace.",
    schema: namespaceSchema,
  }
)

export const getPodLogsTool = tool(
  async ({ namespace, pod, container, tailLines }) => {
    const { core } = getKubernetesClients()
    return limitText(
      await core.readNamespacedPodLog({
        name: pod,
        namespace,
        container: container || undefined,
        tailLines,
        timestamps: true,
      })
    )
  },
  {
    name: "get_pod_logs",
    description:
      "Read recent logs from a Kubernetes pod without changing cluster state.",
    schema: namespaceSchema.extend({
      pod: z.string().trim().min(1),
      container: z.string().trim().optional(),
      tailLines: z.number().int().min(1).max(1000).default(100),
    }),
  }
)

export const getPodTool = tool(
  async ({ namespace, pod }) => {
    const { core } = getKubernetesClients()
    const response = await core.readNamespacedPod({
      name: pod,
      namespace,
    })

    return serializeToolOutput({
      name: response.metadata?.name,
      namespace: response.metadata?.namespace,
      labels: response.metadata?.labels,
      annotations: response.metadata?.annotations,
      ownerReferences: response.metadata?.ownerReferences,
      phase: response.status?.phase,
      reason: response.status?.reason,
      message: response.status?.message,
      conditions: response.status?.conditions,
      node: response.spec?.nodeName,
      nodeSelector: response.spec?.nodeSelector,
      hostNetwork: response.spec?.hostNetwork,
      containers: response.spec?.containers?.map((container) => ({
        name: container.name,
        image: container.image,
        command: container.command,
        args: container.args,
        ports: container.ports,
        readinessProbe: container.readinessProbe,
        livenessProbe: container.livenessProbe,
      })),
      containerStatuses: response.status?.containerStatuses,
    })
  },
  {
    name: "get_pod",
    description:
      "Get the detailed metadata, scheduling, container, and status information for a Kubernetes pod.",
    schema: namespaceSchema.extend({
      pod: z.string().trim().min(1),
    }),
  }
)

export const describePodTool = tool(
  async ({ namespace, pod }) => {
    const { core } = getKubernetesClients()
    const [podResponse, eventsResponse] = await Promise.all([
      core.readNamespacedPod({ name: pod, namespace }),
      core.listNamespacedEvent({
        namespace,
        fieldSelector: `involvedObject.name=${pod}`,
      }),
    ])

    return serializeToolOutput({
      pod: {
        name: podResponse.metadata?.name,
        namespace: podResponse.metadata?.namespace,
        phase: podResponse.status?.phase,
        reason: podResponse.status?.reason,
        message: podResponse.status?.message,
        conditions: podResponse.status?.conditions,
        containerStatuses: podResponse.status?.containerStatuses,
        initContainerStatuses: podResponse.status?.initContainerStatuses,
      },
      events: eventsResponse.items.map((event) => ({
        type: event.type,
        reason: event.reason,
        message: event.message,
        count: event.count,
        firstTimestamp: event.firstTimestamp,
        lastTimestamp: event.lastTimestamp,
        source: event.source,
      })),
    })
  },
  {
    name: "describe_pod",
    description:
      "Describe a Kubernetes pod and include its recent namespace events for troubleshooting.",
    schema: namespaceSchema.extend({
      pod: z.string().trim().min(1),
    }),
  }
)

export const getDeploymentTool = tool(
  async ({ namespace, deployment }) => {
    const { apps } = getKubernetesClients()
    const response = await apps.readNamespacedDeployment({
      name: deployment,
      namespace,
    })
    const item = response

    return serializeToolOutput({
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      replicas: item.spec?.replicas,
      availableReplicas: item.status?.availableReplicas,
      readyReplicas: item.status?.readyReplicas,
      updatedReplicas: item.status?.updatedReplicas,
      conditions: item.status?.conditions,
      strategy: item.spec?.strategy,
      selector: item.spec?.selector,
      nodeSelector: item.spec?.template?.spec?.nodeSelector,
    })
  },
  {
    name: "get_deployment",
    description:
      "Inspect a Kubernetes deployment's rollout status and strategy.",
    schema: namespaceSchema.extend({
      deployment: z.string().trim().min(1),
    }),
  }
)

export const getServiceTool = tool(
  async ({ namespace, service }) => {
    const { core } = getKubernetesClients()
    const response = await core.readNamespacedService({
      name: service,
      namespace,
    })

    return serializeToolOutput({
      name: response.metadata?.name,
      namespace: response.metadata?.namespace,
      type: response.spec?.type,
      clusterIP: response.spec?.clusterIP,
      ports: response.spec?.ports,
      selector: response.spec?.selector,
    })
  },
  {
    name: "get_service",
    description: "Inspect a Kubernetes service and its routing selector.",
    schema: namespaceSchema.extend({
      service: z.string().trim().min(1),
    }),
  }
)

export const getNodeTool = tool(
  async ({ node }) => {
    const { core } = getKubernetesClients()
    const response = await core.readNode({ name: node })

    return serializeToolOutput({
      name: response.metadata?.name,
      labels: response.metadata?.labels,
      annotations: response.metadata?.annotations,
      taints: response.spec?.taints,
      conditions: response.status?.conditions,
      allocatable: response.status?.allocatable,
      capacity: response.status?.capacity,
      unschedulable: response.spec?.unschedulable,
    })
  },
  {
    name: "get_node",
    description:
      "Inspect a Kubernetes node's labels, taints, conditions, capacity, and scheduling state. Use this before proposing node changes.",
    schema: z.object({ node: z.string().trim().min(1) }),
  }
)

const labelNodeInputSchema = z.object({
  node: z.string().trim().min(1),
  key: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9][-A-Za-z0-9_.\/]*[A-Za-z0-9]$/),
  value: z.string().trim().min(1).max(63),
})

export const labelNodeTool = tool(
  async (input): Promise<string> => {
    const proposal: ActionProposal = {
      action: "label_node",
      summary: `Label node ${input.node} with ${input.key}=${input.value}`,
      input,
    }
    return JSON.stringify({ kind: "action_proposal", ...proposal })
  },
  {
    name: "label_node",
    description:
      "Prepare a proposal to add or update one Kubernetes node label. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
    schema: labelNodeInputSchema,
  }
)

export const removeDeploymentNodeSelectorTool = tool(
  async ({ namespace, deployment }): Promise<string> => {
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
      "Prepare a proposal to remove a Deployment pod template nodeSelector. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
    schema: z.object({
      namespace: namespaceSchema.shape.namespace,
      deployment: z.string().trim().min(1),
    }),
  }
)

export const recreatePodWithoutNodeSelectorTool = tool(
  async ({ namespace, pod }): Promise<string> => {
    const proposal: ActionProposal = {
      action: "recreate_pod_without_node_selector",
      summary: `Recreate standalone pod ${namespace}/${pod} without its nodeSelector`,
      input: { namespace, pod },
    }
    return JSON.stringify({ kind: "action_proposal", ...proposal })
  },
  {
    name: "recreate_pod_without_node_selector",
    description:
      "Prepare a proposal to recreate an unmanaged standalone pod without its nodeSelector. This is required because pod scheduling fields cannot be edited in place. This only creates a proposal; it never changes the cluster. The user must approve it before execution.",
    schema: z.object({
      namespace: namespaceSchema.shape.namespace,
      pod: z.string().trim().min(1),
    }),
  }
)

export const readOnlyKubernetesTools = [
  listPodsTool,
  listEventsTool,
  getPodLogsTool,
  getPodTool,
  describePodTool,
  getDeploymentTool,
  getServiceTool,
  getNodeTool,
]

export const kubernetesTools = [
  ...readOnlyKubernetesTools,
  labelNodeTool,
  removeDeploymentNodeSelectorTool,
  recreatePodWithoutNodeSelectorTool,
]
