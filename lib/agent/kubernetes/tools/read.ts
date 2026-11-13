import { tool } from "@langchain/core/tools"
import { z } from "zod"

import { getKubernetesClients } from "@/lib/agent/kubernetes/client"
import {
  fieldSelectorSchema,
  labelSelectorSchema,
  limitSchema,
  limitText,
  namespaceSchema,
  optionalNamespaceSchema,
  serializeToolOutput,
  summarizeResource,
} from "@/lib/agent/kubernetes/tools/shared"

const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000

function eventTime(event: {
  lastTimestamp?: unknown
  eventTime?: unknown
  firstTimestamp?: unknown
  metadata?: { creationTimestamp?: unknown }
}) {
  const value =
    event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ??
    event.metadata?.creationTimestamp
  const time = new Date(String(value ?? 0)).getTime()
  return Number.isNaN(time) ? 0 : time
}

function summarizeEvents(
  items: Array<{
    type?: string
    reason?: string
    message?: unknown
    count?: number
    firstTimestamp?: unknown
    lastTimestamp?: unknown
    eventTime?: unknown
    source?: { component?: string; host?: string }
    involvedObject?: {
      kind?: string
      name?: string
      namespace?: string
    }
    metadata?: { creationTimestamp?: unknown }
  }>,
  limit: number
) {
  const cutoff = Date.now() - MAX_EVENT_AGE_MS
  return items
    .filter((event) => eventTime(event) >= cutoff || eventTime(event) === 0)
    .toSorted((a, b) => eventTime(b) - eventTime(a))
    .slice(0, limit)
    .map((event) => ({
      type: event.type,
      reason: event.reason,
      message:
        typeof event.message === "string"
          ? event.message.slice(0, 240)
          : event.message,
      count: event.count,
      lastTimestamp: event.lastTimestamp ?? event.eventTime,
      involvedObject: event.involvedObject && {
        kind: event.involvedObject.kind,
        name: event.involvedObject.name,
        namespace: event.involvedObject.namespace,
      },
      source: event.source,
    }))
}

export const clusterInfoTool = tool(
  async () => {
    const { version } = getKubernetesClients()
    const info = await version.getCode()
    return serializeToolOutput({
      major: info.major,
      minor: info.minor,
      gitVersion: info.gitVersion,
      platform: info.platform,
      goVersion: info.goVersion,
    })
  },
  {
    name: "cluster_info",
    description:
      "Get the Kubernetes API server version and platform information.",
    schema: z.object({}),
  }
)

// The generated group APIs each expose getAPIResources() for their
// group/version, which is the same data `kubectl api-resources` prints.
export const listApiResourcesTool = tool(
  async () => {
    const clients = getKubernetesClients()
    const groups: Array<[string, { getAPIResources: () => Promise<{ groupVersion?: string; resources?: Array<{ name?: string; kind?: string; namespaced?: boolean; verbs?: string[] }> }> }]> = [
      ["core/v1", clients.core],
      ["apps/v1", clients.apps],
      ["batch/v1", clients.batch],
      ["networking.k8s.io/v1", clients.networking],
      ["rbac.authorization.k8s.io/v1", clients.rbac],
      ["autoscaling/v2", clients.autoscaling],
      ["storage.k8s.io/v1", clients.storage],
      ["policy/v1", clients.policy],
      ["apiextensions.k8s.io/v1", clients.apiextensions],
    ]

    const results = await Promise.allSettled(
      groups.map(async ([fallback, api]) => {
        const list = await api.getAPIResources()
        return {
          groupVersion: list.groupVersion ?? fallback,
          resources: (list.resources ?? [])
            .filter((resource) => !resource.name?.includes("/"))
            .map((resource) => ({
              name: resource.name,
              kind: resource.kind,
              namespaced: resource.namespaced,
              verbs: resource.verbs,
            })),
        }
      })
    )

    return serializeToolOutput(
      results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      )
    )
  },
  {
    name: "list_api_resources",
    description:
      "List the API resources (kinds) available on the cluster, grouped by API group/version. Use this to discover resource types before calling get_resource or list_resources.",
    schema: z.object({}),
  }
)

