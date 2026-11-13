import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import { EventEncoder } from "@ag-ui/encoder"
import {
  EventType,
  PROTOCOL_VERSION,
  type Event as AGEvent,
} from "@ag-ui/core"
import { generateId } from "ai"

import { db } from "@/db"
import { chatApprovals } from "@/db/schema"
import { agentGraph, MAX_TOOL_TURNS } from "@/lib/agent/graph"
import type {
  AgentRunState,
  ChatUIMessage,
  ToolLog,
  WorkflowStep,
} from "@/lib/chat-types"
import { messageText, saveMessages } from "@/lib/chat/persistence"
import { actionProposalSchema } from "@/lib/agent/kubernetes/proposals"
import { isRunner, proxyToRunner } from "@/lib/runner"
import { MAX_CHAT_BODY_BYTES, rateLimit } from "@/lib/rate-limit"
import { getChat } from "@/queries/chats"

function toLangChainMessages(messages: ChatUIMessage[]): BaseMessage[] {
  return messages
    .map<BaseMessage | undefined>((message) => {
      const text = messageText(message)
      if (!text) return undefined

      return message.role === "user"
        ? new HumanMessage(text)
        : new AIMessage(text)
    })
    .filter((message): message is BaseMessage => message !== undefined)
}

// AG-UI carries message content as a string or as typed content parts. We
// only accept text; media parts are ignored for this text-only agent.
function agUiMessageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((part) =>
      part && typeof part === "object" && part.type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
        ? ((part as { text: string }).text ?? "")
        : ""
    )
    .join("")
}

// The client may offer metadata, but nothing about it is trusted beyond
// narrow string/string[] shapes.
function readMetadata(value: unknown): {
  botId?: string
  mentionedBotIds?: string[]
} {
  if (!value || typeof value !== "object") return {}

  const record = value as Record<string, unknown>
  const botId = typeof record.botId === "string" ? record.botId : undefined
  const mentionedBotIds = Array.isArray(record.mentionedBotIds)
    ? record.mentionedBotIds.filter(
      (id): id is string => typeof id === "string"
    )
    : undefined

  return { botId, mentionedBotIds }
}

function toolLogs(messages: BaseMessage[]): ToolLog[] {
  const results = new Map(
    messages
      .filter(
        (message): message is ToolMessage => message instanceof ToolMessage
      )
      .map((message) => [message.tool_call_id, message])
  )

  return messages.flatMap((message) => {
    if (!(message instanceof AIMessage)) return []

    return (message.tool_calls ?? []).flatMap((call) => {
      if (!call.id) return []
      const result = results.get(call.id)
      const output = result?.content
      return [
        {
          tool: call.name,
          input: call.args,
          ...(result?.status === "error"
            ? { error: String(output ?? "Tool execution failed") }
            : {}),
          ...(output === undefined ? {} : { output }),
        },
      ]
    })
  })
}

function actionProposal(messages: BaseMessage[]) {
  // Scan from the most recent turn backwards so a stale proposal from an earlier
  // exchange never triggers a new approval.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (
      !(message instanceof ToolMessage) ||
      typeof message.content !== "string"
    )
      continue

    try {
      const parsed = JSON.parse(message.content) as {
        kind?: string
        action?: string
        summary?: string
        input?: unknown
      }
      if (parsed.kind !== "action_proposal") continue

      // The same discriminated schema validates tool output here and the
      // stored proposal at execution time, so only real actions can mint an
      // approval card.
      const proposal = actionProposalSchema.safeParse({
        action: parsed.action,
        summary: parsed.summary,
        input: parsed.input,
      })
      if (proposal.success) return proposal.data
    } catch {
      // Only structured action proposals can enter the approval flow.
    }
  }
}

function friendlyAgentError(error: unknown) {
  if (/429|rate limit|quota/i.test(String(error))) {
    return "The model provider rate limit was reached. Please wait a moment and try again, or switch to another provider/model."
  }

  return "An error occurred while running the Kubernetes teammate. Check the server logs for details."
}

