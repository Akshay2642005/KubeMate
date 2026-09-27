import { asc, desc, eq } from "drizzle-orm"

import { db } from "@/db"
import { bots, chatMembers, chats } from "@/db/schema"
import { INTERNAL_USER_ID } from "@/lib/internal-user"

// The signed-in user's chats, most recent first, each with the bots in it
export async function getChats() {
  const rows = await db.query.chats.findMany({
    where: eq(chats.userId, INTERNAL_USER_ID),
    orderBy: desc(chats.lastMessageAt),
    with: {
      // Group members join together, so the bot ID settles the order
      members: {
        orderBy: [asc(chatMembers.joinedAt), asc(chatMembers.botId)],
        with: { bot: true },
      },
    },
  })

  // A chat whose bots were all deleted has nobody to show
  return rows.flatMap(({ members, ...chat }) =>
    members.length > 0
      ? [{ ...chat, bots: members.map((member) => member.bot) }]
      : []
  )
}

// The signed-in user's bots, oldest first
export async function getBots() {
  return db.query.bots.findMany({
    where: eq(bots.userId, INTERNAL_USER_ID),
    orderBy: asc(bots.createdAt),
  })
}

export async function getBot(botId: string) {
  return db.query.bots.findFirst({
    where: (bot, { and, eq }) =>
      and(eq(bot.id, botId), eq(bot.userId, INTERNAL_USER_ID)),
  })
}

export type ChatWithBots = Awaited<ReturnType<typeof getChats>>[number]
