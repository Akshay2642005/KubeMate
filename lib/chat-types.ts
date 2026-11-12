import type { UIMessage } from "ai"

import type { ActionProposal } from "@/lib/agent/kubernetes/proposals"

export type { ActionProposal }

export type ToolLog = {
  tool: string
  input: unknown
  output?: unknown
  error?: string
}

// The AG-UI STATE_SNAPSHOT payload emitted during a run. The protocol's
// snapshot replaces "agent state" wholesale, so our state carries the run
// outcome the UI renders: the tool logs accumulated so far, the approval
// request minted for a proposal tool (if any), the ordered workflow steps,
// and the id the assistant message is persisted with.
export type AgentRunState = {
  toolLogs: ToolLog[]
  approvalRequest?: ApprovalRequest
  workflow: WorkflowStep[]
  assistantMessageId: string
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "failed"

export type ApprovalRequest = ActionProposal & {
  approvalId: string
  status: ApprovalStatus
}

export type ApprovalResult = {
  approvalId: string
  status: Exclude<ApprovalStatus, "pending">
  result?: unknown
  error?: string
}

// The ordered graph steps a run executed — e.g. ["intake", "model", "tools",
// "model"]. Persisted on the assistant message so the workflow ribbon can
// render the same summary after a reload.
export type WorkflowStep = string

export type ChatUIMessage = UIMessage<
  { botId?: string; mentionedBotIds?: string[]; workflow?: WorkflowStep[] },
  {
    "tool-log": ToolLog
    "approval-request": ApprovalRequest
    "approval-result": ApprovalResult
  }
>
