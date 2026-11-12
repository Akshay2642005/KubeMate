#!/usr/bin/env bash
#
# Deploy KubeMate to a Kubernetes cluster.
#
# Usage:
#
#   ./scripts/deploy.sh [--release|--dev]
#
#   --release (default)  Deploy an already-published image to a cluster.
#                        Never builds anything. Set IMAGE, AI_PROVIDER,
#                        AI_MODEL, AI_API_KEY and optionally DB_PASSWORD:
#
#                          IMAGE=ghcr.io/akshay2642005/kubemate:0.1.0 \
#                          AI_PROVIDER=openrouter \
#                          AI_MODEL=openai/gpt-4o-mini \
#                          AI_API_KEY=... \
#                          ./scripts/deploy.sh
#
#                        IMAGE is optional: it defaults to the reference pinned
#                        in k8s/production/kustomization.yaml, which the release
#                        workflow keeps current. Set ASSUME_YES=yes to skip the
#                        context confirmation.
#
#   --dev                Build the image with docker and deploy that build to a
#                        development cluster. Applies the base manifests from
#                        k8s/. Prompts for the provider, API key, and Postgres
#                        password; set LOAD_IMAGE=yes|no|ask and PUSH_IMAGE=yes
#                        to control what happens with the built image.
#
# Both modes create the configuration and secrets from the environment or from
# the prompts, apply the manifests, run the schema push job, and wait for the
# rollout. For the production path, review the rendered output before running.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMESPACE="${NAMESPACE:-kubernetes-agent}"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

MODE="release"
case "${1:-}" in
  ""|--release) MODE="release" ;;
  --dev) MODE="dev" ;;
  -h|--help) usage; exit 0 ;;
  *) die "unknown argument '${1:-}' (expected --release or --dev)" ;;
esac

command -v kubectl >/dev/null || die "kubectl is required for deployment"

MANIFEST_NAMESPACE="$(awk '/^namespace:/{print $2; exit}' "$ROOT_DIR/k8s/base/kustomization.yaml")"
[[ "$NAMESPACE" == "$MANIFEST_NAMESPACE" ]] \
  || die "NAMESPACE is '$NAMESPACE' but the manifests deploy to '$MANIFEST_NAMESPACE'"

CURRENT_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
[[ -n "$CURRENT_CONTEXT" ]] || die "kubectl has no current context"

# --- Resolve the mode-specific pieces --------------------------------------

if [[ "$MODE" == "release" ]]; then
  # The release workflow rewrites newName/newTag on every version tag, so
  # reading the overlay keeps this script on the same image the manifests pin.
  DEFAULT_IMAGE="$(
    awk '/^[[:space:]]*newName:/{name=$2} /^[[:space:]]*newTag:/{tag=$2} END{if (name && tag) print name ":" tag}' \
      "$ROOT_DIR/k8s/production/kustomization.yaml"
  )"
  IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
  OVERLAY_DIR="$ROOT_DIR/k8s/production"
  # Placeholder the overlay pins; only relevant when IMAGE overrides it.
  TEMPLATE_IMAGE="$DEFAULT_IMAGE"

  PROVIDER="${AI_PROVIDER:-openrouter}"
  AI_MODEL="${AI_MODEL:-openai/gpt-4o-mini}"
  AI_API_KEY="${AI_API_KEY:-}"

  [[ -n "$DEFAULT_IMAGE" ]] || die "could not read an image reference from k8s/production/kustomization.yaml"
  [[ -n "$IMAGE" ]] || die "IMAGE is empty"
  case "$PROVIDER" in
    openrouter|groq|nvidia) ;;
    *) die "AI_PROVIDER must be openrouter, groq, or nvidia" ;;
  esac
  [[ -n "$AI_MODEL" ]] || die "AI_MODEL is required"
  [[ -n "$AI_API_KEY" ]] || die "AI_API_KEY is required"

  # The context confirmation is opt-out for interactive runs and skipped for
  # non-interactive jobs that set ASSUME_YES=yes (or have no tty).
  if [[ "${ASSUME_YES:-no}" != "yes" && -t 0 ]]; then
    printf 'Target context: %s\nTarget namespace: %s\nImage: %s\n' \
      "$CURRENT_CONTEXT" "$NAMESPACE" "$IMAGE"
    read -r -p "Deploy to this context? [y/N] " CONFIRM_CONTEXT
    [[ "$CONFIRM_CONTEXT" =~ ^[Yy]$ ]] || die "deployment cancelled"
  else
    printf 'Target context: %s\nTarget namespace: %s\nImage: %s\n' \
      "$CURRENT_CONTEXT" "$NAMESPACE" "$IMAGE"
  fi
