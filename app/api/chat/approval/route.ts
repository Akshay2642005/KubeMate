import { and, eq } from "drizzle-orm"
import { generateId } from "ai"

import { db } from "@/db"
import { chatApprovals, chats } from "@/db/schema"
import { applyKubernetesAction } from "@/lib/agent/kubernetes/actions"
import { actionProposalSchema } from "@/lib/agent/kubernetes/proposals"
import type { ApprovalResult, ChatUIMessage } from "@/lib/chat-types"
import { saveMessages } from "@/lib/chat/persistence"
import { summarizeVerifiedAction } from "@/lib/agent/summary"
import { isRunner, proxyToRunner } from "@/lib/runner"
import { MAX_CHAT_BODY_BYTES, rateLimit } from "@/lib/rate-limit"
import { INTERNAL_USER_ID } from "@/lib/internal-user"

// Atomically move a pending approval to its resolved status. Only the request
// that wins this update is allowed to execute the action, so two concurrent
// approvals can never mutate the cluster twice.
async function claimApproval(input: {
  approvalId: string
  chatId: string
  status: "approved" | "rejected"
}) {
  const [claimed] = await db
    .update(chatApprovals)
    .set({ status: input.status, resolvedAt: new Date() })
    .where(
      and(
        eq(chatApprovals.id, input.approvalId),
        eq(chatApprovals.chatId, input.chatId),
        eq(chatApprovals.status, "pending")
      )
    )
    .returning({ id: chatApprovals.id })

  return claimed !== undefined
}

export async function POST(request: Request) {
  const raw = await request.text()
  if (raw.length > MAX_CHAT_BODY_BYTES) {
    return new Response("Request body is too large.", { status: 413 })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Response("Request body must be valid JSON.", { status: 400 })
  }
  const body = parsed as {
    chatId?: string
    approvalId?: string
    approved?: boolean
  }

  // Approvals mutate the cluster; they get the same per-chat quota as messages.
  if (body.chatId) {
    const verdict = rateLimit(`chat:${body.chatId}`, 20, 10 * 60 * 1000)
    if (!verdict.ok) {
      return new Response(
        "Too many requests for this chat. Try again shortly.",
        {
          status: 429,
          headers: { "retry-after": String(verdict.retryAfter) },
        }
      )
    }
  }

  // The web deployment has no ServiceAccount token; it forwards approval
  // executions to the runner over the cluster network.
  if (!isRunner()) return proxyToRunner("/api/chat/approval", raw)

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

  // Never execute a proposal that does not match a known action schema.
  const parsedProposal = actionProposalSchema.safeParse(approval.action)
  if (!parsedProposal.success) {
    await db
      .update(chatApprovals)
      .set({ status: "failed", resolvedAt: new Date() })
      .where(
        and(
          eq(chatApprovals.id, approval.id),
          eq(chatApprovals.status, "pending")
        )
      )
    return Response.json(
      { error: "Approval request is not a valid Kubernetes action." },
      { status: 422 }
    )
  }
  const proposal = parsedProposal.data

  let result: ApprovalResult
  let text: string

  if (!body.approved) {
    const claimed = await claimApproval({
      approvalId: approval.id,
      chatId: body.chatId,
      status: "rejected",
    })
    if (!claimed) {
      return new Response("Approval request has already been resolved.", {
        status: 409,
      })
    }
    result = { approvalId: approval.id, status: "rejected" }
    text = "Change rejected. No Kubernetes resources were modified."
  } else {
    const claimed = await claimApproval({
      approvalId: approval.id,
      chatId: body.chatId,
      status: "approved",
    })
    if (!claimed) {
      return new Response("Approval request has already been resolved.", {
        status: 409,
      })
    }

    try {
      const actionResult = await applyKubernetesAction(proposal)
      result = {
        approvalId: approval.id,
        status: "approved",
        result: actionResult,
      }
      text = await summarizeVerifiedAction(proposal, actionResult)
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      await db
        .update(chatApprovals)
        .set({ status: "failed", resolvedAt: new Date() })
        .where(eq(chatApprovals.id, approval.id))
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
