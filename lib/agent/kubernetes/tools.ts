import { tool } from "@langchain/core/tools"
import { z } from "zod"

import type { ActionProposal } from "@/lib/chat-types"
import { getKubernetesClients } from "@/lib/agent/kubernetes/client"
import {
  labelNodeInputSchema,
  recreatePodWithoutNodeSelectorInputSchema,
  removeDeploymentNodeSelectorInputSchema,
} from "@/lib/agent/kubernetes/proposals"

const MAX_TOOL_OUTPUT_CHARS = 6000

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

    const events = response.items
      .toSorted(
        (a, b) =>
          new Date(String(b.lastTimestamp ?? b.eventTime ?? 0)).getTime() -
          new Date(String(a.lastTimestamp ?? a.eventTime ?? 0)).getTime()
      )
      .slice(0, 12)

    return serializeToolOutput(
      events.map((event) => ({
        type: event.type,
        reason: event.reason,
        message:
          typeof event.message === "string"
            ? event.message.slice(0, 240)
            : event.message,
        count: event.count,
        firstTimestamp: event.firstTimestamp,
        lastTimestamp: event.lastTimestamp,
        involvedObject: {
          kind: event.involvedObject?.kind,
          name: event.involvedObject?.name,
          namespace: event.involvedObject?.namespace,
        },
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

// Ownership-chain read for a Deployment: its ReplicaSets, the pods they
// manage (readiness and restarts included), and the Services whose selectors
// route traffic to those pods. Answers "what does this workload own" and "why
// is traffic not reaching my pods" without a mutation-capable tool.
export const traceWorkloadTool = tool(
  async ({ namespace, deployment }) => {
    const { apps, core } = getKubernetesClients()
    const item = await apps.readNamespacedDeployment({
      name: deployment,
      namespace,
    })
    const matchLabels = item.spec?.selector?.matchLabels ?? {}
    const selectorString = Object.entries(matchLabels)
      .map(([key, value]) => `${key}=${value}`)
      .join(",")

    const [replicasets, pods, services] = await Promise.all([
      selectorString
        ? apps.listNamespacedReplicaSet({
            namespace,
            labelSelector: selectorString,
            limit: 10,
          })
        : Promise.resolve({ items: [] }),
      core.listNamespacedPod({
        namespace,
        labelSelector: selectorString || undefined,
        limit: 50,
      }),
      core.listNamespacedService({ namespace, limit: 100 }),
    ])

    const podLabels = pods.items.map((pod) => pod.metadata?.labels ?? {})
    const serviceMatches = services.items
      .map((service) => {
        const selector = service.spec?.selector ?? {}
        const keys = Object.keys(selector)
        const matchesPods =
          keys.length > 0 &&
          podLabels.some((labels) =>
            keys.every((key) => labels[key] === selector[key])
          )
        return {
          name: service.metadata?.name,
          type: service.spec?.type,
          clusterIP: service.spec?.clusterIP,
          ports: service.spec?.ports?.map((port) => ({
            name: port.name,
            port: port.port,
            targetPort: port.targetPort,
            protocol: port.protocol,
          })),
          selector,
          matchesPods,
        }
      })
      .filter((service) => service.matchesPods)
      .slice(0, 20)

    return serializeToolOutput({
      deployment: {
        name: item.metadata?.name,
        namespace: item.metadata?.namespace,
        replicas: item.spec?.replicas,
        readyReplicas: item.status?.readyReplicas,
        availableReplicas: item.status?.availableReplicas,
        updatedReplicas: item.status?.updatedReplicas,
        strategy: item.spec?.strategy?.type,
        selector: matchLabels,
        nodeSelector: item.spec?.template?.spec?.nodeSelector,
      },
      replicasets: replicasets.items.map((replicaSet) => ({
        name: replicaSet.metadata?.name,
        replicas: replicaSet.spec?.replicas,
        readyReplicas: replicaSet.status?.readyReplicas,
      })),
      pods: pods.items.map((pod) => {
        const containerStatuses = pod.status?.containerStatuses ?? []
        return {
          name: pod.metadata?.name,
          node: pod.spec?.nodeName,
          phase: pod.status?.phase,
          reason: pod.status?.reason,
          restarts: containerStatuses.reduce(
            (total, container) => total + (container.restartCount ?? 0),
            0
          ),
          containersReady: containerStatuses.filter((container) => container.ready)
            .length,
          containersTotal: containerStatuses.length,
        }
      }),
      services: serviceMatches,
      podCount: pods.items.length,
      truncated: pods.items.length >= 50,
    })
  },
  {
    name: "trace_workload",
    description:
      "Trace the ownership and routing chain for a Deployment: its ReplicaSets, the pods they manage (readiness, restarts, node), and the Services whose selectors route to those pods. Read-only. Use this for 'what does this deployment own', 'map this workload', or 'why is traffic not reaching my pods'.",
    schema: z.object({
      namespace: z.string().trim().min(1).default("default"),
      deployment: z.string().trim().min(1),
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
    schema: recreatePodWithoutNodeSelectorInputSchema,
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
  traceWorkloadTool,
]

export const kubernetesTools = [
  ...readOnlyKubernetesTools,
  labelNodeTool,
  removeDeploymentNodeSelectorTool,
  recreatePodWithoutNodeSelectorTool,
]
