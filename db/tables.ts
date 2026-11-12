import {
  index,
  pgEnum,
  pgTable,
  primaryKey,
  jsonb,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import { createInsertSchema } from "drizzle-zod"
import { nanoid } from "nanoid"
import { z } from "zod"

// Client-safe source of truth for tables and form schemas. This module has no
// database connection and no relation graph, so importing a form schema in a
// client component does not pull the server schema module.

export const teammateProfileIds = [
  "troubleshooting",
  "deployment",
  "manifest",
  "optimization",
  "custom",
] as const

export const teammateProfileId = pgEnum(
  "teammate_profile_id",
  teammateProfileIds
)

export const bots = pgTable(
  "bots",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Stable owner key for the internal workspace
    userId: text().notNull(),
    name: text().notNull(),
    // Seed for the bot's face
    avatar: text()
      .notNull()
      .$defaultFn(() => nanoid()),
    profileId: teammateProfileId().notNull().default("custom"),
    // What the bot is for, in a phrase
    job: text().notNull(),
    // How it should go about the job
    instructions: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("bots_user_id_idx").on(table.userId)]
)

export const chatKind = pgEnum("chat_kind", ["direct", "group"])

// The AI SDK only ever persists these roles for a chat message.
export const messageRole = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
])

export const chats = pgTable(
  "chats",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Stable owner key for the internal workspace
    userId: text().notNull(),
    kind: chatKind().notNull().default("direct"),
    // Null for direct chats, which use the bot's name
    name: text(),
    lastMessagePreview: text(),
    lastMessageAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("chats_user_id_idx").on(table.userId)]
)

export const chatMessages = pgTable(
  "chat_messages",
  {
    chatId: text()
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    messageId: text().notNull(),
    role: messageRole().notNull(),
    message: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.messageId] }),
    index("chat_messages_chat_id_created_at_idx").on(
      table.chatId,
      table.createdAt
    ),
  ]
)

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "failed",
])

export const chatApprovals = pgTable(
  "chat_approvals",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => nanoid()),
    chatId: text()
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    action: jsonb().notNull(),
    status: approvalStatus().notNull().default("pending"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
  },
  (table) => [index("chat_approvals_chat_id_idx").on(table.chatId)]
)

export const chatMembers = pgTable(
  "chat_members",
  {
    chatId: text()
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    botId: text()
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.botId] }),
    index("chat_members_bot_id_idx").on(table.botId),
  ]
)

// What the internal workspace may submit; owner and generated fields are omitted.
export const botInsertSchema = createInsertSchema(bots, {
  avatar: (schema) =>
    schema.trim().max(128, "Keep the avatar seed under 128 characters."),
  name: (schema) =>
    schema
      .trim()
      .min(1, "Give your bot a name.")
      .max(50, "Keep it under 50 characters."),
  job: (schema) =>
    schema
      .trim()
      .min(1, "Tell your bot what its job is.")
      .max(100, "Keep it under 100 characters."),
  instructions: (schema) =>
    schema.trim().max(4000, "Keep it under 4000 characters."),
}).omit({ id: true, userId: true, createdAt: true })

// A group chat is a name and the bots in it; direct chats are made with their bot
export const groupChatInsertSchema = createInsertSchema(chats, {
  name: z
    .string()
    .trim()
    .min(1, "Give the group a name.")
    .max(50, "Keep it under 50 characters."),
})
  .omit({
    id: true,
    userId: true,
    kind: true,
    lastMessagePreview: true,
    lastMessageAt: true,
    createdAt: true,
  })
  .extend({
    botIds: z
      .array(z.string())
      .min(2, "Pick at least two bots.")
      .max(10, "Pick at most ten bots.")
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Each bot can only be picked once."
      ),
  })

export type Bot = typeof bots.$inferSelect
export type NewBot = typeof bots.$inferInsert
export type BotInsert = z.infer<typeof botInsertSchema>
export type TeammateProfileId = (typeof teammateProfileIds)[number]

export type GroupChatInsert = z.infer<typeof groupChatInsertSchema>

export type Chat = typeof chats.$inferSelect
export type NewChat = typeof chats.$inferInsert
export type ChatMember = typeof chatMembers.$inferSelect
export type NewChatMember = typeof chatMembers.$inferInsert
