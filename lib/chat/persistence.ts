import { and, eq } from "drizzle-orm"

import { db } from "@/db"
import { chatMessages, chats } from "@/db/schema"
import type { ChatUIMessage } from "@/lib/chat-types"
import { INTERNAL_USER_ID } from "@/lib/internal-user"

export function messageText(message: ChatUIMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

export async function saveMessages(chatId: string, messages: ChatUIMessage[]) {
  if (messages.length === 0) return

  await db.transaction(async (tx) => {
    for (const message of messages) {
      await tx
        .insert(chatMessages)
        .values({
          chatId,
          messageId: message.id,
          role: message.role,
          message,
        })
        .onConflictDoUpdate({
          target: [chatMessages.chatId, chatMessages.messageId],
          set: { role: message.role, message },
        })
    }

    const latest = messages.at(-1)
    const preview = latest ? messageText(latest).slice(0, 200) : undefined
    if (preview) {
      await tx
        .update(chats)
        .set({ lastMessagePreview: preview, lastMessageAt: new Date() })
        .where(and(eq(chats.id, chatId), eq(chats.userId, INTERNAL_USER_ID)))
    }
  })
}
