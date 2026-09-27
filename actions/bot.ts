"use server"

import { and, eq, inArray } from "drizzle-orm"
import { nanoid } from "nanoid"
import { revalidatePath } from "next/cache"

import { db } from "@/db"
import {
  botInsertSchema,
  bots,
  chatMembers,
  chats,
  type BotInsert,
} from "@/db/schema"
import { INTERNAL_USER_ID } from "@/lib/internal-user"

export async function createBot(values: BotInsert) {
  const data = botInsertSchema.parse(values)
  const id = nanoid()
  const bot = await db.transaction(async (tx) => {
    const [bot] = await tx
      .insert(bots)
      .values({
        ...data,
        id,
        instructions: data.instructions || null,
        userId: INTERNAL_USER_ID,
      })
      .returning()

    const [chat] = await tx
      .insert(chats)
      .values({ userId: INTERNAL_USER_ID, kind: "direct" })
      .returning({ id: chats.id })

    await tx.insert(chatMembers).values({ chatId: chat.id, botId: bot.id })
    return bot
  })

  revalidatePath("/")
  return bot
}

export async function updateBot(botId: string, values: BotInsert) {
  const data = botInsertSchema.parse(values)

  const [bot] = await db
    .update(bots)
    .set({ ...data, instructions: data.instructions || null })
    .where(and(eq(bots.id, botId), eq(bots.userId, INTERNAL_USER_ID)))
    .returning()
  if (!bot) throw new Error("Bot not found")

  // The bot shows up in the sidebar and in every chat it fronts
  revalidatePath("/", "layout")

  return bot
}

export async function deleteBot(botId: string) {
  const [owned] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, INTERNAL_USER_ID)))
  if (!owned) throw new Error("Bot not found")

  await db.transaction(async (tx) => {
    // A direct chat is nothing without its bot; memberships go with the bot
    await tx
      .delete(chats)
      .where(
        and(
          eq(chats.userId, INTERNAL_USER_ID),
          eq(chats.kind, "direct"),
          inArray(
            chats.id,
            tx
              .select({ id: chatMembers.chatId })
              .from(chatMembers)
              .where(eq(chatMembers.botId, botId))
          )
        )
      )

    const [bot] = await tx
      .delete(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, INTERNAL_USER_ID)))
      .returning({ id: bots.id })
    if (!bot) throw new Error("Bot not found")
  })

  revalidatePath("/", "layout")
}
