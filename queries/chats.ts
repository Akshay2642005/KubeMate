import { and, asc, eq } from "drizzle-orm"

import { db } from "@/db"
import { chatMembers, chatMessages, chats } from "@/db/schema"
import { INTERNAL_USER_ID } from "@/lib/internal-user"
import type { ChatUIMessage } from "@/lib/chat-types"

// One of the signed-in user's chats with the bots in it, or null if it isn't theirs
export async function getChat(chatId: string) {
  const row = await db.query.chats.findFirst({
    where: and(eq(chats.id, chatId), eq(chats.userId, INTERNAL_USER_ID)),
    with: {
      // Group members join together, so the bot ID settles the order
      members: {
        orderBy: [asc(chatMembers.joinedAt), asc(chatMembers.botId)],
        with: { bot: true },
      },
      messages: {
        orderBy: asc(chatMessages.createdAt),
      },
      approvals: true,
    },
  })
  if (!row) return null

  // A chat whose bots were all deleted has nobody to show
  const { members, messages, approvals, ...chat } = row
  const approvalStatuses = new Map(
    approvals.map((approval) => [approval.id, approval.status])
  )
  return members.length > 0
    ? {
        ...chat,
        bots: members.map((member) => member.bot),
        messages: messages.map(({ message }) => {
          const chatMessage = message as ChatUIMessage
          return {
            ...chatMessage,
            parts: chatMessage.parts.map((part) =>
              part.type === "data-approval-request"
                ? {
                    ...part,
                    data: {
                      ...part.data,
                      status:
                        approvalStatuses.get(part.data.approvalId) ??
                        part.data.status,
                    },
                  }
                : part
            ),
          }
        }),
      }
    : null
}
