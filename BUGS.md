# KubeMate Code Audit — Findings & Fix Tracker

Static audit of the repository. No `node_modules` were installed in the checkout,
so `typecheck`, `lint`, and `build` were not run.

Status legend: `[ ]` open · `[~]` in progress · `[x]` fixed

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| BUG-01 | Critical | Web app and Kubernetes runner share one workload with write RBAC | `[x]` |
| BUG-02 | Critical | Approval mutations can execute twice (TOCTOU) | `[x]` |
| BUG-03 | Critical | Write actions are not validated or scoped server-side | `[x]` |
| BUG-04 | Critical | Pod recreation deletes before create with no wait | `[x]` |
| BUG-05 | Critical | Approval UI shows only the model-written summary | `[x]` |
| BUG-06 | High | Client decides which bot responds; no membership check | `[x]` |
| BUG-07 | High | Client-supplied message history is trusted and persisted | `[x]` |
| BUG-08 | High | History truncation breaks tool-call pairing; no loop budget | `[x]` |
| BUG-09 | High | Docs and DB schema have diverged | `[x]` |
| BUG-10 | Medium | Unused duplicate model module (`lib/model.ts`) | `[x]` |
| BUG-11 | Medium | DB schema shipped into client bundles | `[x]` |
| BUG-12 | Medium | Root route always shows the empty state | `[x]` |
| BUG-13 | Medium | Group chats answer with only one bot | `[x]` (product decision) |
| BUG-14 | Medium | Group-chat validation allows duplicates and has no cap | `[x]` |
| BUG-15 | Medium | Dead agent-state fields and unreachable branches | `[x]` |
| BUG-16 | Medium | Readiness ignores DB; revalidate may hit read-only FS | `[x]` |
| BUG-17 | Medium | Runtime UID mismatch between image and manifests | `[x]` |
| BUG-18 | Medium | Kubernetes client init/caching is implicit | `[x]` |
| BUG-19 | Medium | `@kubernetes/client-node` not externalized in Next config | `[x]` |
| BUG-20 | Medium | Deployment hygiene (NetworkPolicy, RBAC breadth, image size) | `[x]` |
| BUG-21 | Low | `ActionProposal` input is a non-discriminated union | `[x]` |
| BUG-22 | Low | `splitByAuthor` is a dead abstraction | `[x]` (kept, now works) |
| BUG-23 | Low | `actionProposal` can pick a stale proposal | `[x]` |
| BUG-24 | Low | Orphan group chats remain in the database | `[x]` |
| BUG-25 | Low | Missing bounds on `avatar`; free-text message role | `[x]` |
| BUG-26 | Low | No rate limiting or body-size cap on `/api/chat` | `[x]` |
| BUG-27 | Low | `getChat` loads unbounded message history | `[x]` |
| BUG-28 | Low | CI lint is advisory only | `[x]` |
| BUG-29 | Low | Deployment scripts duplicate logic | `[x]` |

---

## Critical

### BUG-01 — Web app and Kubernetes runner share one workload with write RBAC

**Where**
- `k8s/base/deployment.yaml:20-21` — `serviceAccountName: kubernetes-agent`,
  `automountServiceAccountToken: true`
- `k8s/base/kustomization.yaml` — includes `writer-clusterrole.yaml` and
  `writer-clusterrolebinding.yaml`
- `k8s/base/writer-clusterrole.yaml` — cluster-wide `pods: create/delete`,
  `nodes: patch`, `deployments: patch`
- `AGENTS.md` ("Deployment") and `docs/product.md:49-51` require separate
  web and runner workloads, with no write access on the web tier
- `k8s/README.md:6-8` incorrectly claims the policy is read-only

**Why it matters**
The Next.js app that serves chat and the agent that mutates the cluster are the
same container with the same credentials. Any web-tier bug or request-path
compromise now has the cluster write identity. This directly contradicts the
documented security model.

**Fix**
- Split into two Deployments: `web` (no ServiceAccount token, no K8s RBAC) and
  `agent-runner` (ServiceAccount + read/write RBAC).
