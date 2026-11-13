"use client"

import { ArrowUp, CheckCircle2, CircleAlert, Clock3, ShieldAlert, Square, XCircle } from "lucide-react"
import { useState, type FormEvent, type KeyboardEvent } from "react"

import { ChatAvatar } from "@/components/chat-avatar"
import { ChatToolCall } from "@/components/chat-tool-call"
import { LiveWorkflowSteps, WorkflowSteps } from "@/components/workflow-steps"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Bot } from "@/db/schema"
import type { ApprovalRequest, ChatUIMessage } from "@/lib/chat-types"
import { useAgentChat } from "@/lib/use-agent-chat"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

type ChatBot = Pick<Bot, "id" | "name" | "avatar">

function findMentionedBots(text: string, bots: ChatBot[]) {
  const normalized = text.toLocaleLowerCase()
  return bots
    .toSorted((a, b) => b.name.length - a.name.length)
    .filter((bot) => normalized.includes(`@${bot.name.toLocaleLowerCase()}`))
    .map((bot) => bot.id)
}

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

// Shows the exact target and change behind an approval, not just the model's
// prose summary, so a reviewer can see what will actually run.
function ApprovalDetails({ data }: { data: ApprovalRequest }) {
  const input = data.input as Record<string, unknown>
  const rows: [string, string][] = [["Action", data.action]]

  // Render every scalar input field so reviewers see the exact target and
  // change for any action, not just the original three.
  const labels: Record<string, string> = {
    namespace: "Namespace",
    node: "Node",
    deployment: "Deployment",
    pod: "Pod",
    name: "Name",
    kind: "Kind",
    apiVersion: "API version",
    key: "Label key",
    value: "Label value",
    replicas: "Replicas",
    gracePeriodSeconds: "Grace period (s)",
    propagationPolicy: "Propagation policy",
    unschedulable: "Unschedulable",
  }
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    if (typeof value === "object") {
      rows.push([labels[key] ?? key, JSON.stringify(value)])
    } else {
      rows.push([labels[key] ?? key, String(value)])
    }
  }

  return (
    <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0 rounded-md border bg-background/70 px-2.5 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {label}
          </dt>
          <dd className="mt-1 truncate font-mono text-xs text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Chat({
  chatId,
  initialMessages,
  bots = [],
}: {
  chatId: string
  initialMessages: ChatUIMessage[]
  bots?: ChatBot[]
}) {
  const {
    messages,
    setMessages,
    status,
    error,
    steps,
    sendMessage,
    stop,
    retry,
  } = useAgentChat({ chatId, initialMessages })
  const [composerText, setComposerText] = useState("")
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionError, setMentionError] = useState<string>()
  const [approvingId, setApprovingId] = useState<string>()

  const busy = status === "submitted" || status === "streaming"

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

  function chooseMention(bot: ChatBot) {
    if (mentionStart < 0) return
    setComposerText(`${composerText.slice(0, mentionStart)}@${bot.name} `)
    setMentionIndex(0)
  }

  function submit() {
    const text = composerText.trim()
    if (!text) return
    const mentionedBotIds = findMentionedBots(text, bots)
    if (bots.length > 1 && mentionedBotIds.length === 0) {
      setMentionError("Mention a teammate with @ before sending.")
      return
    }
    const targetBotId = mentionedBotIds[0] ?? bots[0]?.id
    const metadata = targetBotId
      ? { botId: targetBotId, mentionedBotIds }
      : undefined
    void sendMessage({ text, metadata })
    setComposerText("")
    setMentionIndex(0)
    setMentionError(undefined)
  }

  function handleComposerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    submit()
  }

  async function handleApproval(approvalId: string, approved: boolean) {
    if (approvingId) return
    setApprovingId(approvalId)

    try {
      const response = await fetch("/api/chat/approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId, approvalId, approved }),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => "")
        toast.add({
          type: "error",
          title: approved
            ? "Couldn't apply the change"
            : "Couldn't reject the change",
          description: text || "Something went wrong. Try again.",
        })
        return
      }

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
    } catch {
      toast.add({
        type: "error",
        title: approved
          ? "Couldn't apply the change"
          : "Couldn't reject the change",
        description: "The request could not be sent. Try again.",
      })
    } finally {
      setApprovingId(undefined)
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionStart >= 0 && mentionSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setMentionIndex((index) => (index + 1) % mentionSuggestions.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setMentionIndex(
          (index) =>
            (index - 1 + mentionSuggestions.length) % mentionSuggestions.length
        )
        return
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        chooseMention(mentionSuggestions[mentionIndex])
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setComposerText(composerText.slice(0, mentionStart))
        return
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div data-slot="chat" className="flex min-h-0 flex-1 flex-col">
      <Conversation>
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.flatMap((message) => {
            // The bot a group chat's message was sent to; in a direct
            // chat the tag would just repeat the chat header
            const addressee =
              bots.length > 1 && message.role === "user"
                ? bots.find((bot) => bot.id === message.metadata?.botId)
                : undefined
            const workflow =
              message.role === "assistant" ? message.metadata?.workflow : undefined

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
                    <ChatToolCall key={`${message.id}-${i}-${j}`} log={part.data} />
                  )
                }
                if (part.type === "data-approval-request") {
                  return (
                    <section
                      key={`${message.id}-${i}-${j}`}
                      aria-label="Kubernetes approval request"
                      className="my-4 overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/5 shadow-sm"
                    >
                      <div className="flex items-start gap-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-3">
                        <div className="mt-0.5 rounded-md bg-amber-500/15 p-1.5 text-amber-700 dark:text-amber-300">
                          <ShieldAlert className="size-4" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-medium text-foreground">Approval required</h3>
                          <p className="mt-0.5 text-sm text-muted-foreground">{part.data.summary}</p>
                        </div>
                        <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
                          <Clock3 className="size-3" aria-hidden="true" />
                          {part.data.status === "pending" ? "Needs review" : part.data.status}
                        </span>
                      </div>
                      <div className="px-4 py-3">
                        <ApprovalDetails data={part.data} />
                      {part.data.status === "pending" ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            disabled={approvingId === part.data.approvalId}
                            onClick={() =>
                              void handleApproval(part.data.approvalId, true)
                            }
                          >
                            {approvingId === part.data.approvalId && (
                              <Spinner data-icon="inline-start" />
                            )}
                            Approve and apply
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={approvingId === part.data.approvalId}
                            onClick={() =>
                              void handleApproval(part.data.approvalId, false)
                            }
                          >
                            Reject change
                          </Button>
                        </div>
                      ) : (
                        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                          {part.data.status === "approved" ? (
                            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                          ) : part.data.status === "failed" ? (
                            <CircleAlert className="size-4 text-destructive" />
                          ) : (
                            <XCircle className="size-4" />
                          )}
                          <span>
                            {part.data.status === "approved"
                              ? "Applied and verified"
                              : part.data.status === "failed"
                                ? "Application or verification failed"
                                : "Change rejected"}
                          </span>
                        </div>
                      )}
                      </div>
                    </section>
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
                    {workflow ? <WorkflowSteps steps={workflow} /> : null}
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
          <div className="absolute inset-x-4 bottom-full z-10 mb-2 overflow-hidden rounded-lg border bg-popover p-1 shadow-lg">
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
        {status === "error" && error ? (
          <div
            role="alert"
            className="mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              onClick={retry}
              className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
            >
              Try again
            </button>
          </div>
        ) : mentionError ? (
          <div className="mb-2 text-xs text-destructive">{mentionError}</div>
        ) : null}
        <LiveWorkflowSteps status={status} steps={steps} />
        <form
          onSubmit={handleComposerSubmit}
          className="flex items-end gap-2 rounded-2xl border bg-background p-2 transition-colors focus-within:border-ring"
        >
          <textarea
            value={composerText}
            onChange={(event) => {
              setComposerText(event.currentTarget.value)
              setMentionIndex(0)
            }}
            onKeyDown={handleComposerKeyDown}
            rows={1}
            placeholder={
              bots.length > 1
                ? "Message with @ — the first mentioned teammate replies"
                : `Message ${bots[0]?.name ?? "your teammate"}…`
            }
            aria-label="Message"
            className="field-sizing-content max-h-40 min-h-6 w-full resize-none overflow-y-auto border-0 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              aria-label="Stop generating"
              title="Stop generating"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85"
            >
              <Square className="size-3 fill-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!composerText.trim()}
              aria-label="Send message"
              title="Send message"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-30"
            >
              <ArrowUp className="size-4" aria-hidden="true" />
            </button>
          )}
        </form>
      </div>
    </div>
  )
}

export { Chat }