export async function POST(request: Request) {
  const raw = await request.text()
  if (raw.length > MAX_CHAT_BODY_BYTES) {
    return new Response("Request body is too large.", { status: 413 })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Response("Request body must be valid JSON.", { status: 400 })
  }

  // The request body is an AG-UI RunAgentInput: threadId is the chat id, the
  // run id identifies this particular run (and doubles as the assistant
  // message id so client and server agree on it), and only the last message
  // is honoured — history is always read back from the database.
  const body = parsed as {
    id?: string
    threadId?: string
    runId?: string
    messages?: Array<Record<string, unknown>>
  }
  const chatId =
    typeof body.threadId === "string" && body.threadId
      ? body.threadId
      : body.id

  // Per-chat quota guard, enforced before the runner (or this process) does
  // any work, so neither path can burn model quota in a tight loop. The
  // runner counts the same traffic again, which is fine: both allow 20.
  if (chatId) {
    const verdict = rateLimit(`chat:${chatId}`, 20, 10 * 60 * 1000)
    if (!verdict.ok) {
      return new Response(
        "Too many messages sent for this chat. Try again shortly.",
        {
          status: 429,
          headers: { "retry-after": String(verdict.retryAfter) },
        }
      )
    }
  }

  // The web deployment has no ServiceAccount token; it forwards agent calls
  // to the runner over the cluster network instead of executing them itself.
  if (!isRunner()) return proxyToRunner("/api/chat", raw, request.signal)

  const messages = Array.isArray(body.messages) ? body.messages : undefined
  if (!chatId || !messages || messages.length === 0) {
    return new Response("Chat id and messages are required.", { status: 400 })
  }

  const newMessage = messages.at(-1)
  if (!newMessage || newMessage.role !== "user") {
    return new Response("The last message must be a user message.", {
      status: 400,
    })
  }

  const userText = agUiMessageText(newMessage.content)
  if (!userText.trim()) {
    return new Response("The message must include text.", { status: 400 })
  }

  const newMessageMetadata = readMetadata(newMessage.metadata)

  const chat = await getChat(chatId)
  if (!chat) return new Response("Chat not found.", { status: 404 })

  // Resolve the responder from this chat's members instead of trusting the
  // client. A group message must name one of its members; a direct chat falls
  // back to its only bot.
  const requestedBotId = newMessageMetadata.botId
  const bot = requestedBotId
    ? chat.bots.find((member) => member.id === requestedBotId)
    : chat.kind === "direct"
      ? chat.bots[0]
      : undefined

  if (!bot) {
    return new Response(
      requestedBotId
        ? "That bot is not a member of this chat."
        : "Mention a teammate that is a member of this chat.",
      { status: 400 }
    )
  }

  // Drop any optimistic copy of this message from the persisted history, then
  // append the authoritative one.
  const clientMessageId =
    typeof newMessage.id === "string" && newMessage.id.length <= 200
      ? newMessage.id
      : generateId()
  const mentionedBotIds = newMessageMetadata.mentionedBotIds
  const userMessage: ChatUIMessage = {
    id: clientMessageId,
    role: "user",
    metadata: { botId: bot.id, mentionedBotIds },
    parts: [{ type: "text", text: userText }],
  }
  const history = chat.messages.filter((message) => message.id !== userMessage.id)
  await saveMessages(chatId, [userMessage])
  const graphMessages = toLangChainMessages([...history, userMessage])

  const runId =
    typeof body.runId === "string" &&
      body.runId.length > 0 &&
      body.runId.length <= 200
      ? body.runId
      : generateId()
  const assistantMessageId = runId

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const agUiEncoder = new EventEncoder()
      const send = (event: AGEvent) => {
        controller.enqueue(
          encoder.encode(agUiEncoder.encode(event))
        )
      }

      const accumulated: BaseMessage[] = []
      const workflow: WorkflowStep[] = []
      const openSteps = new Set<string>()
      const callsByIndex = new Map<number, string>()
      const callsById = new Set<string>()
      let currentTextId: string | undefined
      let toolTurns = 0
      let approvalMinted = false
      let approval: AgentRunState["approvalRequest"] | undefined

      const stepStarted = (stepName: string) => {
        openSteps.add(stepName)
        workflow.push(stepName)
        send({ type: EventType.STEP_STARTED, stepName })
      }
      const stepFinished = (stepName: string) => {
        if (openSteps.delete(stepName)) {
          send({ type: EventType.STEP_FINISHED, stepName })
        }
      }
      const closeOpenSteps = () => {
        for (const stepName of [...openSteps]) stepFinished(stepName)
      }
      const closeTextMessage = () => {
        if (currentTextId) {
          send({ type: EventType.TEXT_MESSAGE_END, messageId: currentTextId })
          currentTextId = undefined
        }
      }
      const emitSnapshot = () => {
        const snapshot: AgentRunState = {
          toolLogs: toolLogs(accumulated),
          ...(approval ? { approvalRequest: approval } : {}),
          workflow: [...workflow],
          assistantMessageId,
        }
        send({ type: EventType.STATE_SNAPSHOT, snapshot })
      }

      send({
        type: EventType.RUN_STARTED,
        threadId: chatId,
        runId,
        protocolVersion: PROTOCOL_VERSION,
      })
      stepStarted("intake")

      try {
        const graphStream = await agentGraph.stream(
          {
            messages: graphMessages,
            chatId,
            teammateId: bot.id,
            profileId: bot.profileId ?? "custom",
            teammateInstructions: bot.instructions ?? undefined,
          },
          { streamMode: ["messages", "updates"], signal: request.signal }
        )

        for await (const chunk of graphStream) {
          if (request.signal.aborted) break
          const [mode, payload] = chunk as [string, unknown]

          if (mode === "messages" && Array.isArray(payload)) {
            const [message] = payload as [BaseMessage, unknown?]
            if (message instanceof AIMessageChunk) {
              const text =
                typeof message.content === "string" ? message.content : ""
              if (text.length > 0) {
                if (!currentTextId) {
                  currentTextId = `text_${generateId()}`
                  send({
                    type: EventType.TEXT_MESSAGE_START,
                    messageId: currentTextId,
                    role: "assistant",
                  })
                }
                send({
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: currentTextId,
                  delta: text,
                })
              }
              for (const toolCallChunk of message.tool_call_chunks ?? []) {
                const index = toolCallChunk.index ?? 0
                if (toolCallChunk.id) callsByIndex.set(index, toolCallChunk.id)
                const toolCallId = callsByIndex.get(index) ?? toolCallChunk.id
                if (!toolCallId) continue
                if (toolCallChunk.name && !callsById.has(toolCallId)) {
                  callsById.add(toolCallId)
                  send({
                    type: EventType.TOOL_CALL_START,
                    toolCallId,
                    toolCallName: toolCallChunk.name,
                    parentMessageId: currentTextId,
                  })
                }
                if (toolCallChunk.args) {
                  send({
                    type: EventType.TOOL_CALL_ARGS,
                    toolCallId,
                    delta: toolCallChunk.args,
                  })
                }
              }
            } else if (message instanceof ToolMessage) {
              send({
                type: EventType.TOOL_CALL_RESULT,
                messageId: `tool_${generateId()}`,
                toolCallId: message.tool_call_id,
                content:
                  typeof message.content === "string"
                    ? message.content
                    : JSON.stringify(message.content),
              })
            }
            continue
          }

          if (mode === "updates" && payload && typeof payload === "object") {
            const updates = payload as Record<
              string,
              { messages?: BaseMessage[] } | undefined
            >

            if ("intake" in updates) {
              stepFinished("intake")
              stepStarted("model")
            }

            if ("model" in updates) {
              closeTextMessage()
              const modelMessages = updates.model?.messages ?? []
              accumulated.push(...modelMessages)
              const last = modelMessages.at(-1)
              const calls =
                last instanceof AIMessage ? (last.tool_calls ?? []) : []
              for (const call of calls) {
                if (!call.id) continue
                if (!callsById.has(call.id)) {
                  callsById.add(call.id)
                  send({
                    type: EventType.TOOL_CALL_START,
                    toolCallId: call.id,
                    toolCallName: call.name ?? "unknown_tool",
                  })
                  send({
                    type: EventType.TOOL_CALL_ARGS,
                    toolCallId: call.id,
                    delta: JSON.stringify(call.args ?? {}),
                  })
                }
                send({ type: EventType.TOOL_CALL_END, toolCallId: call.id })
              }
              stepFinished("model")
              if (calls.length > 0 && toolTurns < MAX_TOOL_TURNS) {
                stepStarted("tools")
              }
            }

            if ("tools" in updates) {
              const toolMessages = updates.tools?.messages ?? []
              accumulated.push(...toolMessages)
              toolTurns += 1
              stepFinished("tools")
              stepStarted("model")
              if (!approvalMinted) {
                const proposal = actionProposal(accumulated)
                if (proposal) {
                  const inserted = await db
                    .insert(chatApprovals)
                    .values({ chatId, action: proposal })
                    .returning({ id: chatApprovals.id })
                  if (inserted[0]?.id) {
                    approval = {
                      ...proposal,
                      approvalId: inserted[0].id,
                      status: "pending",
                    }
                    approvalMinted = true
                  }
                }
              }
              emitSnapshot()
            }
          }
        }

        if (request.signal.aborted) {
          closeTextMessage()
          closeOpenSteps()
          send({
            type: EventType.RUN_FINISHED,
            threadId: chatId,
            runId,
            outcome: { type: "cancelled" },
          })
          controller.close()
          return
        }

        closeTextMessage()
        closeOpenSteps()
        if (!approvalMinted) {
          const proposal = actionProposal(accumulated)
          if (proposal) {
            const inserted = await db
              .insert(chatApprovals)
              .values({ chatId, action: proposal })
              .returning({ id: chatApprovals.id })
            if (inserted[0]?.id) {
              approval = {
                ...proposal,
                approvalId: inserted[0].id,
                status: "pending",
              }
              approvalMinted = true
            }
          }
        }

        const logs = toolLogs(accumulated)
        const lastAssistant = [...accumulated]
          .reverse()
          .find((message) => message instanceof AIMessage) as
          | AIMessage
          | undefined
        let text =
          lastAssistant && typeof lastAssistant.content === "string"
            ? lastAssistant.content
            : ""

        // The approval card is the only approval request. Do not duplicate
        // the model's prose asking the user to approve the same proposal.
        if (approval) {
          text = "Review the approval card below to authorize this change."
        }

      const assistantMessage: ChatUIMessage = {
          id: assistantMessageId,
          role: "assistant",
          metadata: { botId: bot.id, workflow: [...workflow] },
          parts: [
            ...logs.map((data) => ({ type: "data-tool-log" as const, data })),
            ...(approval
              ? [
                {
                  type: "data-approval-request" as const,
                  data: { ...approval, status: "pending" as const },
                },
              ]
              : []),
            ...(text ? [{ type: "text" as const, text }] : []),
          ],
        }

        await saveMessages(chatId, [assistantMessage])
        for (const log of logs) {
          console.info("[agent tool]", {
            chatId,
            tool: log.tool,
            input: log.input,
            failed: Boolean(log.error),
          })
        }

        emitSnapshot()
        send({ type: EventType.RUN_FINISHED, threadId: chatId, runId })
        controller.close()
      } catch (error) {
        console.error("[agent error]", { chatId, error })
        closeTextMessage()
        closeOpenSteps()
        send({
          type: EventType.RUN_ERROR,
          message: friendlyAgentError(error),
          code: "agent_error",
        })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}