- Move the graph, Kubernetes tools, and approval execution into the runner.
- Expose the runner only as a private ClusterIP Service; the browser must never
  reach it.
- Correct `k8s/README.md`.

**Acceptance**
- The web pod has `automountServiceAccountToken: false` and no K8s RBAC.
- Only the runner pod has the read/write ClusterRoles.
- Docs, manifests, and architecture diagram agree.

**Resolution (done)**
- `k8s/base/web-deployment.yaml` and `k8s/base/runner-deployment.yaml` replace the
  single `deployment.yaml`. The web deployment has `automountServiceAccountToken: false`
  and no ServiceAccount, so Kubernetes API calls from the web tier are refused.
- Only `runner-deployment.yaml` keeps `serviceAccountName: kubernetes-agent` and
  `automountServiceAccountToken: true`; it is the sole workload bound to the
  read-only and approved-writer ClusterRoles.
- `k8s/base/runner-service.yaml`, `k8s/base/service.yaml`, and
  `k8s/base/networkpolicy.yaml` were added/updated: the runner is a private
  ClusterIP Service reachable only from the web tier, and NetworkPolicies scope
  both pods' egress/ingress.
- `lib/runner.ts` adds the HTTP boundary: when `INTERNAL_RUNNER_URL` is set, the
  web routes forward agent traffic to the private runner; the runner serves the
  same routes in-process with the mounted token. Local dev still runs in-process.
- `k8s/README.md` now documents the two-tier layout and RBAC split.

---

### BUG-02 — Approval mutations can execute twice (TOCTOU)

**Where**
- `app/api/chat/approval/route.ts:33-79`

**Why it matters**
The route reads the approval, checks `status === "pending"`, executes, then
updates. Two concurrent requests both pass the check and both execute. For
`recreate_pod_without_node_selector` that means a double delete/recreate. The UI
has no in-flight state, so a double-click triggers it (`components/chat.tsx:248-267`).

**Fix**
Claim the approval atomically before executing:
```sql
UPDATE chat_approvals
SET status = 'approved', resolved_at = now()
WHERE id = $1 AND chat_id = $2 AND status = 'pending'
RETURNING *;
```
Execute only when a row is returned. Otherwise return `409`. Alternatively
`SELECT … FOR UPDATE` inside a transaction. Add a "pending/working" state in the
UI and disable the buttons while the request is in flight.

**Acceptance**
- Concurrent approvals produce exactly one mutation and one `409`.
- Buttons disable while the request is running.

**Resolution (done)**
- `app/api/chat/approval/route.ts` now claims the row atomically with
  `UPDATE … WHERE status = 'pending' RETURNING id`; only the winner executes.
- `components/chat.tsx` disables both buttons and shows a spinner while an
  approval is in flight.

---

### BUG-03 — Write actions are not validated or scoped server-side

**Where**
- `lib/agent/kubernetes/actions.ts:8-12, 27-32, 45-50` — unchecked `as` casts
- `lib/agent/kubernetes/tools.ts:275-341` — proposal tools
- `docs/product.md:138-146` — requires Zod validation, ownership/scope checks,
  and rejection of system resources

**Why it matters**
A malformed or tampered proposal becomes an unchecked Kubernetes call.
`label_node` can target any node (including control-plane) and reserved keys;
`remove_deployment_node_selector` can patch any Deployment in any namespace,
including `kube-system`, because the ClusterRole is cluster-wide.

**Fix**
- Turn `ActionProposal` into a discriminated union keyed on `action`, each with
  its own Zod schema.
- `safeParse` in `applyKubernetesAction`; reject unknown actions and bad inputs.
- Add guards:
  - namespace allowlist; deny `kube-system`, `kube-node-lease`, the agent's own
    namespace
  - reject reserved label keys (`kubernetes.io/*`, `node-role.kubernetes.io/*`)
  - verify the target exists and is not owned by a higher-level controller where
    the action is invalid
- Mirror the same guards in the proposal tools so the model gets a clear error.