else
  # Dev mode: the base overlay ships this placeholder; the build is tagged
  # with IMAGE and the rendered output is rewritten to match.
  TEMPLATE_IMAGE="kubernetes-agent:local"
  # A fresh tag prevents a local Docker Desktop cluster from reusing an old
  # image when the same development tag is rebuilt with imagePullPolicy
  # IfNotPresent.
  IMAGE="${IMAGE:-kubernetes-agent:dev-$(date +%Y%m%d%H%M%S)}"
  OVERLAY_DIR="$ROOT_DIR/k8s"
  LOAD_IMAGE="${LOAD_IMAGE:-ask}"
  PUSH_IMAGE="${PUSH_IMAGE:-no}"

  command -v docker >/dev/null || die "docker is required for --dev"

  printf 'Target context: %s\nTarget namespace: %s\nImage: %s\n' \
    "$CURRENT_CONTEXT" "$NAMESPACE" "$IMAGE"
  if [[ "${ASSUME_YES:-no}" == "yes" ]]; then
    :
  elif [[ -t 0 ]]; then
    read -r -p "Deploy to this context? [y/N] " CONFIRM_CONTEXT
    [[ "$CONFIRM_CONTEXT" =~ ^[Yy]$ ]] || die "deployment cancelled"
  else
    die "stdin is not a terminal; set ASSUME_YES=yes to deploy non-interactively"
  fi

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
fi

[[ "$IMAGE" == *:* || "$IMAGE" == *"@sha256:"* ]] \
  || die "IMAGE must include a tag, for example ghcr.io/acme/kubemate:0.1.0"
[[ -n "$TEMPLATE_IMAGE" ]] || die "could not resolve the placeholder image for $OVERLAY_DIR"

# --- Postgres password: reuse, generate, or ask -----------------------------

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
  elif [[ "$MODE" == "dev" ]]; then
    read -r -s -p "Postgres password: " DB_PASSWORD
    printf '\n'
  else
    die "DB_PASSWORD is required when no existing Secret is present and openssl is unavailable"
  fi
fi
[[ -n "$DB_PASSWORD" ]] || die "DB_PASSWORD cannot be empty"

# --- Dev mode: build (and optionally load/push) the image -------------------

if [[ "$MODE" == "dev" ]]; then
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
fi

# --- Apply configuration, secrets, manifests --------------------------------

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

RENDERED="$(kubectl kustomize "$OVERLAY_DIR")"
if [[ "$IMAGE" != "$TEMPLATE_IMAGE" ]]; then
  # Scope the rewrite to image lines only instead of a blunt substring replace.
  RENDERED="$(printf '%s\n' "$RENDERED" | sed "s|^\\([[:space:]]*-[[:space:]]*image: \\)$TEMPLATE_IMAGE\$|\\1$IMAGE|; s|^\\([[:space:]]*image: \\)$TEMPLATE_IMAGE\$|\\1$IMAGE|")"
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
kubectl -n "$NAMESPACE" rollout status deployment/kubernetes-agent-runner --timeout=180s
kubectl -n "$NAMESPACE" rollout status deployment/kubernetes-agent-web --timeout=180s

printf '\nDeployment complete.\n'
printf 'Service: kubernetes-agent-web.%s.svc.cluster.local:3000\n' "$NAMESPACE"
printf 'Local access: kubectl -n %s port-forward svc/kubernetes-agent-web 3000:3000\n' "$NAMESPACE"
