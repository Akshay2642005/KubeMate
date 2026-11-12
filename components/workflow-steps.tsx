import { Check, Loader2, Workflow } from "lucide-react"

import type { AgentChatStatus, LiveStep } from "@/lib/use-agent-chat"
import type { WorkflowStep } from "@/lib/chat-types"
import { cn } from "@/lib/utils"

const STAGE_LABELS: Record<string, string> = {
  intake: "Intake",
  model: "Reasoning",
  tools: "Inspection",
}

const STAGE_PHRASES: Record<string, string> = {
  intake: "Triaging the request",
  model: "Reasoning",
  tools: "Inspecting the cluster",
}

function stageGroups(steps: readonly string[]) {
  return steps.reduce<{ name: string; count: number }[]>((groups, step) => {
    const last = groups.at(-1)
    if (last && last.name === step) {
      last.count += 1
    } else {
      groups.push({ name: step, count: 1 })
    }
    return groups
  }, [])
}

// Live status line rendered above the composer while a run is in flight. The
// phrase names what the agent is actually doing (driven by STEP_STARTED
// events); dimmed chips record the stages already walked.
export function LiveWorkflowSteps({
  status,
  steps,
}: {
  status: AgentChatStatus
  steps: readonly LiveStep[]
}) {
  if (status !== "submitted" && status !== "streaming") return null

  const active = steps.find((step) => step.status === "active")
  const done = steps.filter((step) => step.status === "done")
  const phrase = active
    ? STAGE_PHRASES[active.name] ?? "Working"
    : "Starting"

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-1.5 flex items-center gap-2 px-1 text-[11px] text-muted-foreground"
    >
      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      <span className="shrink-0">{phrase}…</span>
      <span className="flex min-w-0 items-center gap-1 overflow-hidden">
        {stageGroups(done.map((step) => step.name)).map((group, index) => (
          <span
            key={`${group.name}-${index}`}
            className="flex shrink-0 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-medium text-muted-foreground"
          >
            <Check className="size-3" aria-hidden="true" />
            {STAGE_LABELS[group.name] ?? group.name}
            {group.count > 1 ? ` ×${group.count}` : ""}
          </span>
        ))}
      </span>
    </div>
  )
}

// Persisted summary rendered above a completed assistant message.
export function WorkflowSteps({ steps }: { steps: readonly WorkflowStep[] }) {
  if (steps.length === 0) return null

  const groups = stageGroups(steps)
  return (
    <div
      aria-label="Agent workflow"
      className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"
    >
      <Workflow className="size-3.5" aria-hidden="true" />
      {groups.map((group, index) => (
        <span key={`${group.name}-${index}`} className="flex items-center gap-1.5">
          {index > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground/50">
              →
            </span>
          ) : null}
          <span
            className={cn(
              "flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-medium"
            )}
          >
            <Check className="size-3 text-emerald-500" aria-hidden="true" />
            {STAGE_LABELS[group.name] ?? group.name}
            {group.count > 1 ? ` ×${group.count}` : ""}
          </span>
        </span>
      ))}
    </div>
  )
}