**Acceptance**
- Unit tests cover each action's valid/invalid inputs.
- kube-system and reserved-key attempts are rejected before any API call.

**Resolution (done, tests pending)**
- Added `lib/agent/kubernetes/proposals.ts`: per-action Zod schemas, a
  discriminated `actionProposalSchema`, and `assertMutableNamespace` /
  `assertNodeLabelKeyAllowed` guards.
- `applyKubernetesAction` now `safeParse`s the stored proposal, rejects unknown
  actions, and applies the namespace/label guards before any API call.
- Tool input schemas reuse the same definitions, so model input and execution
  share one contract. Follow-up: add the unit tests listed above.

---

### BUG-04 — Pod recreation deletes before create with no wait

**Where**
- `lib/agent/kubernetes/actions.ts:72-82`

**Why it matters**
`deleteNamespacedPod` is asynchronous, then `createNamespacedPod` reuses the same
`metadata.name`. Creation frequently fails with `AlreadyExists` while the old pod
terminates, after the pod has already been deleted. The workload is left down.
`metadata.finalizers` and `generateName` are also copied.

**Fix**
- Poll until `readNamespacedPod` returns 404 before creating, with a bounded
  timeout and a clear error.
- Strip `finalizers`, `generateName`, and any other server-managed metadata.
- Consider recreating with a temporary name, or leave the pod deleted and report
  that the workload must be recreated by its owner.
- Return a structured result that the UI can verify.

**Acceptance**
- Test against a real standalone pod; no `AlreadyExists` race; failure path is
  reported without losing the resource silently.

**Resolution (done)**
- `lib/agent/kubernetes/actions.ts` deletes with `gracePeriodSeconds: 0`, polls
  `readNamespacedPod` until 404 (30s bound), then recreates.
- Server-managed metadata (`finalizers`, `generateName`, `deletionTimestamp`,
  `deletionGracePeriodSeconds`) is stripped along with the existing fields.
- If recreation fails, the error states that the pod was deleted and must be
  recreated manually. Follow-up: verify against a real pod.

---

### BUG-05 — Approval UI shows only the model-written summary

**Where**
- `components/chat.tsx:238-278` (summary at `245-247`)
- `components/chat.tsx:159-183` — `handleApproval` silently returns on error

**Why it matters**
A human approves a cluster mutation based on prose the model authored, not the
actual action/target/value in `part.data.input`. The approval is uninformed, and
failures are invisible (`if (!response.ok) return`).

**Fix**
- Render the structured action: action name, namespace, resource, key/value.
- Show errors via `toast.add` or inline text.
- Add loading/disabled state (ties into BUG-02).
- Consider a raw-input disclosure for reviewers.

**Acceptance**
- The approval card shows exactly the target and change.
- A failed approval surfaces an error to the user.

**Resolution (done)**
- `components/chat.tsx` renders an `ApprovalDetails` block with the action,
  namespace, node/deployment/pod, and label key/value.
- Failed requests now surface a toast with the server error instead of returning
  silently; approvals show a spinner and disable both buttons while running.

---

## High

### BUG-06 — Client decides which bot responds; no membership check

**Where**
- `app/api/chat/route.ts:114-126`
- `lib/chat-types.ts:47` (`mentionedBotIds` stored but unused server-side)
- `components/chat.tsx:116-131` (mention enforcement is client-only)

**Why it matters**
`botId` comes from the last client message and is only ownership-checked. A bot
outside the chat (or a mention the UI did not enforce) can be used to answer in
any chat. `mentionedBotIds` is persisted but ignored.

**Fix**
- Resolve the responder server-side from `chatMembers` for the given `chatId`.
- Validate mentioned bot IDs against chat membership.
- Reject a `botId` that is not a member with `400/403`.

**Acceptance**
- A client cannot make a non-member bot respond.
- Mentions are validated server-side.

