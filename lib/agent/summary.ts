import { HumanMessage, SystemMessage } from "@langchain/core/messages"

import { agentModel } from "@/lib/agent/model"
import type { ActionProposal } from "@/lib/chat-types"

export async function summarizeVerifiedAction(
  proposal: ActionProposal,
  verification: unknown
) {
  const response = await agentModel().invoke([
    new SystemMessage(
      "You are the final step of a Kubernetes remediation agent. Write a concise, user-facing completion summary from the verified result only. State what changed, the exact target, and the observed verification state. Do not output JSON, headings, approval instructions, implementation details, or claims not present in the evidence. Use at most two sentences."
    ),
    new HumanMessage(
      JSON.stringify({
        requestedAction: proposal.summary,
        action: proposal.action,
        verifiedResult: verification,
      })
    ),
  ])

  return typeof response.content === "string"
    ? response.content.trim()
    : String(response.content).trim()
}
