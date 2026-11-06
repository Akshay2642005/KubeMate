#!/usr/bin/env bash
#
# Deploy a published KubeMate image to a cluster.
#
# This script never builds anything. Publish an image with the release workflow
# (push a semantic version tag) or with `docker build` plus `docker push`, then:
#
#   IMAGE=ghcr.io/akshay2642005/kubemate:0.1.0 \
#   AI_PROVIDER=openrouter \
#   AI_MODEL=openai/gpt-4o-mini \
#   AI_API_KEY=... \
#   DB_PASSWORD=... \
#   ./scripts/deploy.sh
#
# IMAGE is optional: it defaults to the reference pinned in
# k8s/production/kustomization.yaml, which the release workflow keeps current.
#
# For a local build against a local cluster, use ./scripts/dev-deploy.sh.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMESPACE="${NAMESPACE:-kubernetes-agent}"
PROVIDER="${AI_PROVIDER:-openrouter}"
AI_MODEL="${AI_MODEL:-openai/gpt-4o-mini}"
AI_API_KEY="${AI_API_KEY:-}"
DB_PASSWORD="${DB_PASSWORD:-}"
ASSUME_YES="${ASSUME_YES:-no}"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

# The release workflow rewrites newName/newTag on every version tag, so reading
# the overlay keeps this script on the same image the manifests already pin.
DEFAULT_IMAGE="$(
  awk '/^[[:space:]]*newName:/{name=$2} /^[[:space:]]*newTag:/{tag=$2} END{if (name && tag) print name ":" tag}' \
    "$ROOT_DIR/k8s/production/kustomization.yaml"
)"
IMAGE="${IMAGE:-$DEFAULT_IMAGE}"

MANIFEST_NAMESPACE="$(awk '/^namespace:/{print $2; exit}' "$ROOT_DIR/k8s/base/kustomization.yaml")"

command -v kubectl >/dev/null || die "kubectl is required for deployment"
[[ -n "$DEFAULT_IMAGE" ]] || die "could not read an image reference from k8s/production/kustomization.yaml"
[[ -n "$IMAGE" ]] || die "IMAGE is empty"
[[ "$IMAGE" == *:* || "$IMAGE" == *"@sha256:"* ]] || die "IMAGE must include a tag, for example ghcr.io/acme/kubemate:0.1.0"
[[ -n "$AI_MODEL" ]] || die "AI_MODEL is required"
[[ -n "$AI_API_KEY" ]] || die "AI_API_KEY is required"
[[ "$NAMESPACE" == "$MANIFEST_NAMESPACE" ]] \
  || die "NAMESPACE is '$NAMESPACE' but the manifests deploy to '$MANIFEST_NAMESPACE'"

case "$PROVIDER" in
  openrouter|groq|nvidia) ;;
  *) die "AI_PROVIDER must be openrouter, groq, or nvidia" ;;
esac

if [[ -z "$DB_PASSWORD" ]]; then
  EXISTING_DB_PASSWORD_B64="$(kubectl -n "$NAMESPACE" get secret kubernetes-agent-secrets -o jsonpath='{.data.DATABASE_PASSWORD}' 2>/dev/null || true)"
  if [[ -n "$EXISTING_DB_PASSWORD_B64" ]]; then
    if DB_PASSWORD="$(printf '%s' "$EXISTING_DB_PASSWORD_B64" | base64 --decode 2>/dev/null)"; then
      :
    else
      DB_PASSWORD="$(printf '%s' "$EXISTING_DB_PASSWORD_B64" | base64 -D)"
    fi
    printf 'Reusing the existing Postgres password from the Kubernetes Secret.\n'
  elif command -v openssl >/dev/null; then
    DB_PASSWORD="$(openssl rand -hex 24)"
    printf 'Generated a Postgres password for this deployment.\n'
  else
    die "DB_PASSWORD is required when no existing Secret is present and openssl is unavailable"
  fi
fi
[[ -n "$DB_PASSWORD" ]] || die "DB_PASSWORD cannot be empty"

CURRENT_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
[[ -n "$CURRENT_CONTEXT" ]] || die "kubectl has no current context"
printf 'Target context: %s\nTarget namespace: %s\nImage: %s\n' \
  "$CURRENT_CONTEXT" "$NAMESPACE" "$IMAGE"

if [[ "$ASSUME_YES" != "yes" && -t 0 ]]; then
  read -r -p "Deploy to this context? [y/N] " CONFIRM_CONTEXT
  [[ "$CONFIRM_CONTEXT" =~ ^[Yy]$ ]] || die "deployment cancelled"
fi

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

RENDERED="$(kubectl kustomize "$ROOT_DIR/k8s/production")"
if [[ "$IMAGE" != "$DEFAULT_IMAGE" ]]; then
  RENDERED="${RENDERED//image: $DEFAULT_IMAGE/image: $IMAGE}"
fi
grep -qF "image: $IMAGE" <<< "$RENDERED" \
  || die "the rendered manifests do not reference $IMAGE; refusing to apply"
printf '%s\n' "$RENDERED" | kubectl apply -f -

printf 'Waiting for Postgres to become ready...\n'
kubectl -n "$NAMESPACE" wait --for=condition=ready pod/kubernetes-agent-postgres-0 --timeout=180s

# The StatefulSet keeps its initialized role password in the persistent volume,
# so changing the Kubernetes Secret does not change the password stored in an
# already-initialized Postgres role. Reconcile the role over Postgres' local
# trust connection before running the schema job.
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

printf '\nDeployment complete.\n'
printf 'Service: kubernetes-agent.%s.svc.cluster.local:3000\n' "$NAMESPACE"
printf 'Local access: kubectl -n %s port-forward svc/kubernetes-agent 3000:3000\n' "$NAMESPACE"
