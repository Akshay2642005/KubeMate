import { notFound } from "next/navigation"

import { Chat } from "@/components/chat"
import { ChatHeader } from "@/components/chat-header"
import { getBots } from "@/queries/bots"
import { getChat } from "@/queries/chats"

export default async function Page({
  params,
}: {
  params: Promise<{ chatId: string }>
}) {
  const { chatId } = await params
  const chat = await getChat(chatId)
  if (!chat) notFound()

  // A group has several bots and so no single desktop to show
  if (chat.kind === "group") {
    const bots = await getBots()

    return (
      <div className="flex h-svh flex-col">
        <ChatHeader
          chat={chat}
          bots={bots.map(({ id, name, avatar }) => ({ id, name, avatar }))}
        />
        <Chat
          chatId={chat.id}
          initialMessages={chat.messages}
          bots={chat.bots.map(({ id, name, avatar }) => ({ id, name, avatar }))}
        />
      </div>
    )
  }

  return (
    <div className="flex h-svh flex-col">
      <ChatHeader chat={chat} />
      <Chat
        chatId={chat.id}
        initialMessages={chat.messages}
        bots={chat.bots.map(({ id, name, avatar }) => ({ id, name, avatar }))}
      />
    </div>
  )
}
