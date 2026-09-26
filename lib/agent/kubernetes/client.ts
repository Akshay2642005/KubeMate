import * as k8s from "@kubernetes/client-node"

type KubernetesClients = {
  core: k8s.CoreV1Api
  apps: k8s.AppsV1Api
}

let clients: KubernetesClients | undefined

export function getKubernetesClients(): KubernetesClients {
  if (clients) return clients

  const kubeConfig = new k8s.KubeConfig()
  kubeConfig.loadFromDefault()
  clients = {
    core: kubeConfig.makeApiClient(k8s.CoreV1Api),
    apps: kubeConfig.makeApiClient(k8s.AppsV1Api),
  }
  return clients
}
