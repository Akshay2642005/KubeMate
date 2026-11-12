import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  Container,
  ChevronRight,
  CircleAlert,
  FileText,
  Info,
  Layers,
  ListTree,
  Network,
  Route,
  ScrollText,
  Server,
  ShieldCheck,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react"
import { useState, type ReactNode } from "react"

import type { ToolLog } from "@/lib/chat-types"
import { cn } from "@/lib/utils"

type ParsedOutput =
  | { kind: "value"; value: unknown }
  | { kind: "truncated"; note?: string }
  | { kind: "text"; text: string }
  | { kind: "empty" }

// Tool outputs arrive as the JSON string produced by serializeToolOutput();
// a payload that exceeded the cap is wrapped in a {truncated:true, preview}
// object instead. Logs come through as raw text.
function parseToolOutput(output: unknown): ParsedOutput {
  if (output === undefined || output === null) return { kind: "empty" }
  if (typeof output !== "string") return { kind: "value", value: output }

  const trimmed = output.trim()
  if (!trimmed) return { kind: "empty" }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { truncated?: unknown }).truncated === true
    ) {
      return {
        kind: "truncated",
        note:
          typeof (parsed as { note?: unknown }).note === "string"
            ? (parsed as { note: string }).note
            : undefined,
      }
    }

    return { kind: "value", value: parsed }
  } catch {
    return { kind: "text", text: output }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function timeAgo(value: unknown): string {
  const date = new Date(typeof value === "string" || typeof value === "number" ? value : "")
  if (Number.isNaN(date.getTime())) return ""
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 90) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 36) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const STATUS_DOT: Record<string, string> = {
  running: "bg-emerald-500",
  succeeded: "bg-emerald-500",
  succeededphase: "bg-emerald-500",
  ready: "bg-emerald-500",
  pending: "bg-amber-500",
  waiting: "bg-amber-500",
  containercreating: "bg-amber-500",
  failed: "bg-red-500",
  crashloopbackoff: "bg-red-500",
  imagepullbackoff: "bg-red-500",
  completed: "bg-emerald-500",
  unknown: "bg-amber-500",
}

function dotClassFor(...statuses: (string | undefined)[]): string {
  for (const status of statuses) {
    if (!status) continue
    const key = status.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (STATUS_DOT[key]) return STATUS_DOT[key]
  }
  return "bg-muted-foreground/40"
}

function ToolCard({
  tool,
  failed,
  icon: Icon,
  summary,
  children,
}: {
  tool: string
  failed?: boolean
  icon: LucideIcon
  summary?: string
  children: ReactNode
}) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border bg-card text-card-foreground">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
        <Icon
          className={cn(
            "size-3.5",
            failed ? "text-destructive" : "text-muted-foreground"
          )}
        />
        <span className="font-mono font-medium text-foreground">{tool}</span>
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            failed ? "bg-red-500" : "bg-emerald-500"
          )}
        />
        {summary ? (
          <span className="ml-auto truncate text-muted-foreground">
            {summary}
          </span>
        ) : null}
      </div>
      <div className="p-3 text-xs">{children}</div>
    </div>
  )
}

function DefinitionRows({ rows }: { rows: [string, string][] }) {
  if (rows.length === 0) return null
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="truncate font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Chip({ children, tone }: { children: ReactNode; tone?: "amber" | "red" | "emerald" }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px]",
        tone === "amber" && "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        tone === "red" && "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
        tone === "emerald" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        !tone && "bg-muted/50 text-muted-foreground"
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  )
}

function Bar({
  label,
  value,
  total,
  tone,
}: {
  label: string
  value: number
  total: number
  tone: "emerald" | "amber" | "red"
}) {
  const percentage = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            tone === "emerald" && "bg-emerald-500",
            tone === "amber" && "bg-amber-500",
            tone === "red" && "bg-red-500"
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-mono">
        {value}/{total}
      </span>
    </div>
  )
}

