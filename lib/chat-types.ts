import type { UIMessage } from "ai"

export type ToolLog = {
  tool: string
  input: unknown
  output?: unknown
  error?: string
}

export type ActionProposal = {
  action:
    | "label_node"
    | "remove_deployment_node_selector"
    | "recreate_pod_without_node_selector"
  summary: string
  input:
    | {
        node: string
        key: string
        value: string
      }
    | {
        namespace: string
        deployment: string
      }
    | {
        namespace: string
        pod: string
      }
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

export type ChatUIMessage = UIMessage<
  { botId?: string; mentionedBotIds?: string[] },
  {
    "tool-log": ToolLog
    "approval-request": ApprovalRequest
    "approval-result": ApprovalResult
  }
>
