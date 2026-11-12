import { PlusIcon } from "lucide-react"
import { redirect } from "next/navigation"

import { BotDialog } from "@/components/bot-dialog"
import { ChatAvatar } from "@/components/chat-avatar"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { getChats } from "@/queries/bots"

export default async function Page() {
  // Returning users should land in their most recent conversation.
  const [latestChat] = await getChats()
  if (latestChat) redirect(`/chats/${latestChat.id}`)

  return (
    <div className="flex min-h-svh p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia>
            <ChatAvatar seed={crypto.randomUUID()} className="size-10" />
          </EmptyMedia>
          <EmptyTitle>Meet your first bot</EmptyTitle>
          <EmptyDescription>
            Every bot gets its own personality, memory, and face. Spin one up
            and start the conversation.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <BotDialog>
            <PlusIcon data-icon="inline-start" />
            Create a new bot
          </BotDialog>
        </EmptyContent>
      </Empty>
    </div>
  )
}