export const listNamespacesTool = tool(
  async () => {
    const { core } = getKubernetesClients()
    const response = await core.listNamespace()
    return serializeToolOutput(
      response.items.map((namespace) => ({
        name: namespace.metadata?.name,
        status: namespace.status?.phase,
        labels: namespace.metadata?.labels,
        creationTimestamp: namespace.metadata?.creationTimestamp,
      }))
    )
  },
  {
    name: "list_namespaces",
    description: "List all namespaces in the cluster.",
    schema: z.object({}),
  }
)

export const listPodsTool = tool(
  async ({ namespace, labelSelector, fieldSelector, limit }) => {
    const { core } = getKubernetesClients()
    const response = namespace
      ? await core.listNamespacedPod({
          namespace,
          labelSelector: labelSelector || undefined,
          fieldSelector: fieldSelector || undefined,
          limit,
        })
      : await core.listPodForAllNamespaces({
          labelSelector: labelSelector || undefined,
          fieldSelector: fieldSelector || undefined,
          limit,
        })

    return serializeToolOutput(
      response.items.map((pod) => ({
        name: pod.metadata?.name,
        namespace: pod.metadata?.namespace,
        phase: pod.status?.phase,
        reason: pod.status?.reason,
        node: pod.spec?.nodeName,
        podIP: pod.status?.podIP,
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
      "List pods and their current status. Omit namespace to search all namespaces; supports label/field selectors (e.g. spec.nodeName=<node>, status.phase=Failed).",
    schema: optionalNamespaceSchema.extend({
      labelSelector: labelSelectorSchema,
      fieldSelector: fieldSelectorSchema,
      limit: limitSchema,
    }),
  }
)

export const listEventsTool = tool(
  async ({ namespace, limit }) => {
    const { core } = getKubernetesClients()
    const response = namespace
      ? await core.listNamespacedEvent({ namespace, limit })
      : await core.listEventForAllNamespaces({ limit: Math.min(limit * 4, 500) })

    return serializeToolOutput(summarizeEvents(response.items, limit))
  },
  {
    name: "list_events",
    description:
      "List recent Kubernetes events (last 24h, newest first). Omit namespace to search all namespaces.",
    schema: optionalNamespaceSchema.extend({
      limit: z.number().int().min(1).max(100).default(12),
    }),
  }
)

export const getPodLogsTool = tool(
  async ({ namespace, pod, container, tailLines, previous }) => {
    const { core } = getKubernetesClients()
    return limitText(
      await core.readNamespacedPodLog({
        name: pod,
        namespace,
        container: container || undefined,
        tailLines,
        timestamps: true,
        previous: previous || undefined,
      })
    )
  },
  {
    name: "get_pod_logs",
    description:
      "Read recent logs from a Kubernetes pod without changing cluster state. Set previous=true to read the terminated container's logs (useful for CrashLoopBackOff).",
    schema: namespaceSchema.extend({
      pod: z.string().trim().min(1),
      container: z.string().trim().optional(),
      tailLines: z.number().int().min(1).max(1000).default(100),
      previous: z.boolean().default(false),
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
      initContainerStatuses: response.status?.initContainerStatuses,
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
      events: summarizeEvents(eventsResponse.items, 20),
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

function workloadListTool(
  name: string,
  description: string,
  list: (
    namespace?: string,
    labelSelector?: string,
    limit?: number
  ) => Promise<{ items: unknown[] }>
) {
  return tool(
    async ({ namespace, labelSelector, limit }) => {
      const response = await list(
        namespace || undefined,
        labelSelector || undefined,
        limit
      )
      return serializeToolOutput(
        response.items.map((item) =>
          summarizeResource(
            item as Parameters<typeof summarizeResource>[0]
          )
        )
      )
    },
    {
      name,
      description,
      schema: optionalNamespaceSchema.extend({
        labelSelector: labelSelectorSchema,
        limit: limitSchema,
      }),
    }
  )
}

export const listDeploymentsTool = workloadListTool(
  "list_deployments",
  "List deployments and their rollout status. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { apps } = getKubernetesClients()
    return namespace
      ? apps.listNamespacedDeployment({
          namespace,
          labelSelector,
          limit,
        })
      : apps.listDeploymentForAllNamespaces({ labelSelector, limit })
  }
)

export const listReplicaSetsTool = workloadListTool(
  "list_replicasets",
  "List ReplicaSets and their status. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { apps } = getKubernetesClients()
    return namespace
      ? apps.listNamespacedReplicaSet({
          namespace,
          labelSelector,
          limit,
        })
      : apps.listReplicaSetForAllNamespaces({ labelSelector, limit })
  }
)

export const listStatefulSetsTool = workloadListTool(
  "list_statefulsets",
  "List StatefulSets and their status. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { apps } = getKubernetesClients()
    return namespace
      ? apps.listNamespacedStatefulSet({
          namespace,
          labelSelector,
          limit,
        })
      : apps.listStatefulSetForAllNamespaces({ labelSelector, limit })
  }
)

export const listDaemonSetsTool = workloadListTool(
  "list_daemonsets",
  "List DaemonSets and their status. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { apps } = getKubernetesClients()
    return namespace
      ? apps.listNamespacedDaemonSet({
          namespace,
          labelSelector,
          limit,
        })
      : apps.listDaemonSetForAllNamespaces({ labelSelector, limit })
  }
)

export const listJobsTool = workloadListTool(
  "list_jobs",
  "List Jobs and their status. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { batch } = getKubernetesClients()
    return namespace
      ? batch.listNamespacedJob({ namespace, labelSelector, limit })
      : batch.listJobForAllNamespaces({ labelSelector, limit })
  }
)

export const listCronJobsTool = workloadListTool(
  "list_cronjobs",
  "List CronJobs and their schedule/status. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { batch } = getKubernetesClients()
    return namespace
      ? batch.listNamespacedCronJob({ namespace, labelSelector, limit })
      : batch.listCronJobForAllNamespaces({ labelSelector, limit })
  }
)

export const listServicesTool = workloadListTool(
  "list_services",
  "List services, their types, cluster IPs, and port mappings. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { core } = getKubernetesClients()
    return namespace
      ? core.listNamespacedService({ namespace, labelSelector, limit })
      : core.listServiceForAllNamespaces({ labelSelector, limit })
  }
)

export const listEndpointsTool = workloadListTool(
  "list_endpoints",
  "List Endpoints (the pod IPs behind each Service). Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { core } = getKubernetesClients()
    return namespace
      ? core.listNamespacedEndpoints({ namespace, labelSelector, limit })
      : core.listEndpointsForAllNamespaces({ labelSelector, limit })
  }
)

