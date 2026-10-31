import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
} from "ai"

import { db } from "@/db"
import { chatApprovals } from "@/db/schema"
import { agentGraph } from "@/lib/agent/graph"
import type { ActionProposal, ChatUIMessage, ToolLog } from "@/lib/chat-types"
import { messageText, saveMessages } from "@/lib/chat/persistence"
import { getBot } from "@/queries/bots"
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
  for (const message of messages) {
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
        input?: ActionProposal["input"]
      }
      if (
        parsed.kind === "action_proposal" &&
        (parsed.action === "label_node" ||
          parsed.action === "remove_deployment_node_selector" ||
          parsed.action === "recreate_pod_without_node_selector") &&
        parsed.summary &&
        parsed.input
      ) {
        return {
          action: parsed.action,
          summary: parsed.summary,
          input: parsed.input,
        } as ActionProposal
      }
    } catch {
      // Only structured action proposals can enter the approval flow.
    }
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    id?: string
    messages?: ChatUIMessage[]
  }
  const chatId = body.id
  const messages = body.messages ?? []
  if (!chatId || messages.length === 0) {
    return new Response("Chat id and messages are required.", { status: 400 })
  }

  const chat = await getChat(chatId)
  if (!chat) return new Response("Chat not found.", { status: 404 })

  await saveMessages(chatId, messages)
  const botId = messages.at(-1)?.metadata?.botId
  const bot = botId ? await getBot(botId) : undefined
  const graphMessages = toLangChainMessages(messages)

  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      const result = await agentGraph.invoke({
        messages: graphMessages,
        chatId,
        teammateId: bot?.id ?? "",
        profileId: bot?.profileId ?? "custom",
        teammateInstructions: bot?.instructions ?? undefined,
      })
      const lastMessage = result.messages.at(-1)
      const text =
        typeof lastMessage?.content === "string" ? lastMessage.content : ""
      const logs = toolLogs(result.messages)
      const proposal = actionProposal(result.messages)
      const approvalId = proposal
        ? (
            await db
              .insert(chatApprovals)
              .values({ chatId, action: proposal })
              .returning({ id: chatApprovals.id })
          )[0]?.id
        : undefined
      const assistantMessage: ChatUIMessage = {
        id: generateId(),
        role: "assistant",
        metadata: bot ? { botId: bot.id } : undefined,
        parts: [
          ...logs.map((data) => ({ type: "data-tool-log" as const, data })),
          ...(proposal && approvalId
            ? [
                {
                  type: "data-approval-request" as const,
                  data: { ...proposal, approvalId, status: "pending" as const },
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
        writer.write({ type: "data-tool-log", data: log })
      }

      if (proposal && approvalId) {
        writer.write({
          type: "data-approval-request",
          data: { ...proposal, approvalId, status: "pending" },
        })
      }

      if (!text) return

      const id = generateId()
      writer.write({ type: "text-start", id })
      writer.write({ type: "text-delta", id, delta: text })
      writer.write({ type: "text-end", id })
    },
    onError: (error) => {
      console.error("[agent error]", { chatId, error })
      if (/429|rate limit|quota/i.test(String(error))) {
        return "The model provider rate limit was reached. Please wait a moment and try again, or switch to another provider/model."
      }
      return "An error occurred while running the Kubernetes teammate. Check the server logs for details."
    },
  })

  return createUIMessageStreamResponse({ stream })
}
