"use client"

import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { useState, type KeyboardEvent } from "react"

import { ChatAvatar } from "@/components/chat-avatar"
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Bot } from "@/db/schema"
import type { ChatUIMessage } from "@/lib/chat-types"

type ChatBot = Pick<Bot, "id" | "name" | "avatar">

function findMentionedBots(text: string, bots: ChatBot[]) {
  const normalized = text.toLocaleLowerCase()
  return bots
    .toSorted((a, b) => b.name.length - a.name.length)
    .filter((bot) => normalized.includes(`@${bot.name.toLocaleLowerCase()}`))
    .map((bot) => bot.id)
}

// A group chat passes bots so assistant messages can be shown with the selected
// teammate's face.
function splitByAuthor(message: ChatUIMessage, bots: ChatBot[]) {
  const findBot = (botId?: string) => bots.find((bot) => bot.id === botId)

  const section = {
    author:
      message.role === "assistant"
        ? findBot(message.metadata?.botId)
        : undefined,
    parts: [] as ChatUIMessage["parts"],
  }
  const sections = [section]

  for (const part of message.parts) {
    section.parts.push(part)
  }

  return sections
}

// `bots` are a group chat's members to pick from; a direct chat passes none
function Chat({
  chatId,
  initialMessages,
  bots,
}: {
  chatId: string
  initialMessages: ChatUIMessage[]
  bots?: ChatBot[]
}) {
  return (
    <ChatMessages
      key={chatId}
      chatId={chatId}
      initialMessages={initialMessages}
      bots={bots}
    />
  )
}