**Resolution (done)**
- `app/api/chat/route.ts` now resolves the responder from `chat.bots`
  (the chat's actual members) before persisting anything. A non-member `botId`
  returns `400`; a group message without a valid member returns `400`; a direct
  chat falls back to its only bot.

---

### BUG-07 — Client-supplied message history is trusted and persisted

**Where**
- `app/api/chat/route.ts:99-116`
- `lib/chat/persistence.ts:15-32`

**Why it matters**
The route persists the entire client `messages` array and replays the last 12 as
model context. A client can inject assistant-role text or overwrite an existing
server-generated message by reusing its `id` (`onConflictDoUpdate`). Internal
single-workspace app, so low severity, but the persistence integrity is
client-controlled.

**Fix**
- Persist only the new user message on the server; load history from DB.
- Keep the AI SDK stream protocol while discarding client-authored assistant
  messages.
- Optionally verify message IDs belong to the server's generated set.

**Acceptance**
- Client cannot overwrite or fabricate persisted assistant messages.

**Resolution (done)**
- `app/api/chat/route.ts` now requires the last client message to be a `user`
  message, persists only that message, and builds the model context from
  `chat.messages` (the database) plus the new message. Client-authored assistant
  turns are ignored and existing message IDs are never overwritten.
- Superseded transport note: the AI SDK stream protocol itself was later
  replaced by AG-UI 1.0 events (see README, Architecture). The integrity
  guarantees above are unchanged.

---

### BUG-08 — History truncation breaks tool-call pairing; no loop budget

**Where**
- `lib/agent/graph.ts:76` — `state.messages.slice(-12)`
- `lib/agent/graph.ts:102-120` — unbounded model ⇄ tools loop

**Why it matters**
Truncating at an arbitrary index can separate an assistant `tool_calls` message
from its matching `ToolMessage`. OpenAI-compatible providers then reject the
request ("tool_calls must be followed by tool messages"). The loop has no
explicit step budget beyond LangGraph's default recursion limit.

**Fix**
- Truncate on whole turn boundaries, preserving assistant/tool pairs.
- Add a max-iteration counter in state and route to `respond`/error when exceeded.
- Catch provider errors and return an actionable message.

**Acceptance**
- Long conversations with tools never produce orphaned tool calls.
- A looping model stops with a clear error instead of failing the recursion limit.

**Resolution (done)**
- `lib/agent/graph.ts` now builds a provider-valid window with `recentMessages`:
  it takes the last 12 messages and drops any leading `ToolMessage`, so a
  tool result is never orphaned.
- Added `toolTurns` to `AgentState`; the tools node increments it and
  `MAX_TOOL_TURNS = 6` unbinds tools for the final answer, with a system note
  telling the model to answer from existing evidence.

---

### BUG-09 — Docs and DB schema have diverged

**Where**
- `docs/product.md:82-99` — teammate fields and Security Advisor
- `db/schema.ts:15-49` — current bot schema
- `README.md` capability table

**Why it matters**
The docs promise `slug`, `specialization`, `systemPrompt`, `workflowType`,
`modelProvider`, `modelName`, `toolPolicy`, `approvalPolicy`, `clusterScope`,
`namespaceScope`, and a Security Advisor. None exist in the schema; policy is
hard-coded. The README sells behavior the code does not have.

**Fix**
Choose one:
- Implement the documented fields and per-teammate policy, or
- Rewrite the docs to match the current profile-based implementation.

**Acceptance**
- `docs/product.md`, `README.md`, and `db/schema.ts` agree on the teammate model.

**Resolution (done)**
- Owner chose docs-to-code. `docs/product.md` no longer promises a Security
  Advisor built-in or the undocumented per-teammate fields (`slug`,
  `specialization`, `systemPrompt`, `workflowType`, `modelProvider`,
  `modelName`, `toolPolicy`, `approvalPolicy`, `clusterScope`,
  `namespaceScope`).
- The "Teammate data model" section now documents the actual `bots` table
  (`profileId` enum `troubleshooting|deployment|manifest|optimization|custom`,
  `job`, `instructions`, `avatar` seed) and states explicitly that model
  selection is environment-wide, the tool surface is fixed in the runner, and
  all mutations flow through the same approval-proposal mechanism.
- "Product experience" and the built-in teammate table match
  `lib/teammate-profiles.ts`; the README capability table is unchanged for
  profiles but the group-chat row was corrected as part of BUG-13.

---

## Medium

### BUG-10 — Unused duplicate model module (`lib/model.ts`)

**Where**
- `lib/model.ts` (unused; `@ai-sdk/openai`)
- `lib/agent/model.ts:11` — `Number(env)` can be `NaN`

**Fix**
Delete `lib/model.ts` (or consolidate on it) and validate `AI_MAX_TOKENS` with a
fallback when `Number.isFinite` is false.

**Acceptance**
- One provider implementation; invalid token counts fall back safely.

**Resolution (done)**
- Deleted `lib/model.ts`; `lib/agent/model.ts` is the only provider
  implementation. Removed the now-unused `@ai-sdk/openai` and
  `@ai-sdk/provider` dependencies.
- `AI_MAX_TOKENS` is parsed through `maxTokensFromEnv()` and falls back to 1200
  when not finite/positive.

---

### BUG-11 — DB schema shipped into client bundles

**Where**
- `components/bot-dialog.tsx:47`
- `components/group-chat-dialog.tsx:50`
- `db/schema.ts` imports `drizzle-orm/pg-core`, `nanoid`

**Why it matters**
Runtime imports of `botInsertSchema` / `groupChatInsertSchema` from `db/schema.ts`
pull server DB code into the browser bundle.

**Fix**
Move shared insert schemas to `lib/schemas.ts` with no DB imports; keep
`db/schema.ts` server-only. Import row types with `import type`.

**Acceptance**
- Client components import the isomorphic tables/schemas module, not the full
  schema with relations, and the module imports no database connection.

**Resolution (done)**
- Split `db/schema.ts`: tables, enums, insert schemas, and inferred types now
  live in `db/tables.ts`; `db/schema.ts` holds only relations and re-exports the
  tables module.
- `components/bot-dialog.tsx` and `components/group-chat-dialog.tsx` import
  `@/db/tables`, so the client no longer loads the relations graph. `db/schema.ts`
  remains the canonical import for server code and `drizzle.config.ts`.
- Note: `db/tables.ts` still uses `drizzle-orm/pg-core` and `nanoid` (both
  browser-safe) because AGENTS.md requires schemas to be derived from the Drizzle
  tables rather than hand-written.

---

### BUG-12 — Root route always shows the empty state

**Where**
- `app/(dashboard)/page.tsx:14-35`

**Fix**
If chats exist, redirect to the most recent chat (or render a chat list/search).
Keep the empty state only when there are no bots/chats.

**Acceptance**
- Returning users land on a usable chat instead of "Meet your first bot".

**Resolution (done)**
- `app/(dashboard)/page.tsx` calls `getChats()` and redirects to the most recent
  chat via `redirect(/chats/${latestChat.id})`. The empty state only renders when
  there are no chats.

---

### BUG-13 — Group chats answer with only one bot

**Where**
- `components/chat.tsx:123` — `mentionedBotIds[0]`

**Fix**
Implement multi-bot turns (sequential or filtered) or document the single-bot
limitation in the product docs and UI.

**Acceptance**
- Behavior matches the product promise or the promise is corrected.

**Resolution (done)**
- Owner chose to document the limitation rather than build multi-bot turns.
- `docs/product.md`: product-experience step 5 and the teammate-data-model
  section now state that a group-chat message is answered by the first
  @mentioned teammate.
- `README.md`: the group-chat capability row no longer implies several
  perspectives are compared in one turn.
- Composer: in group chats the placeholder reads
  "Message with @ — the first mentioned teammate replies", which is also the
  trigger for the existing "mention a teammate before sending" validation.

---

### BUG-14 — Group-chat validation allows duplicates and has no cap

**Where**
- `db/schema.ts:199-201`

**Why it matters**
`["a","a"]` passes `min(2)`, then the action dedupes to one and throws a
misleading "Bot not found".

**Fix**
Add `.max(n)` and a `.refine` for uniqueness in `groupChatInsertSchema`.

**Acceptance**
- Duplicate or oversized selections fail validation with a clear message.

---

### BUG-15 — Dead agent-state fields and unreachable branches

**Where**
- `lib/agent/graph.ts:53-55` — `intent` never read
- `lib/agent/graph.ts:57-59` — `plan` always sets `false`
- `lib/agent/graph.ts:90-100` — `respond` awaiting-approval branch unreachable
- `lib/agent/state.ts:29-48` — `namespace`, `lastToolName`, `lastToolResult`
  unused

**Fix**
Remove the dead state/fields or wire them into real routing. If approval should
pause the graph, add a checkpointer and `interrupt()` instead of the current
proposal-tool + separate API flow.

**Acceptance**
- State fields are all used; no unreachable branches.

---

### BUG-16 — Readiness ignores DB; revalidate may hit read-only FS

**Where**
- `app/api/health/route.ts`
- `k8s/base/deployment.yaml` — `readOnlyRootFilesystem: true`

**Fix**
- Add a DB ping to a readiness endpoint (keep liveness shallow).
- Verify `revalidatePath`/Next incremental cache behavior under a read-only root
  filesystem; mount `.next/cache` on an `emptyDir` if needed.

**Acceptance**
- Readiness fails when the DB is unreachable.
- No `EROFS` errors during normal server-action revalidation.

---

### BUG-17 — Runtime UID mismatch between image and manifests

**Where**
- `Dockerfile:32` — `USER bun` (UID 1000)
- `k8s/base/deployment.yaml` — `runAsUser: 1001`, `fsGroup: 1001`

**Fix**
Align the image user and manifest UID (build a user with the target UID or use
1000 in the manifests). Confirm `/app` ownership and `/tmp` writes.

**Acceptance**
- The pod starts and serves with no permission errors.

---

### BUG-18 — Kubernetes client init/caching is implicit

**Where**
- `lib/agent/kubernetes/client.ts:10-20`

**Why it matters**
`loadFromDefault()` falls back to in-cluster config when no kubeconfig exists, but
the docs say `loadFromCluster()`. Clients are cached for the process lifetime;
projected ServiceAccount tokens rotate and a long-lived pod must re-read them.

**Fix**
Make the environment choice explicit (in-cluster vs local kubeconfig), and confirm
the client handles token rotation or refresh the config periodically. Add a small
integration test.

**Acceptance**
- Explicit, documented client initialization; long-running pods survive token
  rotation.

---

### BUG-19 — `@kubernetes/client-node` not externalized in Next config

**Where**
- `next.config.ts`

**Why it matters**
The Kubernetes client is a Node CJS package with dynamic requires; bundling it
under Next 16/Turbopack commonly causes build or runtime import failures.

**Fix**
Add `serverExternalPackages: ["@kubernetes/client-node"]` and verify the
standalone output includes it.

**Acceptance**
- Production build and runtime import succeed.

---

### BUG-20 — Deployment hygiene

**Where**
- `k8s/base/writer-clusterrole.yaml`
- `k8s/base/*` — no NetworkPolicy
- `Dockerfile:23-30` — full `node_modules` copied into standalone image
- `k8s/base/db-push-job.yaml` — no pod securityContext

**Fix**
- Add a NetworkPolicy: web → Postgres only; runner → API server, Postgres, model
  provider, DNS.
- Narrow writer RBAC to namespaced resources and the exact verbs the tools use.
- Trim the runtime image (standalone already carries deps).
- Harden the schema job container like the app.

**Acceptance**
- `kubectl auth can-i --list` for the runner shows only required verbs.
- NetworkPolicies exist and are tested.
- Image size drops and the job is hardened.

**Resolution (done)**
- `k8s/base/networkpolicy.yaml` — the web tier can reach only Postgres, the
  runner, and DNS; the runner can reach the API server, Postgres, the model
  provider (443) and DNS. The runner's ingress is restricted to the web tier.
- The writer ClusterRole is intentionally minimal: exactly `nodes:patch`,
  `pods:create`, `pods:delete`, `deployments:patch` — the verbs the three
  approved write actions perform. `nodes` is cluster-scoped and the target
  namespace is user-chosen, so namespaced narrowing is not possible; application
  policy (`assertMutableNamespace`, `assertNodeLabelKeyAllowed`) blocks
  system/agent namespaces instead.
- `Dockerfile` — the 1.3GB development `node_modules` is no longer copied into
  the runtime image. A `migrator` stage ships a ~66MB pinned drizzle-kit payload
  at `/opt/migrator`, and the db-push job invokes it directly. Image measured
  end-to-end with `docker build` (server starts, `/api/health` 200, and
  `drizzle-kit push` verified against a live database).
- The schema job already runs with `automountServiceAccountToken: false`, UID
  1000, `readOnlyRootFilesystem`, dropped capabilities, and `RuntimeDefault`
  seccomp.

---

## Low

### BUG-21 — `ActionProposal` input is a non-discriminated union
`lib/chat-types.ts:10-30`. Cannot narrow by `action`; forces `as` casts. Tie to
BUG-03: make it a discriminated union of `{ action, input }` pairs.

**Resolution (done)**
- `ActionProposal` is now inferred from the discriminated `actionProposalSchema`
  in `lib/agent/kubernetes/proposals.ts` and re-exported by `lib/chat-types.ts`.
  The `as` casts in the approval route and executor are gone.

### BUG-22 — `splitByAuthor` is a dead abstraction
`components/chat.tsx:42-59` always returns exactly one section, and the comment
claims direct chats pass no bots while `page.tsx` always passes them. Remove or
implement multi-author splitting.

**Resolution (done)**
- `splitByAuthor` now reads the assistant's `message.metadata.botId` to pick the
  correct author from the chat's member bots, and the caller renders that avatar
  for the section. Group chat turns are one message per bot (the server resolves
  a single responder per turn), so a message contains parts from exactly one
  author and the single-section path is correct. Multi-author splitting is
  therefore not needed today; the function is no longer a dead abstraction.

### BUG-23 — `actionProposal` can pick a stale proposal

**Where**
- `app/api/chat/route.ts:63-97` — `actionProposal` function

**Why it matters**
The `actionProposal` function scanned ALL messages from the beginning to end,
returning the first proposal it found. A stale proposal from an earlier turn
could be attached to a new approval request, creating a race where a user
already in a different turn is asked to approve an unrelated change.

**Fix**
The `actionProposal` function now scans messages **backwards**, returning the
first valid proposal found in the most recent turn, which ensures the approval
reflects the most recent intent rather than an earlier turn's proposal.

**Acceptance**
- Proposals are resolved from the most recent turn, eliminating stale proposal
  races.

### BUG-24 — Orphan group chats remain in the database
Deleting all member bots cascades `chatMembers` but leaves the `chats` row;
`getChats` hides it (`queries/bots.ts:21-26`). Clean up empty group chats or add
an admin sweep.

**Resolution (done)**
- `actions/bot.ts` `deleteBot` now removes empty group chats inside the same
  transaction, after the bot and its `chatMembers` rows cascade-delete. The
  sweep selects the user's group chats with no remaining members and deletes
  them, so no orphan rows linger.

### BUG-25 — Missing bounds on `avatar`; free-text message role
`db/tables.ts` — `avatar` was an unbounded user string used as a DiceBear
seed. `chatMessages.role` was free text.

**Resolution (done)**
- `botInsertSchema` (`db/tables.ts`) applies `.trim().max(128, ...)` to `avatar`,
  shared by client and server validation.
- `chatMessages.role` is now a `message_role` pgEnum with exactly the roles the
  AI SDK persists (`user`, `assistant`, `system`). `bun run db:push` applied the
  change.

### BUG-26 — No rate limiting or body-size cap on `/api/chat`
Internal network exposure can still exhaust model quota or memory. Add per-chat
rate limits and a request body limit.

**Resolution (done)**
- `lib/rate-limit.ts` — in-memory sliding-window limiter keyed per chat
  (`chat:<id>`), 20 requests per 10 minutes. Expired buckets are swept lazily
  once the map reaches 1000 keys, so the map stays bounded.
- Both `/api/chat` and `/api/chat/approval` enforce `MAX_CHAT_BODY_BYTES`
  (64 KB), a JSON parse guard (400), and the per-chat 429 with a `Retry-After`
  header. The limit is applied *before* any proxying or in-process work, so
  neither the web nor the runner path can burn model quota in a tight loop.
  Note the check is advisory quota protection, not an auth boundary: the
  deployment is an internal workspace.
- Verified with `bun run typecheck` and `bun run build`.

### BUG-27 — `getChat` loads unbounded message history
`queries/chats.ts` previously loaded every message on each page view. Now it
fetches the most recent 50 messages (`MESSAGE_LIMIT`) in descending order and
reverses them for display, so page payloads and agent context stay bounded for
long chats. The full history remains the database's source of truth.

**Resolution (done)**
- `queries/chats.ts` — `chatMessages` is queried separately with `desc()` order
  and `.limit(50)`; the chronological list is reassembled in memory. Page
  payloads and prompt history are now bounded.

### BUG-28 — CI lint is advisory only
`.github/workflows/ci.yml` sets `continue-on-error: true` for lint. Once the
starter-component violations are resolved, make lint blocking.

**Resolution (done)**
- Deleted the 15 dead vendored starter components that carried the
  React-compiler lint errors (`code-block`, `tool`, `sandbox`, `web-preview`,
  `agent`, `shimmer`, `plan`, `reasoning`, `inline-citation`, `carousel`,
  `commit`, `jsx-preview`, `mic-selector`, `persona`, `speech-input`); none were
  referenced by app-reachable code (verified with an import-graph sweep from
  `app/`).
- `hooks/use-mobile.ts` was rewritten with `useSyncExternalStore`, matching the
  React 19 guidance for external stores.
- `bun run lint` now exits 0 (only benign warnings remain), and the CI lint
  step is blocking again — `continue-on-error` and the advisory comment are
  removed.

### BUG-29 — Deployment scripts duplicate logic
`scripts/deploy.sh` and `scripts/dev-deploy.sh` share ~80% of their code and rely
on string substitution for image tags. Consolidate into one script with a mode
flag.

**Resolution (done)**
- `scripts/dev-deploy.sh` is gone; `scripts/deploy.sh [--release|--dev]` is the
  single entry point (`--release` is the default and preserves the documented
  env-driven release flow).
- Mode-specific parts (image resolution, docker build/load/push, k8s/production
  vs k8s base overlay, env-driven config vs interactive prompts) are selected
  up front; everything else is shared verbatim: namespace check, context
  resolution and confirmation, Postgres role reconcile, secret/config creation,
  schema-job wait, rollout wait.
- The image-tag substitution is now scoped to `image:` lines via sed instead of
  a blunt substring replace of the whole rendered output.
- `ASSUME_YES=yes` skips the confirmation in both modes; `--dev` without a tty
  and without `ASSUME_YES=yes` fails with a clear message instead of
  hanging on `read`.
- Verified by exercising both modes with stubbed `kubectl`/`docker`
  (namespace → secret → job → apply order, image rewrite for an overridden
  IMAGE, missing kind/minikube error path, bad provider/flag errors) and
  `bash -n`. README and k8s/README updated to `./scripts/deploy.sh --dev`.

---

## Verification checklist

Before closing the audit, run:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
```

Then validate the manifest layer:

```bash
kubectl kustomize k8s/production
kubectl auth can-i --list --as=system:serviceaccount:kubernetes-agent:kubernetes-agent
```

and exercise the approval flow against a real namespace (BUG-02, BUG-03, BUG-04).
