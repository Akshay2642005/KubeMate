import { and, eq } from "drizzle-orm"
import { generateId } from "ai"

import { db } from "@/db"
import { chatApprovals, chats } from "@/db/schema"
import { applyKubernetesAction } from "@/lib/agent/kubernetes/actions"
import type {
  ActionProposal,
  ApprovalResult,
  ChatUIMessage,
} from "@/lib/chat-types"
import { saveMessages } from "@/lib/chat/persistence"
import { INTERNAL_USER_ID } from "@/lib/internal-user"

export async function POST(request: Request) {
  const body = (await request.json()) as {
    chatId?: string
    approvalId?: string
    approved?: boolean
  }

  if (!body.chatId || !body.approvalId || body.approved === undefined) {
    return new Response("chatId, approvalId, and approved are required.", {
      status: 400,
    })
  }

  const chat = await db.query.chats.findFirst({
    where: and(eq(chats.id, body.chatId), eq(chats.userId, INTERNAL_USER_ID)),
  })
  if (!chat) return new Response("Chat not found.", { status: 404 })

  const approval = await db.query.chatApprovals.findFirst({
    where: and(
      eq(chatApprovals.id, body.approvalId),
      eq(chatApprovals.chatId, body.chatId)
    ),
  })
  if (!approval)
    return new Response("Approval request not found.", { status: 404 })
  if (approval.status !== "pending") {
    return new Response("Approval request has already been resolved.", {
      status: 409,
    })
  }

  const proposal = approval.action as ActionProposal
  let result: ApprovalResult
  let text: string

  if (!body.approved) {
    await db
      .update(chatApprovals)
      .set({ status: "rejected", resolvedAt: new Date() })
      .where(eq(chatApprovals.id, body.approvalId))
    result = { approvalId: approval.id, status: "rejected" }
    text = "Change rejected. No Kubernetes resources were modified."
  } else {
    try {
      const actionResult = await applyKubernetesAction(proposal)
      await db
        .update(chatApprovals)
        .set({ status: "approved", resolvedAt: new Date() })
        .where(eq(chatApprovals.id, body.approvalId))
      result = {
        approvalId: approval.id,
        status: "approved",
        result: actionResult,
      }
      text = `Approved and applied: ${proposal.summary}\n\nVerification data: ${JSON.stringify(actionResult)}`
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      await db
        .update(chatApprovals)
        .set({ status: "failed", resolvedAt: new Date() })
        .where(eq(chatApprovals.id, body.approvalId))
      result = { approvalId: approval.id, status: "failed", error: errorText }
      text = `The approved change failed and may not have been applied: ${errorText}`
    }
  }

  const message: ChatUIMessage = {
    id: generateId(),
    role: "assistant",
    parts: [
      { type: "data-approval-result", data: result },
      { type: "text", text },
    ],
  }
  await saveMessages(body.chatId, [message])

  return Response.json({ message })
}