export const listIngressesTool = workloadListTool(
  "list_ingresses",
  "List Ingress resources and their routing rules. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { networking } = getKubernetesClients()
    return namespace
      ? networking.listNamespacedIngress({ namespace, labelSelector, limit })
      : networking.listIngressForAllNamespaces({ labelSelector, limit })
  }
)

export const listConfigMapsTool = tool(
  async ({ namespace, labelSelector, limit }) => {
    const { core } = getKubernetesClients()
    const response = namespace
      ? await core.listNamespacedConfigMap({
          namespace,
          labelSelector: labelSelector || undefined,
          limit,
        })
      : await core.listConfigMapForAllNamespaces({
          labelSelector: labelSelector || undefined,
          limit,
        })

    return serializeToolOutput(
      response.items.map((configMap) => ({
        name: configMap.metadata?.name,
        namespace: configMap.metadata?.namespace,
        labels: configMap.metadata?.labels,
        keys: Object.keys(configMap.data ?? {}),
      }))
    )
  },
  {
    name: "list_configmaps",
    description:
      "List ConfigMaps and their data keys. Omit namespace to search all namespaces.",
    schema: optionalNamespaceSchema.extend({
      labelSelector: labelSelectorSchema,
      limit: limitSchema,
    }),
  }
)

export const getConfigMapTool = tool(
  async ({ namespace, name }) => {
    const { core } = getKubernetesClients()
    const response = await core.readNamespacedConfigMap({ name, namespace })
    return serializeToolOutput({
      name: response.metadata?.name,
      namespace: response.metadata?.namespace,
      labels: response.metadata?.labels,
      data: response.data,
      binaryData: response.binaryData
        ? Object.fromEntries(
            Object.keys(response.binaryData).map((key) => [key, "<binary>"])
          )
        : undefined,
    })
  },
  {
    name: "get_configmap",
    description:
      "Get a ConfigMap including its data. Use get_resource for other resource types.",
    schema: namespaceSchema.extend({ name: z.string().trim().min(1) }),
  }
)

