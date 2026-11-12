# Kubernetes access

The agent uses `@kubernetes/client-node`, not `kubectl`. In a Pod, the client loads
the mounted ServiceAccount token through `KubeConfig.loadFromDefault()`.

The workload is split into two Deployments that run the same image content but
have different RBAC scopes:

| Workload | SA | Mounts token | RBAC | Purpose |
| --- | --- | --- | --- | --- |
| `kubernetes-agent-web` | none | No | None | Serves the chat UI and API. Reads/writes Postgres only. |
| `kubernetes-agent-runner` | `kubernetes-agent` | Yes | read-only + writer | Executes the agent graph and approved Kubernetes actions. |

The web pod has `automountServiceAccountToken: false` and no ClusterRole or
ClusterRoleBinding for the Kubernetes API. The runner pod keeps the mounted
ServiceAccount token and is the only workload bound to the `kubernetes-agent-readonly`
and `kubernetes-agent-approved-writer` ClusterRoles.

In-cluster Kubernetes API calls use `loadFromCluster()`; local development uses
the kubeconfig selected by `KUBECONFIG` or the default kubeconfig for the user
running the process. The client refuses to use client-node's `localhost:8080`
fallback when no context is configured.

For local development, verify the same user and environment that runs the app:

```bash
kubectl config current-context
kubectl get nodes --request-timeout=10s
```

If the app runs in a container, mount the kubeconfig and set `KUBECONFIG` to
the path inside that container. Prefer inline `certificate-authority-data` in
the kubeconfig; a `certificate-authority` host path must also be mounted at the
same path. The runner also sets `NODE_EXTRA_CA_CERTS` to the projected
ServiceAccount CA because Bun's fetch does not consistently consume the
request-scoped CA dispatcher from `@kubernetes/client-node`. This preserves
certificate verification; do not set `insecure-skip-tls-verify` for a shared
or production cluster.

The runner pod is exposed as a private ClusterIP Service
(`kubernetes-agent-runner`) that only the web pod can reach through the cluster
network; it is not exposed to the internet.

The base policy is intentionally minimal. The writer ClusterRole only covers the
verbs and resources the approved write actions need: `nodes:patch`, `pods:create`,
`pods:delete`, and `deployments:patch`.

Render the manifests with:

```bash
kubectl kustomize k8s/
```

For a complete test deployment, build the image locally and deploy it with the
development script, which creates the provider and database secrets without
writing them to the repository:

```bash
./scripts/deploy.sh --dev
```

Apply them only after reviewing the rendered output and selecting the target
cluster explicitly:

```bash
kubectl apply -k k8s/
```
