# KubeMate

![KubeMate avatar](https://api.dicebear.com/10.x/gaze/svg?seed=KubeMate&backgroundColor=0d1117)

KubeMate is an internal Kubernetes teammate workspace for building and chatting
with specialist AI agents.

The current template provides the teammate and group chat UI, Drizzle persistence, DiceBear avatars, and a local AI SDK chat route. It is intentionally an internal application: there is no external authentication, billing, payment flow, cloud desktop, or hosted task runner.

## Development

Install Bun 1.4 or newer, then run:

```bash
bun install
bun run db:push
bun run dev
```

The application needs `DATABASE_URL` and the configured model provider environment variables. The database currently uses one internal workspace owner key.

The default model provider is OpenRouter. Set `AI_PROVIDER=openrouter`,
`AI_PROVIDER=groq`, or `AI_PROVIDER=nvidia`; the corresponding API key and
model variables are:

```text
AI_PROVIDER=openrouter
OPENROUTER__API_KEY=...
OPENROUTER__MODEL=openai/gpt-4o-mini
AI_PROVIDER=groq
GROQ__API_KEY=...
GROQ__MODEL=...
NVIDIA__API_KEY=...
NVIDIA__CHAT_MODEL=...
```

The provider keys must stay in `.env.local` or Kubernetes Secrets and must never be committed.

Useful checks:

```bash
bun run typecheck
bun run lint
bun run build
```

## Kubernetes deployment

### Local/test cluster

The deployment wizard builds the image, asks for the OpenRouter, Groq, or NVIDIA provider
and API key, creates the Kubernetes Secret and ConfigMap, provisions Postgres,
runs the Drizzle schema job, and waits for the application rollout:

```bash
./scripts/deploy-test.sh
```

The script uses the current `kubectl` context. For a remote registry, provide
an image and opt into pushing it:

```bash
IMAGE=registry.example.com/kubernetes-agent:test PUSH_IMAGE=yes LOAD_IMAGE=no ./scripts/deploy-test.sh
```

After deployment, expose the internal Service locally:

```bash
kubectl -n kubernetes-agent port-forward svc/kubernetes-agent 3000:3000
```

### Production with GHCR

The GitHub Actions workflow verifies pull requests, publishes immutable images
to GHCR on pushes to `master`, and can deploy to Kubernetes when the repository
variable `KUBEMATE_DEPLOY` is `true`. Configure these production environment
secrets: `KUBE_CONFIG`, `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`, and
`DB_PASSWORD`.

To deploy the same production manifests manually, authenticate Docker/Kubernetes
and provide the image and secrets through the environment:

```bash
IMAGE=ghcr.io/OWNER/kubemate:sha-abc123 \
AI_PROVIDER=openrouter \
AI_MODEL=openai/gpt-4o-mini \
AI_API_KEY=... \
DB_PASSWORD=... \
./scripts/deploy-production.sh
```

The production overlay is in `k8s/production/`. It reuses the base manifests,
and the deploy script replaces the `ghcr.io/OWNER/kubemate:latest` placeholder
with the immutable image selected for the release.

## Project direction

The agent runtime now has a LangGraph state model, LangChain provider adapter, and read-only Kubernetes tools. Kubernetes access uses `@kubernetes/client-node` from a private in-cluster runner with a dedicated ServiceAccount. The web application remains the UI and internal API boundary.

The existing projects under `source/` are retained as references while the root application is developed.
