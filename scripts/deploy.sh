#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMESPACE="kubernetes-agent"
IMAGE="${IMAGE:-kubernetes-agent:local}"
LOAD_IMAGE="${LOAD_IMAGE:-ask}"
PUSH_IMAGE="${PUSH_IMAGE:-no}"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null || die "docker is required"
command -v kubectl >/dev/null || die "kubectl is required for deployment"

printf 'Kubernetes context: '
CURRENT_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
printf '%s\n' "${CURRENT_CONTEXT:-none}"
[[ -n "$CURRENT_CONTEXT" ]] || die "kubectl has no current context"
read -r -p "Deploy to this context? [y/N] " CONFIRM_CONTEXT
[[ "$CONFIRM_CONTEXT" =~ ^[Yy]$ ]] || die "deployment cancelled"

read -r -p "Provider [openrouter/groq/nvidia] (openrouter): " PROVIDER
PROVIDER="${PROVIDER:-openrouter}"
case "$PROVIDER" in
  openrouter) DEFAULT_MODEL="openai/gpt-4o-mini" ;;
  groq) DEFAULT_MODEL="llama-3.3-70b-versatile" ;;
  nvidia) DEFAULT_MODEL="meta/llama-3.1-70b-instruct" ;;
  *) die "provider must be openrouter, groq, or nvidia" ;;
esac

read -r -p "Model (${DEFAULT_MODEL}): " AI_MODEL
AI_MODEL="${AI_MODEL:-$DEFAULT_MODEL}"
read -r -s -p "${PROVIDER} API key: " AI_API_KEY
printf '\n'
[[ -n "$AI_API_KEY" ]] || die "API key cannot be empty"

DB_PASSWORD="${DB_PASSWORD:-}"
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
    read -r -s -p "Postgres password: " DB_PASSWORD
    printf '\n'
  fi
fi
[[ -n "$DB_PASSWORD" ]] || die "Postgres password cannot be empty"

printf 'Building image %s...\n' "$IMAGE"
docker build --tag "$IMAGE" "$ROOT_DIR"

if [[ "$LOAD_IMAGE" == "ask" ]]; then
  read -r -p "Load the image into a local kind/minikube cluster? [Y/n] " LOAD_ANSWER
  [[ "$LOAD_ANSWER" =~ ^[Nn]$ ]] && LOAD_IMAGE="no" || LOAD_IMAGE="yes"
fi

if [[ "$LOAD_IMAGE" == "yes" ]]; then
  if command -v minikube >/dev/null && minikube status >/dev/null 2>&1; then
    minikube image load "$IMAGE"
  elif command -v kind >/dev/null; then
    kind load docker-image "$IMAGE"
  else
    die "LOAD_IMAGE=yes requires a running minikube or kind cluster"
  fi
elif [[ "$PUSH_IMAGE" == "yes" ]]; then
  docker push "$IMAGE"
else
  printf 'The cluster must already be able to pull %s.\n' "$IMAGE"
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
kubectl kustomize "$ROOT_DIR/k8s" \
  | sed "s|image: kubernetes-agent:local|image: ${IMAGE}|g" \
  | kubectl apply -f -

printf 'Waiting for Postgres to become ready...\n'
kubectl -n "$NAMESPACE" wait --for=condition=ready pod/kubernetes-agent-postgres-0 --timeout=180s

# The StatefulSet uses a persistent volume, so changing the Kubernetes Secret
# does not change the password stored in an already-initialized Postgres role.
# Reconcile the role through Postgres' local trust connection before migrating.
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