export const getSecretTool = tool(
  async ({ namespace, name, includeData }) => {
    const { core } = getKubernetesClients()
    const response = await core.readNamespacedSecret({ name, namespace })
    const base = {
      name: response.metadata?.name,
      namespace: response.metadata?.namespace,
      type: response.type,
      labels: response.metadata?.labels,
      keys: Object.keys(response.data ?? {}),
    }
    if (!includeData) {
      return serializeToolOutput({
        ...base,
        note: "Secret values are masked. Pass includeData=true to decode them.",
      })
    }
    const decoded = Object.fromEntries(
      Object.entries(response.data ?? {}).map(([key, value]) => [
        key,
        Buffer.from(value, "base64").toString("utf8"),
      ])
    )
    return serializeToolOutput({ ...base, data: decoded })
  },
  {
    name: "get_secret",
    description:
      "Get a Secret's metadata and data keys. Values are masked unless includeData=true, which returns base64-decoded values — handle them as sensitive.",
    schema: namespaceSchema.extend({
      name: z.string().trim().min(1),
      includeData: z.boolean().default(false),
    }),
  }
)

export const listNodesTool = tool(
  async ({ labelSelector, limit }) => {
    const { core } = getKubernetesClients()
    const response = await core.listNode({
      labelSelector: labelSelector || undefined,
      limit,
    })
    return serializeToolOutput(
      response.items.map((node) => ({
        name: node.metadata?.name,
        labels: node.metadata?.labels,
        unschedulable: node.spec?.unschedulable ?? false,
        taints: node.spec?.taints,
        conditions: node.status?.conditions
          ?.filter((condition) => condition.type === "Ready")
          .map((condition) => ({
            type: condition.type,
            status: condition.status,
            reason: condition.reason,
          })),
        capacity: node.status?.capacity,
        allocatable: node.status?.allocatable,
      }))
    )
  },
  {
    name: "list_nodes",
    description:
      "List cluster nodes with readiness, schedulability, taints, and capacity.",
    schema: z.object({
      labelSelector: labelSelectorSchema,
      limit: limitSchema,
    }),
  }
)

export const listPersistentVolumeClaimsTool = workloadListTool(
  "list_persistentvolumeclaims",
  "List PersistentVolumeClaims and their binding status. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { core } = getKubernetesClients()
    return namespace
      ? core.listNamespacedPersistentVolumeClaim({
          namespace,
          labelSelector,
          limit,
        })
      : core.listPersistentVolumeClaimForAllNamespaces({ labelSelector, limit })
  }
)