function ChatMessages({
  chatId,
  initialMessages,
  bots = [],
}: {
  chatId: string
  initialMessages: ChatUIMessage[]
  bots?: ChatBot[]
}) {
  const { messages, sendMessage, setMessages, status, stop } =
    useChat<ChatUIMessage>({
      id: chatId,
      messages: initialMessages,
      transport: new DefaultChatTransport({ api: "/api/chat" }),
    })
  const [composerText, setComposerText] = useState("")
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionError, setMentionError] = useState<string>()

  const mentionStart = (() => {
    const at = composerText.lastIndexOf("@")
    if (at < 0 || (at > 0 && !/\s/.test(composerText[at - 1]))) return -1
    return at
  })()
  const mentionQuery =
    mentionStart >= 0 ? composerText.slice(mentionStart + 1) : ""
  const mentionSuggestions =
    bots.length > 1 && mentionStart >= 0
      ? bots.filter((bot) =>
          bot.name
            .toLocaleLowerCase()
            .startsWith(mentionQuery.toLocaleLowerCase())
        )
      : []

  function handleSubmit(message: PromptInputMessage) {
    if (!message.text.trim()) return
    const mentionedBotIds = findMentionedBots(message.text, bots)
    if (bots.length > 1 && mentionedBotIds.length === 0) {
      setMentionError("Mention a teammate with @ before sending.")
      return
    }
    const targetBotId = mentionedBotIds[0] ?? bots[0]?.id
    const metadata = targetBotId
      ? { botId: targetBotId, mentionedBotIds }
      : undefined
    sendMessage({ text: message.text, metadata }, { metadata })
    setComposerText("")
    setMentionIndex(0)
    setMentionError(undefined)
  }

  function chooseMention(bot: ChatBot) {
    if (mentionStart < 0) return
    setComposerText(`${composerText.slice(0, mentionStart)}@${bot.name} `)
    setMentionIndex(0)
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionStart < 0 || mentionSuggestions.length === 0) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setMentionIndex((index) => (index + 1) % mentionSuggestions.length)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setMentionIndex(
        (index) =>
          (index - 1 + mentionSuggestions.length) % mentionSuggestions.length
      )
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      chooseMention(mentionSuggestions[mentionIndex])
    } else if (event.key === "Escape") {
      event.preventDefault()
      setComposerText(composerText.slice(0, mentionStart))
    }
  }

  async function handleApproval(approvalId: string, approved: boolean) {
    const response = await fetch("/api/chat/approval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId, approvalId, approved }),
    })
    if (!response.ok) return
    const body = (await response.json()) as { message: ChatUIMessage }
    const result = body.message.parts.find(
      (part) => part.type === "data-approval-result"
    )
    setMessages((current) => [
      ...current.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === "data-approval-request" &&
          result?.type === "data-approval-result" &&
          part.data.approvalId === result.data.approvalId
            ? { ...part, data: { ...part.data, status: result.data.status } }
            : part
        ),
      })),
      body.message,
    ])
  }

  return (
    <div data-slot="chat" className="flex min-h-0 flex-1 flex-col">
      <Conversation>
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.flatMap((message) => {
            // The bot a group chat's message was sent to
            const addressee =
              message.role === "user"
                ? bots.find((bot) => bot.id === message.metadata?.botId)
                : undefined

            return splitByAuthor(message, bots).map(({ author, parts }, i) => {
              const renderedParts = parts.map((part, j) => {
                if (part.type === "text") {
                  return (
                    <MessageResponse
                      key={`${message.id}-${i}-${j}`}
                      // Flows the first paragraph inline, right after the tag
                      className={
                        addressee && j === 0
                          ? "inline [&>p:first-child]:inline"
                          : undefined
                      }
                    >
                      {part.text}
                    </MessageResponse>
                  )
                }
                if (part.type === "data-tool-log") {
                  return (
                    <details
                      key={`${message.id}-${i}-${j}`}
                      className="my-2 rounded-md border bg-muted/30 text-xs"
                    >
                      <summary className="cursor-pointer px-3 py-2 font-medium text-muted-foreground">
                        {part.data.error
                          ? `Tool failed: ${part.data.tool}`
                          : `Tool: ${part.data.tool}`}
                      </summary>
                      <pre className="max-h-72 overflow-auto border-t p-3 whitespace-pre-wrap text-muted-foreground">
                        {JSON.stringify(
                          {
                            input: part.data.input,
                            output: part.data.output,
                            error: part.data.error,
                          },
                          null,
                          2
                        )}
                      </pre>
                    </details>
                  )
                }
                if (part.type === "data-approval-request") {
                  return (
                    <div
                      key={`${message.id}-${i}-${j}`}
                      className="my-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                    >
                      <div className="font-medium">Approval required</div>
                      <div className="mt-1 text-muted-foreground">
                        {part.data.summary}
                      </div>
                      {part.data.status === "pending" ? (
                        <div className="mt-3 flex gap-2">
                          <Button
                            size="sm"
                            onClick={() =>
                              void handleApproval(part.data.approvalId, true)
                            }
                          >
                            Approve change
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void handleApproval(part.data.approvalId, false)
                            }
                          >
                            Reject
                          </Button>
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-muted-foreground uppercase">
                          {part.data.status}
                        </div>
                      )}
                    </div>
                  )
                }
                if (part.type === "data-approval-result") {
                  return null
                }
                return null
              })

              return (
                <Message
                  from={message.role}
                  key={`${message.id}-${i}`}
                  className={author && "flex-row items-start"}
                >
                  {author && (
                    <ChatAvatar seed={author.avatar} className="size-6" />
                  )}
                  <MessageContent>
                    {addressee ? (
                      // One block, so the tag and the text share a line and the text wraps under it
                      <div>
                        <Badge
                          variant="outline"
                          className="mr-1.5 max-w-40 pl-1 align-top"
                        >
                          <ChatAvatar
                            seed={addressee.avatar}
                            className="size-3.5"
                          />
                          <span className="truncate">{addressee.name}</span>
                        </Badge>
                        {renderedParts}
                      </div>
                    ) : (
                      renderedParts
                    )}
                  </MessageContent>
                </Message>
              )
            })
          })}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="relative mx-auto w-full max-w-3xl p-4 pt-0">
        {mentionSuggestions.length > 0 && (
          <div className="absolute inset-x-4 bottom-full mb-2 overflow-hidden rounded-lg border bg-popover p-1 shadow-lg">
            {mentionSuggestions.map((bot, index) => (
              <button
                key={bot.id}
                type="button"
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm ${
                  index === mentionIndex ? "bg-accent" : "hover:bg-accent/60"
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseMention(bot)}
              >
                <ChatAvatar seed={bot.avatar} className="size-5" />
                <span>{bot.name}</span>
              </button>
            ))}
          </div>
        )}
        {mentionError && (
          <div className="mb-2 text-xs text-destructive">{mentionError}</div>
        )}
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea
            value={composerText}
            onChange={(event) => {
              setComposerText(event.currentTarget.value)
              setMentionIndex(0)
            }}
            onKeyDownCapture={handleComposerKeyDown}
            placeholder={
              bots.length > 1
                ? "Send a message or mention a teammate with @..."
                : "Send a message..."
            }
          />
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit status={status} onStop={stop} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

export { Chat }
