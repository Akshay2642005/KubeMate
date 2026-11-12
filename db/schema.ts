import { relations } from "drizzle-orm"

import {
  bots,
  chatApprovals,
  chatMembers,
  chatMessages,
  chats,
} from "./tables"

export * from "./tables"

export const botsRelations = relations(bots, ({ many }) => ({
  memberships: many(chatMembers),
}))

export const chatsRelations = relations(chats, ({ many }) => ({
  members: many(chatMembers),
  messages: many(chatMessages),
  approvals: many(chatApprovals),
}))

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  chat: one(chats, {
    fields: [chatMessages.chatId],
    references: [chats.id],
  }),
}))

export const chatApprovalsRelations = relations(chatApprovals, ({ one }) => ({
  chat: one(chats, {
    fields: [chatApprovals.chatId],
    references: [chats.id],
  }),
}))

export const chatMembersRelations = relations(chatMembers, ({ one }) => ({
  chat: one(chats, {
    fields: [chatMembers.chatId],
    references: [chats.id],
  }),
  bot: one(bots, {
    fields: [chatMembers.botId],
    references: [bots.id],
  }),
}))