export const listPersistentVolumesTool = tool(
  async ({ labelSelector, limit }) => {
    const { core } = getKubernetesClients()
    const response = await core.listPersistentVolume({
      labelSelector: labelSelector || undefined,
      limit,
    })
    return serializeToolOutput(
      response.items.map((pv) => ({
        name: pv.metadata?.name,
        capacity: pv.spec?.capacity,
        accessModes: pv.spec?.accessModes,
        persistentVolumeReclaimPolicy: pv.spec?.persistentVolumeReclaimPolicy,
        claimRef: pv.spec?.claimRef,
        phase: pv.status?.phase,
      }))
    )
  },
  {
    name: "list_persistentvolumes",
    description: "List cluster PersistentVolumes, capacity, and binding status.",
    schema: z.object({
      labelSelector: labelSelectorSchema,
      limit: limitSchema,
    }),
  }
)

export const listStorageClassesTool = tool(
  async ({ limit }) => {
    const { storage } = getKubernetesClients()
    const response = await storage.listStorageClass({ limit })
    return serializeToolOutput(
      response.items.map((storageClass) => ({
        name: storageClass.metadata?.name,
        provisioner: storageClass.provisioner,
        volumeBindingMode: storageClass.volumeBindingMode,
        allowVolumeExpansion: storageClass.allowVolumeExpansion,
        isDefault: storageClass.metadata?.annotations?.[
          "storageclass.kubernetes.io/is-default-class"
        ],
      }))
    )
  },
  {
    name: "list_storageclasses",
    description: "List StorageClasses and their provisioners.",
    schema: z.object({ limit: limitSchema }),
  }
)

export const listHorizontalPodAutoscalersTool = workloadListTool(
  "list_horizontalpodautoscalers",
  "List HorizontalPodAutoscalers and their scaling targets/status. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { autoscaling } = getKubernetesClients()
    return namespace
      ? autoscaling.listNamespacedHorizontalPodAutoscaler({
          namespace,
          labelSelector,
          limit,
        })
      : autoscaling.listHorizontalPodAutoscalerForAllNamespaces({
          labelSelector,
          limit,
        })
  }
)

export const listNetworkPoliciesTool = workloadListTool(
  "list_networkpolicies",
  "List NetworkPolicies and their pod/ingress/egress rules. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { networking } = getKubernetesClients()
    // NetworkPolicy lives in networking.k8s.io/v1, not policy/v1.
    return namespace
      ? networking.listNamespacedNetworkPolicy({
          namespace,
          labelSelector,
          limit,
        })
      : networking.listNetworkPolicyForAllNamespaces({ labelSelector, limit })
  }
)

export const listResourceQuotasTool = workloadListTool(
  "list_resourcequotas",
  "List ResourceQuotas and their hard/used limits. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { core } = getKubernetesClients()
    return namespace
      ? core.listNamespacedResourceQuota({ namespace, labelSelector, limit })
      : core.listResourceQuotaForAllNamespaces({ labelSelector, limit })
  }
)

export const listRolesTool = workloadListTool(
  "list_roles",
  "List namespaced RBAC Roles and their rules. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { rbac } = getKubernetesClients()
    return namespace
      ? rbac.listNamespacedRole({ namespace, labelSelector, limit })
      : rbac.listRoleForAllNamespaces({ labelSelector, limit })
  }
)

export const listClusterRolesTool = tool(
  async ({ labelSelector, limit }) => {
    const { rbac } = getKubernetesClients()
    const response = await rbac.listClusterRole({
      labelSelector: labelSelector || undefined,
      limit,
    })
    return serializeToolOutput(
      response.items.map((role) => ({
        name: role.metadata?.name,
        labels: role.metadata?.labels,
        rules: role.rules,
      }))
    )
  },
  {
    name: "list_clusterroles",
    description: "List ClusterRoles and their RBAC rules.",
    schema: z.object({
      labelSelector: labelSelectorSchema,
      limit: limitSchema,
    }),
  }
)

