<h1 align="center">KubeMate</h1>

<p align="center"><strong>The AI command center for Kubernetes teams — investigate incidents, understand workloads, and plan safe changes through a team of specialist agents.</strong></p>

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white)](https://nextjs.org)
[![Bun](https://img.shields.io/badge/Bun-1.4.3-f9f1e1?logo=bun&logoColor=14151a)](https://bun.sh)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-native-326CE5?logo=kubernetes&logoColor=white)](https://kubernetes.io)
[![GHCR](https://img.shields.io/badge/container-GHCR-2088FF?logo=github&logoColor=white)](https://github.com/features/packages)
[![Security](https://img.shields.io/badge/security-approval--gated-2ea44f)](#security-by-design)

[Why KubeMate](#why-kubemate) · [Capabilities](#capabilities) · [Architecture](#architecture) · [Quickstart](#quickstart) · [Production](#production-deployment) · [Security](#security-by-design)

<!--<p align="center"><img src="public/logo.svg" alt="KubeMate logo" width="160" /></p>-->

---

## Why KubeMate

Kubernetes gives teams tremendous control — and a tremendous amount of
operational context to assemble under pressure. KubeMate turns that context
into a focused conversation with specialists that understand pods, events,
logs, deployments, services, nodes, rollout health, and Kubernetes manifests.

It is designed for platform teams that want AI assistance without handing a
general-purpose chatbot an unbounded cluster credential.

### The product promise

- **Diagnose from evidence.** Ask one question and let the agent gather the
  relevant Kubernetes state instead of copying output between terminals.
- **Use the right specialist.** Troubleshooting, deployment, manifest design,
  and optimization are separate teammate profiles with distinct operating
  instructions.
- **Keep humans in the loop.** Read-only inspection is the default. Mutating
  actions become explicit proposals that require approval before execution.
- **Deploy inside your boundary.** Kubernetes access stays behind the official
  client library and a dedicated ServiceAccount RBAC boundary.

## Capabilities

| Capability | What it does | Why it matters |
|---|---|---|
| Specialist teammates | Switch between troubleshooting, deployment, manifest, and optimization personas | The answer is shaped by the job, not a generic prompt |
| Group chat | Bring multiple Kubernetes specialists into one conversation | Compare diagnosis, rollout, and security perspectives together |
| Cluster inspection | Inspect pods, logs, events, deployments, services, and nodes | Ground recommendations in live cluster evidence |
| Approval workflow | Convert supported mutations into reviewable proposals | No silent changes from an AI response |
| Provider flexibility | Use OpenRouter, Groq, or NVIDIA model endpoints | Keep model choice aligned with your environment and policy |
| Production packaging | Build to GHCR and deploy with Kubernetes manifests | Move from local validation to a repeatable release path |

## Architecture

```mermaid
flowchart LR
    U[Platform engineer] --> W[KubeMate web app]
    W --> C[Chat and approval API]
    C --> A[LangGraph agent runtime]
    A --> M[Configured model provider]
    A --> K[Private Kubernetes agent runner]
    K --> R[ServiceAccount + RBAC]
    R --> CL[(Kubernetes API)]
    C --> D[(Postgres)]
```

The agent uses `@kubernetes/client-node` and in-cluster ServiceAccount
credentials; application code does not shell out to `kubectl`. The manifest
layer keeps the application, database, RBAC, and schema job explicit so the
deployment boundary is visible and reviewable.

### Runtime components

- **Web application** — Next.js standalone application with chat, teammate
  management, group conversations, persistence, and health checks.
- **Agent runtime** — LangGraph state model with LangChain tools and provider
  adapters.
- **Kubernetes boundary** — RBAC-scoped ServiceAccount and Kubernetes client
  calls for cluster inspection and approved actions.
- **Persistence** — PostgreSQL with Drizzle ORM for teammates, chats, messages,
  and approval records.
- **Release path** — Multi-stage Bun image, GHCR publication, Kustomize base and
  production overlay, plus rollout verification.

## Security by design

KubeMate is built for an internal enterprise deployment model:

- **Read-only by default.** Inspection tools use `get`, `list`, and `watch`
  permissions where possible.
- **Explicit mutation scope.** The writer role is limited to the approved
  Kubernetes actions represented in the application.
- **Approval before execution.** The chat API persists an action proposal and
  executes it only after the user approves it.
- **No `kubectl` in application code.** Cluster access uses the Kubernetes API
  client and ServiceAccount RBAC.
- **Secrets stay outside Git.** AI keys, database credentials, and production
  kubeconfig are injected through local environment files or Kubernetes/GitHub
  secrets.
- **Container hardening.** The application runs as a non-root user with a
  read-only root filesystem, dropped Linux capabilities, resource limits, and
  health probes.

> KubeMate is currently an internal deployment foundation. It does not add
> external authentication, billing, hosted task execution, or multi-tenant
> isolation by default.

## Quickstart

### Prerequisites

- [Bun](https://bun.sh) 1.4 or newer
- PostgreSQL 16 or a compatible PostgreSQL instance
- An API key for OpenRouter, Groq, or NVIDIA

### Run locally

```bash
bun install
bun run db:push
bun run dev
```

Open `http://localhost:3000`.

Configure the database and model provider in `.env.local`:

```dotenv
DATABASE_URL=postgresql://user:password@localhost:5432/kubemate

AI_PROVIDER=openrouter
OPENROUTER__API_KEY=...
OPENROUTER__MODEL=openai/gpt-4o-mini
```

Supported providers are `openrouter`, `groq`, and `nvidia`. Use the matching
`*_API_KEY` and model variable shown in [`lib/model.ts`](lib/model.ts).

### Validate a change

```bash
bun run typecheck
bun run lint
bun run build
```

## Production deployment

KubeMate ships with a repeatable image-to-cluster release path:

1. GitHub Actions verifies the application and builds the Docker image.
2. The image is published to GHCR with an immutable commit SHA tag.
3. The production Kustomize overlay renders the application, PostgreSQL,
   ServiceAccount, RBAC, Service, and schema job.
4. The deploy script creates configuration and secrets, applies the manifests,
   runs the schema push job, and waits for the rollout.

### GitHub Actions

Pushes to `master` publish `ghcr.io/<owner>/<repository>:sha-<short-sha>`.
To enable the optional deployment job, set the repository variable
`KUBEMATE_DEPLOY=true` and configure these secrets in the `production`
environment:

| Secret | Purpose |
|---|---|
| `KUBE_CONFIG` | Kubeconfig for the target cluster |
| `AI_PROVIDER` | `openrouter`, `groq`, or `nvidia` |
| `AI_MODEL` | Provider-specific model name |
| `AI_API_KEY` | Model provider credential |
| `DB_PASSWORD` | PostgreSQL application password |

The workflow is defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

### Manual production deployment

```bash
IMAGE=ghcr.io/OWNER/kubemate:sha-abc123 \
AI_PROVIDER=openrouter \
AI_MODEL=openai/gpt-4o-mini \
AI_API_KEY=... \
DB_PASSWORD=... \
./scripts/deploy.sh
```

The production overlay is [`k8s/production`](k8s/production), built on the
shared [`k8s/base`](k8s/base) resources. The local interactive cluster flow is
available through [`scripts/develop-test.sh`](scripts/develop-test.sh).

## Repository layout

```text
.
├── app/                    Next.js routes, chat API, approval API, health check
├── actions/                Server actions for teammates and group chats
├── components/             Chat UI, teammate UI, and shared primitives
├── db/                     Drizzle schema and database client
├── lib/agent/              LangGraph runtime and Kubernetes tools
├── lib/teammate-profiles.ts Built-in specialist teammate profiles
├── k8s/base/               Shared namespace, Postgres, RBAC, app, and job
├── k8s/production/         Production image overlay
├── scripts/                Local/test and production deployment workflows
├── Dockerfile              Multi-stage Bun/Next.js production image
└── .github/workflows/      CI, GHCR publication, and optional CD
```

## Roadmap

- [ ] Add richer rollout and incident timelines.
- [ ] Expand approval-gated actions with policy-aware guardrails.
- [ ] Add SSO and organization boundaries for broader enterprise adoption.
- [ ] Add audit export and operational analytics.
- [ ] Add platform-specific adapters for managed Kubernetes services.

## License

KubeMate is currently an internal project. Add a license before distributing it
outside your organization.