function PodHealthBoard({ pods }: { pods: Record<string, unknown>[] }) {
  const rows = pods.slice(0, 40)
  const failing = rows.filter((pod) => {
    const phase = str(pod.phase)?.toLowerCase()
    return phase === "failed" || phase === "unknown"
  }).length
  const pending = rows.filter((pod) => str(pod.phase)?.toLowerCase() === "pending").length
  const summary =
    pods.length === 0
      ? "No pods"
      : [
          `${pods.length} pod${pods.length === 1 ? "" : "s"}`,
          failing ? `${failing} failing` : null,
          pending ? `${pending} pending` : null,
        ]
          .filter(Boolean)
          .join(" · ")

  return {
    summary,
    body:
      pods.length === 0 ? (
        <p className="text-muted-foreground">No pods in this namespace.</p>
      ) : (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-muted-foreground">
                <th className="pb-1 pr-3 font-medium">Pod</th>
                <th className="pb-1 pr-3 font-medium">Status</th>
                <th className="pb-1 pr-3 font-medium">Restarts</th>
                <th className="pb-1 font-medium">Node</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((pod, index) => {
                const phase = str(pod.phase) ?? "Unknown"
                const reason = str(pod.reason)
                const containers = asArray(pod.containers).map(asRecord)
                const restartCount = containers.reduce(
                  (total, container) =>
                    total + (num(container?.restartCount) ?? 0),
                  0
                )
                const ready = containers.filter(
                  (container) => container?.ready === true
                ).length
                const dot = dotClassFor(reason, phase)
                return (
                  <tr key={`${str(pod.name) ?? "pod"}-${index}`} className="border-t align-middle">
                    <td className="max-w-48 truncate py-1.5 pr-3 font-mono">
                      {str(pod.name) ?? "unknown"}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className={cn("size-1.5 rounded-full", dot)} />
                        <span className={cn(phase === "Failed" && "text-red-600 dark:text-red-400")}>
                          {reason ?? phase}
                          {containers.length > 0 ? ` ${ready}/${containers.length}` : ""}
                        </span>
                      </span>
                    </td>
                    <td
                      className={cn(
                        "py-1.5 pr-3 font-mono tabular-nums",
                        restartCount > 0 && "text-amber-600 dark:text-amber-400"
                      )}
                    >
                      {restartCount}
                    </td>
                    <td className="max-w-40 truncate py-1.5 text-muted-foreground">
                      {str(pod.node) ?? "—"}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {pods.length > rows.length ? (
            <p className="pt-2 text-muted-foreground">
              Showing {rows.length} of {pods.length} pods.
            </p>
          ) : null}
        </div>
      ),
  }
}

type EventRow = Record<string, unknown>

function sortEvents(events: EventRow[]): EventRow[] {
  return [...events].sort((a, b) => {
    const aWarning = str(a.type)?.toLowerCase() === "warning" ? 0 : 1
    const bWarning = str(b.type)?.toLowerCase() === "warning" ? 0 : 1
    if (aWarning !== bWarning) return aWarning - bWarning
    const aTime = new Date(str(a.lastTimestamp) ?? str(a.firstTimestamp) ?? 0).getTime()
    const bTime = new Date(str(b.lastTimestamp) ?? str(b.firstTimestamp) ?? 0).getTime()
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime)
  })
}

function EventsTimeline({ events }: { events: EventRow[] }) {
  const sorted = sortEvents(events)
  const shown = sorted.slice(0, 20)
  const warnings = events.filter(
    (event) => str(event.type)?.toLowerCase() === "warning"
  ).length

  return {
    summary:
      events.length === 0
        ? "No events"
        : `${events.length} event${events.length === 1 ? "" : "s"}${warnings ? ` · ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`,
    body:
      events.length === 0 ? (
        <p className="text-muted-foreground">No recent events in this namespace.</p>
      ) : (
        <ul className="max-h-64 space-y-1.5 overflow-auto">
          {shown.map((event, index) => {
            const type = str(event.type) ?? "Normal"
            const warning = type.toLowerCase() === "warning"
            const count = num(event.count)
            const involved = asRecord(event.involvedObject)
            const target = str(involved?.name)
            const timestamp = timeAgo(
              str(event.lastTimestamp) ?? str(event.firstTimestamp)
            )
            return (
              <li key={index} className="flex items-start gap-2">
                {warning ? (
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                ) : (
                  <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      className={cn(
                        "font-mono font-medium",
                        warning && "text-amber-700 dark:text-amber-400"
                      )}
                    >
                      {str(event.reason) ?? "Event"}
                    </span>
                    {target ? (
                      <span className="font-mono text-muted-foreground">{target}</span>
                    ) : null}
                    <span className="ml-auto flex items-center gap-2 text-muted-foreground tabular-nums">
                      {count && count > 1 ? <span>×{count}</span> : null}
                      {timestamp ? <span>{timestamp} ago</span> : null}
                    </span>
                  </div>
                  {str(event.message) ? (
                    <p className="mt-0.5 line-clamp-2 text-muted-foreground">
                      {str(event.message)}
                    </p>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      ),
  }
}

function ReplicaBars({
  desired,
  ready,
  updated,
  available,
}: {
  desired: number
  ready: number
  updated: number
  available: number
}) {
  const tone = (value: number) =>
    value >= desired ? "emerald" : value > 0 ? "amber" : "red"
  return (
    <div className="space-y-1.5">
      <Bar label="Ready" value={ready} total={desired} tone={tone(ready)} />
      <Bar label="Updated" value={updated} total={desired} tone={tone(updated)} />
      <Bar label="Available" value={available} total={desired} tone={tone(available)} />
    </div>
  )
}

function DeploymentView({ deployment }: { deployment: Record<string, unknown> }) {
  const desired = num(deployment.replicas) ?? 0
  const ready = num(deployment.readyReplicas) ?? 0
  const updated = num(deployment.updatedReplicas) ?? 0
  const available = num(deployment.availableReplicas) ?? 0
  const selector = asRecord(deployment.selector)
  const nodeSelector = asRecord(deployment.nodeSelector)
  const conditions = asArray(deployment.conditions).map(asRecord)

  const summary =
    desired > 0
      ? `${ready}/${desired} ready${updated < desired ? " · rollout in progress" : ""}`
      : "0 replicas"

  return {
    summary,
    body: (
      <div className="space-y-3">
        <ReplicaBars
          desired={desired}
          ready={ready}
          updated={updated}
          available={available}
        />
        {conditions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {conditions.map((condition, index) => {
              if (!condition) return null
              const type = str(condition.type) ?? "Condition"
              const status = str(condition.status) ?? "Unknown"
              const healthy =
                (type === "Available" && status === "True") ||
                (type === "Progressing" && status === "True") ||
                (type === "ReplicaFailure" && status === "False")
              return (
                <Chip key={index} tone={healthy ? "emerald" : "amber"}>
                  {type}={status}
                </Chip>
              )
            })}
          </div>
        ) : null}
        {nodeSelector && Object.keys(nodeSelector).length > 0 ? (
          <Chip tone="amber">nodeSelector: {Object.entries(nodeSelector).map(([k, v]) => `${k}=${v}`).join(", ")}</Chip>
        ) : null}
        <DefinitionRows
          rows={[
            ...(str(deployment.strategy) ? ([["Strategy", str(deployment.strategy)!]] as [string, string][]) : []),
            ...(selector
              ? [["Selector", Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(", ")] as [string, string]]
              : []),
          ]}
        />
      </div>
    ),
  }
}

function ServiceView({ service }: { service: Record<string, unknown> }) {
  const ports = asArray(service.ports).map(asRecord)
  const selector = asRecord(service.selector)
  const summary = [
    str(service.type),
    str(service.clusterIP),
    ports.length > 0 ? `${ports.length} port${ports.length === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return {
    summary,
    body: (
      <div className="space-y-2">
        {ports.length > 0 ? (
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-muted/40 text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Port</th>
                  <th className="px-2 py-1 font-medium">Target</th>
                  <th className="px-2 py-1 font-medium">Protocol</th>
                  <th className="px-2 py-1 font-medium">Name</th>
                </tr>
              </thead>
              <tbody>
                {ports.map((port, index) => (
                  <tr key={index} className="border-t font-mono">
                    <td className="px-2 py-1">{str(port?.port) ?? String(num(port?.port) ?? "—")}</td>
                    <td className="px-2 py-1">{String(port?.targetPort ?? "—")}</td>
                    <td className="px-2 py-1">{str(port?.protocol) ?? "TCP"}</td>
                    <td className="px-2 py-1 text-muted-foreground">{str(port?.name) ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {selector ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">Selector</span>
            {Object.entries(selector).map(([key, value]) => (
              <Chip key={key}>
                {key}={String(value)}
              </Chip>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">No selector (headless or external service).</p>
        )}
      </div>
    ),
  }
}

function NodeView({ node }: { node: Record<string, unknown> }) {
  const labels = asRecord(node.labels)
  const taints = asArray(node.taints).map(asRecord)
  const conditions = asArray(node.conditions).map(asRecord)
  const allocatable = asRecord(node.allocatable)
  const unschedulable = node.unschedulable === true

  return {
    summary: unschedulable
      ? "Unschedulable"
      : `${conditions.filter((condition) => str(condition?.type) === "Ready").length > 0 && conditions.find((condition) => str(condition?.type) === "Ready")?.status === "True" ? "Ready" : "Not ready"}`,
    body: (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {unschedulable ? <Chip tone="red">Unschedulable</Chip> : null}
          {taints.map((taint, index) => (
            <Chip
              key={index}
              tone={str(taint?.effect) === "NoExecute" ? "red" : "amber"}
            >
              {str(taint?.key)}:{str(taint?.effect)}
            </Chip>
          ))}
        </div>
        {conditions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {conditions.map((condition, index) => {
              const type = str(condition?.type) ?? "Condition"
              const status = str(condition?.status) ?? "Unknown"
              const healthy = type === "Ready" ? status === "True" : status === "False"
              return (
                <Chip key={index} tone={healthy ? "emerald" : "amber"}>
                  {type}={status}
                </Chip>
              )
            })}
          </div>
        ) : null}
        {allocatable ? (
          <DefinitionRows
            rows={Object.entries(allocatable).map(([key, value]) => [
              `Allocatable ${key}`,
              String(value),
            ])}
          />
        ) : null}
        {labels && Object.keys(labels).length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(labels).map(([key, value]) => (
              <Chip key={key}>
                {key}={String(value)}
              </Chip>
            ))}
          </div>
        ) : null}
      </div>
    ),
  }
}

function ContainerTable({
  containers,
  statuses,
}: {
  containers: Record<string, unknown>[]
  statuses: Record<string, unknown>[]
}) {
  if (containers.length === 0) return null
  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full text-left">
        <thead>
          <tr className="bg-muted/40 text-muted-foreground">
            <th className="px-2 py-1 font-medium">Container</th>
            <th className="px-2 py-1 font-medium">Image</th>
            <th className="px-2 py-1 font-medium">Ready</th>
            <th className="px-2 py-1 font-medium">Restarts</th>
          </tr>
        </thead>
        <tbody>
          {containers.map((container, index) => {
            const name = str(container.name) ?? `container-${index}`
            const status = statuses.find(
              (candidate) => str(candidate.name) === name
            )
            const ready = status?.ready === true
            const restartCount = num(status?.restartCount) ?? 0
            const state = asRecord(status?.state)
            const waiting = asRecord(state?.waiting)
            const terminated = asRecord(state?.terminated)
            const reason = str(waiting?.reason) ?? str(terminated?.reason)
            return (
              <tr key={index} className="border-t align-middle">
                <td className="py-1.5 px-2 font-mono">{name}</td>
                <td className="max-w-48 truncate px-2 py-1.5 font-mono text-muted-foreground">
                  {str(container.image) ?? "—"}
                </td>
                <td className="px-2 py-1.5">
                  {ready ? (
                    <Check className="size-3.5 text-emerald-500" />
                  ) : (
                    <X className="size-3.5 text-red-500" />
                  )}
                </td>
                <td
                  className={cn(
                    "px-2 py-1.5 font-mono tabular-nums",
                    restartCount > 0 && "text-amber-600 dark:text-amber-400"
                  )}
                >
                  {restartCount}
                  {reason ? (
                    <span className="ml-1 text-red-600 dark:text-red-400">
                      {reason}
                    </span>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PodView({ pod }: { pod: Record<string, unknown> }) {
  const phase = str(pod.phase) ?? "Unknown"
  const reason = str(pod.reason)
  const conditions = asArray(pod.conditions).map(asRecord)
  const containers = asArray(pod.containers).map(asRecord) as Record<string, unknown>[]
  const statuses = asArray(pod.containerStatuses).map(asRecord) as Record<string, unknown>[]
  const selector = asRecord(pod.nodeSelector)

  return {
    summary: reason ? `${phase} (${reason})` : phase,
    body: (
      <div className="space-y-2">
        {str(pod.message) && phase !== "Running" ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800 dark:text-amber-300">
            {str(pod.message)}
          </p>
        ) : null}
        <DefinitionRows
          rows={[
            ["Pod", `${str(pod.namespace) ?? "default"}/${str(pod.name) ?? "unknown"}`],
            ...(str(pod.node) ? [["Node", str(pod.node)!] as [string, string]] : []),
          ]}
        />
        <div className="flex flex-wrap gap-1.5">
          {conditions.slice(0, 6).map((condition, index) => {
            const type = str(condition?.type) ?? "Condition"
            const status = str(condition?.status) ?? "Unknown"
            const healthy =
              type === "Ready" || type === "PodScheduled" || type === "Initialized"
                ? status === "True"
                : status === "False"
            return (
              <Chip key={index} tone={healthy ? "emerald" : "amber"}>
                {type}={status}
              </Chip>
            )
          })}
          {selector && Object.keys(selector).length > 0 ? (
            <Chip tone="amber">
              nodeSelector: {Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(", ")}
            </Chip>
          ) : null}
        </div>
        <ContainerTable containers={containers} statuses={statuses} />
      </div>
    ),
  }
}

function LogView({ text }: { text: string }) {
  const lines = text.split("\n")
  const shown = lines.slice(-150)
  const hidden = lines.length - shown.length
  return {
    summary: `${lines.length} line${lines.length === 1 ? "" : "s"}`,
    body: (
      <div>
        <pre className="max-h-72 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed text-zinc-200">
          {shown.map((line, index) => {
            const lower = line.toLowerCase()
            const tone = /error|exception|fatal|critical|panic/.test(lower)
              ? "text-red-400"
              : /warn|warning|deprecat/.test(lower)
                ? "text-amber-300"
                : undefined
            return (
              <span key={index} className={cn("block", tone)}>
                {line}
              </span>
            )
          })}
        </pre>
        {hidden > 0 ? (
          <p className="pt-1 text-muted-foreground">
            {hidden} earlier line{hidden === 1 ? "" : "s"} hidden.
          </p>
        ) : null}
      </div>
    ),
  }
}

function TraceWorkloadView({ trace }: { trace: Record<string, unknown> }) {
  const deployment = asRecord(trace.deployment) ?? {}
  const replicasets = asArray(trace.replicasets).map(asRecord) as Record<string, unknown>[]
  const pods = asArray(trace.pods).map(asRecord) as Record<string, unknown>[]
  const services = asArray(trace.services).map(asRecord) as Record<string, unknown>[]
  const desired = num(deployment.replicas) ?? 0
  const ready = num(deployment.readyReplicas) ?? 0
  const truncated = trace.truncated === true

  const summary = [
    desired > 0 ? `${ready}/${desired} ready` : null,
    `${trace.podCount ?? pods.length} pod${(trace.podCount ?? pods.length) === 1 ? "" : "s"}`,
    services.length > 0 ? `${services.length} service${services.length === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  const sectionLabel = "mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"

  return {
    summary,
    body: (
      <div className="space-y-3">
        {truncated ? (
          <Chip tone="amber">Pod list truncated at 50 — use a narrower selector</Chip>
        ) : null}
        <div>
          <p className={sectionLabel}>Deployment</p>
          <div className="rounded-md border bg-muted/30 p-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="truncate font-mono font-medium">{str(deployment.name) ?? "deployment"}</span>
              <span className="font-mono text-muted-foreground tabular-nums">
                {ready}/{desired} ready
              </span>
            </div>
            <ReplicaBars
              desired={desired}
              ready={ready}
              updated={num(deployment.updatedReplicas) ?? 0}
              available={num(deployment.availableReplicas) ?? 0}
            />
          </div>
        </div>
        <div>
          <p className={sectionLabel}>Owned by ReplicaSets ({replicasets.length})</p>
          {replicasets.length === 0 ? (
            <p className="text-muted-foreground">No ReplicaSets matched the selector.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {replicasets.map((rs, index) => (
                <Chip key={index}>
                  {str(rs.name)} · {num(rs.readyReplicas) ?? 0}/{num(rs.replicas) ?? 0}
                </Chip>
              ))}
            </div>
          )}
        </div>
        <div>
          <p className={sectionLabel}>Pods ({pods.length})</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {pods.slice(0, 12).map((pod, index) => {
              const phase = str(pod.phase) ?? "Unknown"
              const reason = str(pod.reason)
              const restarts = num(pod.restarts) ?? 0
              const dot = dotClassFor(reason, phase)
              return (
                <div
                  key={index}
                  className="flex items-center gap-1.5 rounded-md border bg-muted/30 px-2 py-1"
                >
                  <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dot)} />
                  <span className="truncate font-mono">{str(pod.name)}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-muted-foreground tabular-nums">
                    {restarts > 0 ? (
                      <span className="text-amber-600 dark:text-amber-400">↻{restarts}</span>
                    ) : null}
                    {num(pod.containersReady)}/{num(pod.containersTotal)}
                  </span>
                </div>
              )
            })}
          </div>
          {pods.length > 12 ? (
            <p className="pt-1 text-muted-foreground">+{pods.length - 12} more pods.</p>
          ) : null}
        </div>
        <div>
          <p className={sectionLabel}>Routed by services ({services.length})</p>
          {services.length === 0 ? (
            <p className="text-amber-700 dark:text-amber-400">
              No Service selector matches these pods — traffic cannot reach them.
            </p>
          ) : (
            <div className="space-y-1.5">
              {services.map((service, index) => (
                <div
                  key={index}
                  className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
                >
                  <Route className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-mono font-medium">{str(service.name)}</span>
                  <span className="text-muted-foreground">{str(service.type)}</span>
                  <ArrowRight className="size-3 text-muted-foreground" />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {asArray(service.ports)
                      .map((port) => {
                        const record = asRecord(port)
                        return `${num(record?.port) ?? record?.port}→${String(record?.targetPort ?? "?")}`
                      })
                      .join(", ")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    ),
  }
}

function ProposalNote({ output }: { output: unknown }) {
  const parsed = parseToolOutput(output)
  const record =
    parsed.kind === "value" ? asRecord(parsed.value) : undefined
  const summary = str(record?.summary)
  const action = str(record?.action)
  const sentence = summary
    ? /[.!?]$/.test(summary)
      ? summary
      : `${summary}.`
    : "A change proposal was prepared."

  return {
    summary: "Proposal prepared",
    body: (
      <div className="flex items-start gap-2 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <p>
          {sentence} Review the approval card before anything is applied.
          {action ? <span className="sr-only">Action: {action}</span> : null}
        </p>
      </div>
    ),
  }
}

function JsonFallback({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Tool output
      </button>
      {open ? (
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

function TruncatedNote({ note }: { note?: string }) {
  return (
    <div className="flex items-start gap-2 text-amber-800 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <p>{note ?? "The tool output exceeded the size cap and was truncated."}</p>
    </div>
  )
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  list_pods: Container,
  list_events: Activity,
  get_pod_logs: ScrollText,
  get_pod: Boxes,
  describe_pod: FileText,
  get_deployment: Layers,
  get_service: Network,
  get_node: Server,
  trace_workload: ListTree,
  label_node: ShieldCheck,
  remove_deployment_node_selector: ShieldCheck,
  recreate_pod_without_node_selector: ShieldCheck,
}

function records(value: unknown): Record<string, unknown>[] {
  return asArray(value).filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item)
  )
}

function renderValueView(tool: string, value: unknown) {
  switch (tool) {
    case "list_pods":
      return PodHealthBoard({ pods: records(value) })
    case "list_events":
      return EventsTimeline({ events: records(value) })
    case "get_deployment":
      return DeploymentView({ deployment: asRecord(value) ?? {} })
    case "get_service":
      return ServiceView({ service: asRecord(value) ?? {} })
    case "get_node":
      return NodeView({ node: asRecord(value) ?? {} })
    case "get_pod":
      return PodView({ pod: asRecord(value) ?? {} })
    case "describe_pod": {
      const record = asRecord(value)
      if (!record) return undefined
      const pod = PodView({ pod: asRecord(record.pod) ?? {} })
      const timeline = EventsTimeline({ events: records(record.events) })
      return {
        summary: timeline.summary ? `${pod.summary} · ${timeline.summary}` : pod.summary,
        body: (
          <>
            {pod.body}
            <div className="mt-3 border-t pt-2">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Events
              </p>
              {timeline.body}
            </div>
          </>
        ),
      }
    }
    case "trace_workload":
      return TraceWorkloadView({ trace: asRecord(value) ?? {} })
    case "label_node":
    case "remove_deployment_node_selector":
    case "recreate_pod_without_node_selector":
      return ProposalNote({ output: value })
    default:
      return undefined
  }
}

export function ChatToolCall({ log }: { log: ToolLog }) {
  const failed = Boolean(log.error)
  const parsed = parseToolOutput(log.output)
  const icon = failed
    ? CircleAlert
    : (TOOL_ICONS[log.tool] ?? Terminal)

  let summary: string | undefined
  let body: ReactNode

  if (failed) {
    summary = "Failed"
    body = (
      <pre className="whitespace-pre-wrap font-mono text-destructive">
        {log.error}
      </pre>
    )
  } else if (parsed.kind === "truncated") {
    summary = "Output truncated"
    body = <TruncatedNote note={parsed.note} />
  } else if (parsed.kind === "empty") {
    body = <p className="text-muted-foreground">No output.</p>
  } else if (parsed.kind === "text") {
    const view = LogView({ text: parsed.text })
    summary = view.summary
    body = view.body
  } else {
    const view = renderValueView(log.tool, parsed.value)
    summary = view?.summary
    body = view?.body ?? <JsonFallback value={parsed.value} />
  }

  return (
    <ToolCard tool={log.tool} failed={failed} icon={icon} summary={summary}>
      {body}
    </ToolCard>
  )
}