export const listRoleBindingsTool = workloadListTool(
  "list_rolebindings",
  "List namespaced RBAC RoleBindings. Omit namespace to search all namespaces.",
  async (namespace, labelSelector, limit) => {
    const { rbac } = getKubernetesClients()
    return namespace
      ? rbac.listNamespacedRoleBinding({ namespace, labelSelector, limit })
      : rbac.listRoleBindingForAllNamespaces({ labelSelector, limit })
  }
)

export const listClusterRoleBindingsTool = tool(
  async ({ labelSelector, limit }) => {
    const { rbac } = getKubernetesClients()
    const response = await rbac.listClusterRoleBinding({
      labelSelector: labelSelector || undefined,
      limit,
    })
    return serializeToolOutput(
      response.items.map((binding) => ({
        name: binding.metadata?.name,
        labels: binding.metadata?.labels,
        roleRef: binding.roleRef,
        subjects: binding.subjects,
      }))
    )
  },
  {
    name: "list_clusterrolebindings",
    description: "List ClusterRoleBindings, their role references, and subjects.",
    schema: z.object({
      labelSelector: labelSelectorSchema,
      limit: limitSchema,
    }),
  }
)

export const listCustomResourceDefinitionsTool = tool(
  async ({ labelSelector, limit }) => {
    const { apiextensions } = getKubernetesClients()
    const response = await apiextensions.listCustomResourceDefinition({
      labelSelector: labelSelector || undefined,
      limit,
    })
    return serializeToolOutput(
      response.items.map((crd) => ({
        name: crd.metadata?.name,
        group: crd.spec?.group,
        names: crd.spec?.names,
        scope: crd.spec?.scope,
        versions: crd.spec?.versions?.map((version) => version.name),
      }))
    )
  },
  {
    name: "list_customresourcedefinitions",
    description:
      "List CustomResourceDefinitions (CRDs) installed on the cluster.",
    schema: z.object({
      labelSelector: labelSelectorSchema,
      limit: limitSchema,
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

// Generic escape hatch for any apiVersion/kind, including CRs. The object
// client resolves the resource through API discovery, so this covers
// resources that have no dedicated tool.
export const getResourceTool = tool(
  async ({ apiVersion, kind, namespace, name }) => {
    const { object } = getKubernetesClients()
    const response = await object.read({
      apiVersion,
      kind,
      metadata: { name, ...(namespace ? { namespace } : {}) },
    })
    return serializeToolOutput(response)
  },
  {
    name: "get_resource",
    description:
      "Get any Kubernetes resource by apiVersion, kind, and name (e.g. apiVersion 'apps/v1' kind 'Deployment', or a CRD like 'monitoring.coreos.com/v1' 'ServiceMonitor'). Omit namespace for cluster-scoped resources. Output is truncated for large objects.",
    schema: z.object({
      apiVersion: z.string().trim().min(1).max(120),
      kind: z.string().trim().min(1).max(60),
      namespace: z.string().trim().min(1).optional(),
      name: z.string().trim().min(1),
    }),
  }
)

export const listResourcesTool = tool(
  async ({ apiVersion, kind, namespace, labelSelector, fieldSelector, limit }) => {
    const { object } = getKubernetesClients()
    const response = await object.list(
      apiVersion,
      kind,
      namespace || undefined,
      undefined,
      undefined,
      undefined,
      fieldSelector || undefined,
      labelSelector || undefined,
      limit
    )
    return serializeToolOutput({
      total: response.items.length,
      items: response.items.map(summarizeResource),
    })
  },
  {
    name: "list_resources",
    description:
      "List any Kubernetes resource type by apiVersion and kind (works for CRDs too). Omit namespace to list across all namespaces. Returns compact summaries; use get_resource for full detail.",
    schema: z.object({
      apiVersion: z.string().trim().min(1).max(120),
      kind: z.string().trim().min(1).max(60),
      namespace: z.string().trim().min(1).optional(),
      labelSelector: labelSelectorSchema,
      fieldSelector: fieldSelectorSchema,
      limit: limitSchema,
    }),
  }
)
