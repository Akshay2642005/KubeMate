"use server"

import { and, eq, inArray, notInArray } from "drizzle-orm"
import { revalidatePath } from "next/cache"

import { db } from "@/db"
import {
  bots,
  chatMembers,
  chats,
  groupChatInsertSchema,
  type GroupChatInsert,
} from "@/db/schema"
import { INTERNAL_USER_ID } from "@/lib/internal-user"

export async function createGroupChat(values: GroupChatInsert) {
  const data = groupChatInsertSchema.parse(values)
  const botIds = [...new Set(data.botIds)]
  const owned = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.userId, INTERNAL_USER_ID), inArray(bots.id, botIds)))
  if (botIds.length < 2 || owned.length !== botIds.length)
    throw new Error("Bot not found")

  const chat = await db.transaction(async (tx) => {
    const [chat] = await tx
      .insert(chats)
      .values({ userId: INTERNAL_USER_ID, kind: "group", name: data.name })
      .returning()
    await tx
      .insert(chatMembers)
      .values(botIds.map((botId) => ({ chatId: chat.id, botId })))
    return chat
  })
  revalidatePath("/", "layout")
  return chat
}

export async function updateGroupChat(chatId: string, values: GroupChatInsert) {
  const data = groupChatInsertSchema.parse(values)
  const botIds = [...new Set(data.botIds)]
  const owned = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.userId, INTERNAL_USER_ID), inArray(bots.id, botIds)))
  if (botIds.length < 2 || owned.length !== botIds.length)
    throw new Error("Bot not found")

  const chat = await db.transaction(async (tx) => {
    const [chat] = await tx
      .update(chats)
      .set({ name: data.name })
      .where(
        and(
          eq(chats.id, chatId),
          eq(chats.userId, INTERNAL_USER_ID),
          eq(chats.kind, "group")
        )
      )
      .returning()
    if (!chat) throw new Error("Chat not found")
    await tx
      .delete(chatMembers)
      .where(
        and(
          eq(chatMembers.chatId, chatId),
          notInArray(chatMembers.botId, botIds)
        )
      )
    await tx
      .insert(chatMembers)
      .values(botIds.map((botId) => ({ chatId, botId })))
      .onConflictDoNothing()
    return chat
  })
  revalidatePath("/", "layout")
  return chat
}

export async function deleteGroupChat(chatId: string) {
  const [chat] = await db
    .delete(chats)
    .where(
      and(
        eq(chats.id, chatId),
        eq(chats.userId, INTERNAL_USER_ID),
        eq(chats.kind, "group")
      )
    )
    .returning({ id: chats.id })
  if (!chat) throw new Error("Chat not found")
  revalidatePath("/", "layout")
}
