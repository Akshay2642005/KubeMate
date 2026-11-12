import * as k8s from "@kubernetes/client-node"

type KubernetesClients = {
  core: k8s.CoreV1Api
  apps: k8s.AppsV1Api
}

type CachedClients = {
  value: KubernetesClients
  expiresAt: number
}

// Projected ServiceAccount tokens rotate, so rebuild the config periodically
// instead of pinning the first token for the life of the process.
const CLIENT_TTL_MS = 10 * 60 * 1000

let cached: CachedClients | undefined

function loadKubeConfig() {
  const kubeConfig = new k8s.KubeConfig()

  if (process.env.KUBERNETES_SERVICE_HOST) {
    // In a Pod, use the mounted ServiceAccount identity explicitly.
    kubeConfig.loadFromCluster()
  } else {
    // Local development uses the developer's kubeconfig.
    kubeConfig.loadFromDefault()
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
