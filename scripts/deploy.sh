#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMESPACE="${NAMESPACE:-kubernetes-agent}"
IMAGE="${IMAGE:-}"
PROVIDER="${AI_PROVIDER:-openrouter}"
AI_MODEL="${AI_MODEL:-}"
AI_API_KEY="${AI_API_KEY:-}"
DB_PASSWORD="${DB_PASSWORD:-}"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

command -v kubectl >/dev/null || die "kubectl is required"
[[ -n "$IMAGE" ]] || die "IMAGE is required, for example ghcr.io/acme/kubemate:sha-abc123"
[[ -n "$AI_MODEL" ]] || die "AI_MODEL is required"
[[ -n "$AI_API_KEY" ]] || die "AI_API_KEY is required"
[[ -n "$DB_PASSWORD" ]] || die "DB_PASSWORD is required"

case "$PROVIDER" in
  openrouter|groq|nvidia) ;;
  *) die "AI_PROVIDER must be openrouter, groq, or nvidia" ;;
esac

printf 'Deploying %s to namespace %s\n' "$IMAGE" "$NAMESPACE"

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" create configmap kubernetes-agent-config \
  --from-literal=AI_PROVIDER="$PROVIDER" \
  --from-literal=AI_MODEL="$AI_MODEL" \
  --from-literal=DATABASE_HOST=kubernetes-agent-postgres \
  --from-literal=DATABASE_PORT=5432 \
  --from-literal=DATABASE_NAME=kubernetes_agent \
  --from-literal=DATABASE_USER=kubernetes_agent \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" create secret generic kubernetes-agent-secrets \
  --from-literal=AI_API_KEY="$AI_API_KEY" \
  --from-literal=DATABASE_PASSWORD="$DB_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" delete job kubernetes-agent-db-push --ignore-not-found
kubectl kustomize "$ROOT_DIR/k8s/production" \
  | sed "s|ghcr.io/OWNER/kubemate:latest|${IMAGE}|g" \
  | kubectl apply -f -

printf 'Waiting for Postgres to become ready...\n'
kubectl -n "$NAMESPACE" wait --for=condition=ready pod/kubernetes-agent-postgres-0 --timeout=180s

# The StatefulSet keeps its initialized role password in the persistent volume.
ESCAPED_DB_PASSWORD="${DB_PASSWORD//\'/\'\'}"
printf "ALTER ROLE kubernetes_agent PASSWORD '%s';\n" "$ESCAPED_DB_PASSWORD" \
  | kubectl -n "$NAMESPACE" exec -i statefulset/kubernetes-agent-postgres -c postgres -- \
      psql -X -v ON_ERROR_STOP=1 -U kubernetes_agent -d postgres >/dev/null

printf 'Waiting for database schema job...\n'
if ! kubectl -n "$NAMESPACE" wait --for=condition=complete job/kubernetes-agent-db-push --timeout=180s; then
  kubectl -n "$NAMESPACE" logs job/kubernetes-agent-db-push --all-containers=true || true
  die "database schema job failed"
fi

printf 'Waiting for application rollout...\n'
kubectl -n "$NAMESPACE" rollout status deployment/kubernetes-agent --timeout=180s
printf 'Deployment complete.\n'
