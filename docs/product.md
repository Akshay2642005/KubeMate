# Kubernetes Agent Teammates

## Product decision

Build one full stack TypeScript application from the existing `ai-teammates` project.

The application will provide specialized Kubernetes teammates that users can chat with individually or as a group. Each teammate will have its own avatar, role, system instructions, model configuration, workflow, and allowed tools.

The existing Kubernetes diagnosis and remediation workflow from `ai-agent` will be migrated from Python into TypeScript using LangChain and LangGraph. The existing sandbox infrastructure will remain optional and will be added only when the product needs to execute untrusted code.

## Product experience

Users can:

1. Create or select a Kubernetes teammate.
2. Ask the teammate to inspect a cluster or namespace.
3. See streamed reasoning summaries, tool activity, findings, and proposed changes.
4. Approve or reject every write operation.
5. Let a teammate hand the conversation to another specialist.
6. Review the resulting Kubernetes changes and verification results.

The initial built in teammates are:

| Teammate | Primary responsibility |
| --- | --- |
| Troubleshooter | Investigate failing workloads, logs, events, scheduling, and runtime errors |
| Deployment Engineer | Inspect and safely change Deployments, images, rollouts, and replicas |
| Manifest Engineer | Generate, validate, compare, and explain Kubernetes manifests |
| Optimization Advisor | Review requests, limits, HPA, utilization, and scheduling efficiency |
| Security Advisor | Review RBAC, service accounts, network policies, and workload exposure |

## Application architecture

```text
Browser
  |
  v
Next.js web and API deployment
  |  Internal workspace, Drizzle, chat UI, teammate management
  |  dispatches durable runs
  v
Internal agent runner deployment
  |  LangChain, LangGraph, Kubernetes client
  |  mounted ServiceAccount token
  v
Kubernetes API server
```

The web deployment should not have write access to the Kubernetes API. The internal agent runner is the only component that receives the Kubernetes ServiceAccount identity. The application is trusted internal software and does not use an external authentication provider.

The runner should be a private internal worker service deployed inside the cluster. It must run in the same cluster as the target API unless a separate, explicitly configured cluster credential is introduced.

## Kubernetes API access

The agent must not shell out to `kubectl`.

Use the server side TypeScript package `@kubernetes/client-node`. It supports the Kubernetes client API and in cluster configuration. The runner will call `KubeConfig.loadFromCluster()` and create typed API clients such as `CoreV1Api`, `AppsV1Api`, `BatchV1Api`, and `CustomObjectsApi`.

When running locally, the same adapter may use `loadFromDefault()` and the developer's kubeconfig. The application code should not need to know which environment it is running in.

