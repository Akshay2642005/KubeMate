import { and, asc, desc, eq } from "drizzle-orm"

import { db } from "@/db"
import { chatMembers, chatMessages, chats } from "@/db/schema"
import { INTERNAL_USER_ID } from "@/lib/internal-user"
import type { ChatUIMessage } from "@/lib/chat-types"

// Only the most recent messages are loaded per page view; the agent and the
// UI never need more than this, and long chats must not grow the payload
// without bound.
const MESSAGE_LIMIT = 50

// One of the signed-in user's chats with the bots in it, or null if it isn't theirs
export async function getChat(chatId: string) {
  const [row, messages] = await Promise.all([
    db.query.chats.findFirst({
      where: and(eq(chats.id, chatId), eq(chats.userId, INTERNAL_USER_ID)),
      with: {
        // Group members join together, so the bot ID settles the order
        members: {
          orderBy: [asc(chatMembers.joinedAt), asc(chatMembers.botId)],
          with: { bot: true },
        },
        approvals: true,
      },
    }),
    db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(MESSAGE_LIMIT),
  ])
  if (!row) return null

  // Assemble the most recent MESSAGE_LIMIT messages in chronological order
  const history = messages.reverse()

  // A chat whose bots were all deleted has nobody to show
  const { members, approvals, ...chat } = row
  const approvalStatuses = new Map(
    approvals.map((approval) => [approval.id, approval.status])
  )
  return members.length > 0
    ? {
        ...chat,
        bots: members.map((member) => member.bot),
        messages: history.map(({ message }) => {
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
