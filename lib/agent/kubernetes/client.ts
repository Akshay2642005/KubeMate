import * as k8s from "@kubernetes/client-node"

type KubernetesClients = {
  core: k8s.CoreV1Api
  apps: k8s.AppsV1Api
}

type CachedClients = {
  value: KubernetesClients
  expiresAt: number
}

const IN_CLUSTER_HOST = "KUBERNETES_SERVICE_HOST"
const KUBECONFIG_ENV = "KUBECONFIG"

// Projected ServiceAccount tokens rotate, so rebuild the config periodically
// instead of pinning the first token for the life of the process.
const CLIENT_TTL_MS = 10 * 60 * 1000

let cached: CachedClients | undefined

function configurationError(message: string, cause?: unknown) {
  const detail = cause instanceof Error ? ` ${cause.message}` : ""
  return new Error(`Kubernetes client configuration error: ${message}${detail}`)
}

function loadKubeConfig() {
  const kubeConfig = new k8s.KubeConfig()

  if (process.env[IN_CLUSTER_HOST]) {
    // In a Pod, use the mounted ServiceAccount identity explicitly.
    try {
      kubeConfig.loadFromCluster()
    } catch (error) {
      throw configurationError(
        "in-cluster credentials could not be loaded. Make sure the runner has a mounted ServiceAccount token and CA bundle.",
        error
      )
    }
  } else {
    // Local development uses the kubeconfig selected by KUBECONFIG, or the
    // default kubeconfig for the user running the process.
    const kubeconfigPath = process.env[KUBECONFIG_ENV]?.trim()
    try {
      // loadFromDefault supports KUBECONFIG's multi-file merge semantics. For
      // one explicit file, load it directly so a missing/unreadable path is
      // reported instead of silently falling back to localhost:8080.
      if (
        kubeconfigPath &&
        !kubeconfigPath.includes(process.platform === "win32" ? ";" : ":")
      ) {
        kubeConfig.loadFromFile(kubeconfigPath)
      } else {
        kubeConfig.loadFromDefault()
      }
    } catch (error) {
      throw configurationError(
        kubeconfigPath
          ? `kubeconfig ${kubeconfigPath} could not be loaded. Check that the runner user can read it and that its certificate-authority path is mounted.`
          : "the default kubeconfig could not be loaded. Set KUBECONFIG to a readable kubeconfig for the runner user.",
        error
      )
    }
  }

  const context = kubeConfig.getCurrentContext()
  const cluster = kubeConfig.getCurrentCluster()
  if (!context || !cluster?.server) {
    throw configurationError(
      "no usable cluster is selected. Set KUBECONFIG and select a context whose cluster has a server URL; refusing the client-node localhost:8080 fallback."
    )
  }

  return kubeConfig
}

export function getKubernetesClients(): KubernetesClients {
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const kubeConfig = loadKubeConfig()
  cached = {
    value: {
      core: kubeConfig.makeApiClient(k8s.CoreV1Api),
      apps: kubeConfig.makeApiClient(k8s.AppsV1Api),
    },
    expiresAt: Date.now() + CLIENT_TTL_MS,
  }
  return cached.value
}