Kubernetes documents official client libraries as the preferred way to access the API from a Pod. ServiceAccount credentials are mounted into the Pod and used for authentication. See the Kubernetes guidance on [accessing the API from a Pod](https://kubernetes.io/docs/tasks/run-application/access-api-from-pod/) and [ServiceAccounts](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/).

The JavaScript client is implemented for server side Node.js and is installed as `@kubernetes/client-node`. See the [official JavaScript client](https://github.com/kubernetes-client/javascript).

## Kubernetes MCP decision

Kubernetes MCP is not the primary tool implementation for the first release.

The direct client library is preferred because it gives the application:

- typed request and response objects
- explicit tool allowlists
- predictable error handling
- direct access to the in cluster ServiceAccount identity
- simpler testing
- no extra MCP server deployment

MCP can be added later as an adapter for external clusters, third party tools, or a standard tool marketplace. An MCP server would still need to run with Kubernetes credentials, so MCP does not remove the need for RBAC or approval controls.

## Teammate data model

The existing `bots` table from `ai-teammates` should evolve into a teammate profile with these fields:

- `id`
- `userId`
- `name`
- `slug`
- `avatar`
- `specialization`
- `systemPrompt`
- `workflowType`
- `modelProvider`
- `modelName`
- `toolPolicy`
- `approvalPolicy`
- `clusterScope`
- `namespaceScope`
- `createdAt`

Chat membership remains separate from teammate identity. A group chat can contain several specialists, and handoff remains an explicit graph or tool operation.

## Agent workflow

The Python workflow in `source/ai-agent/agent-backend/app/agent` should be ported as one reusable LangGraph factory:

```text
classify request
  -> diagnose
  -> select issues when needed
  -> propose remediation
  -> interrupt for approval
  -> apply remediation
  -> verify remediation
  -> retry, request guidance, or finish
```

The graph should use a stable chat or run identifier as its `thread_id`. LangGraph checkpoint persistence will allow approval, retry, and guidance actions to resume the same workflow.

The graph should remain shared across teammates. Teammates customize the system prompt, model, tool registry, and policy rather than receiving separate copied graph implementations.

LangGraph's JavaScript model supports graph nodes, checkpointing, retry policies, and `interrupt()` for human input. See the [LangGraph JavaScript workflow guidance](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph).

## Kubernetes tools

Port the existing tools from `source/ai-agent/agent-backend/app/tools` into typed TypeScript modules:

```text
agent/tools/kubernetes/read
agent/tools/kubernetes/write
agent/tools/kubernetes/guards
agent/tools/kubernetes/registry.ts
```

Read tools include pods, logs, events, deployments, services, nodes, resource usage, jobs, autoscaling, and generic resource inspection.

Write tools include only explicitly supported operations such as image updates, rollout restarts, safe scaling, controlled patches, and validated manifest application.

Every write tool must:

- validate its input with Zod
- check resource ownership and namespace scope
- reject system and agent resources unless explicitly allowed
- refuse destructive operations that cannot be verified as safe
- create an audit record
- pause for approval before execution
- return structured results suitable for the chat UI

## ServiceAccount and RBAC

The current `source/ai-agent/k8s/manifests` files provide the correct basic pattern: a dedicated ServiceAccount is assigned to the backend Deployment.

The current `ClusterRole` must not be copied unchanged. Its wildcard rule grants `create`, `update`, `patch`, and `delete` across all API groups and resources. That includes privileges that the application should never receive, including RBAC and ServiceAccount mutation.

The consolidated deployment should use:

1. A dedicated `kubernetes-agent-runner` ServiceAccount.
2. Cluster wide read permissions only where diagnosis requires them.
3. Namespaced write permissions for the supported workload resources.
4. No write permission for Roles, RoleBindings, ClusterRoles, ClusterRoleBindings, ServiceAccounts, or the agent's own namespace.
5. No Secret read permission by default.
6. Separate policy checks in application code because RBAC cannot express every safety rule.
7. Human approval before every write operation.

The exact RBAC should be derived from the final tool registry and tested with `kubectl auth can-i` during deployment verification. The runner should be able to read the API but should not expose its internal Kubernetes endpoint publicly.

## Network and deployment layout

The Kubernetes deployment should contain:

- `web` Deployment and ClusterIP Service
- `agent-runner` Deployment with the ServiceAccount
- PostgreSQL, or a managed PostgreSQL connection
- optional private agent runner resources
- NetworkPolicies
- externally managed Secrets
- optional Ingress for the web service only

The runner needs network access to:

- the Kubernetes API on port 443
- PostgreSQL
- the selected model provider
- DNS

The web service needs network access to PostgreSQL and the private runner service. The browser should never call the runner directly.

## Model providers

Use a provider adapter so graph code depends on a LangChain chat model, not on a provider SDK.

Supported providers:

- OpenRouter
- Groq and Grok compatible endpoints
- NVIDIA hosted endpoints
- Azure OpenAI

OpenRouter is the recommended first provider because its API is OpenAI compatible and lets the application change models without changing the graph implementation. Provider keys and model names must be server side environment configuration.

## Sandbox decision

The `agent-sandbox` project is deferred.

The gVisor based sandbox is appropriate for running untrusted shell commands, manifest validation, Helm rendering, or user supplied code. It is not required for the first version because Kubernetes API calls can be made directly through the typed client and restricted by ServiceAccount RBAC and application policy.

The deferred sandbox work in `agent-sandbox` is separate from the Kubernetes API runner. It should remain behind an execution interface and should not be introduced into the first internal release.

## Security findings to resolve before deployment

The current `source/ai-agent/k8s/kustomization.yaml` contains literal database and model credentials. These credentials should be considered exposed and rotated. Production deployment should use an external Secret manager or a deployment time Secret mechanism.

The application has no external authentication by design. The web and runner services must remain private to the internal cluster network, and the runner must validate ownership of every chat and run using the internal workspace key.

The current ingress example exposes the backend path separately. The consolidated deployment should expose only the web service and keep the runner Service private.

## Delivery plan

### Milestone 1: application foundation

- make `ai-teammates` the primary Next.js application
- preserve the internal workspace, Drizzle, and chat UI
- add the teammate profile model
- add provider configuration and server side environment validation

### Milestone 2: in cluster runner

- create the internal agent runner
- add `@kubernetes/client-node`
- implement local kubeconfig and in cluster configuration
- add health and readiness checks
- create the dedicated ServiceAccount and restricted RBAC

### Milestone 3: first end to end teammate

- port read tools
- port diagnosis and verification
- port one safe write operation
- add approval and retry interrupts
- stream graph events into the chat UI

### Milestone 4: teammate catalog

- add deployment, manifest, optimization, and security teammates
- add handoff routing
- add tool policy editing
- add model selection per teammate

### Milestone 5: sandbox and external integrations

- add gVisor sandbox execution only for untrusted code paths
- optionally add Kubernetes MCP as an external tool adapter
- add multi cluster connections and explicit cluster credentials

## First usable release

The first release should support one complete path:

> A Kubernetes Troubleshooter inspects a failing workload, explains the evidence, proposes a safe remediation, waits for approval, applies the change through the Kubernetes client library, and verifies the result.

This path should be tested in a real Kubernetes namespace before adding the remaining teammates or sandbox execution.
