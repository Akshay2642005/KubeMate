# Kubernetes access

The agent uses `@kubernetes/client-node`, not `kubectl`. In a Pod, the client loads
the mounted ServiceAccount token through `KubeConfig.loadFromDefault()`.

This initial RBAC policy is read-only and covers only the resources used by the
first tool set: pods, pod logs, events, services, and deployments. It does not
grant access to Secrets or any mutation verbs.

Render the manifests with:

```bash
kubectl kustomize k8s/
```

For a complete test deployment, run the root-level wizard instead. It builds
the image and creates provider/database secrets without writing them to the
repository:

```bash
./scripts/deploy-test.sh
```

Apply them only after reviewing the rendered output and selecting the target
cluster explicitly:

```bash
kubectl apply -k k8s/
```
