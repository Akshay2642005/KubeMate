"use client"

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react"
import { generateId } from "ai"
import {
  EventType,
  PROTOCOL_VERSION,
  type Event as AGEvent,
  type RunAgentInput,
} from "@ag-ui/core"

import type {
  AgentRunState,
  ChatUIMessage,
  ToolLog,
  WorkflowStep,
} from "@/lib/chat-types"

export type AgentChatStatus = "ready" | "submitted" | "streaming" | "error"

export type LiveStep = { name: string; status: "active" | "done" }

type SendMessageInput = {
  text: string
  metadata?: { botId?: string; mentionedBotIds?: string[] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AGEvent) => void
) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  const flushFrame = (frame: string) => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data) continue
      try {
        onEvent(JSON.parse(data) as AGEvent)
      } catch {
        // An unparseable frame must not kill the run; skip it.
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf("\n\n")
    while (index !== -1) {
      flushFrame(buffer.slice(0, index))
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf("\n\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) flushFrame(buffer)
}

function appendTextDelta(parts: ChatUIMessage["parts"], delta: string) {
  const last = parts.at(-1)
  if (last?.type === "text") {
    return [...parts.slice(0, -1), { ...last, text: last.text + delta }]
  }

  return [...parts, { type: "text" as const, text: delta }]
}

function toolLogPart(data: ToolLog): ChatUIMessage["parts"][number] {
  return { type: "data-tool-log", data }
}

function applySnapshot(
  message: ChatUIMessage,
  snapshot: AgentRunState
): ChatUIMessage {
  const toolLogCount = message.parts.filter(
    (part) => part.type === "data-tool-log"
  ).length
  const missing = Array.isArray(snapshot.toolLogs)
    ? snapshot.toolLogs.slice(toolLogCount)
    : []

  const parts = [...message.parts, ...missing.map(toolLogPart)]
  const hasApprovalRequest = parts.some(
    (part) => part.type === "data-approval-request"
  )
  if (snapshot.approvalRequest && !hasApprovalRequest) {
    parts.push({ type: "data-approval-request", data: snapshot.approvalRequest })
  }

  const metadata = {
    ...message.metadata,
    ...(Array.isArray(snapshot.workflow)
      ? { workflow: snapshot.workflow as WorkflowStep[] }
      : {}),
  }

  return { ...message, metadata, parts }
}

export function useAgentChat({
  chatId,
  initialMessages,
}: {
  chatId: string
  initialMessages: ChatUIMessage[]
}) {
  const [messages, setMessages] = useState<ChatUIMessage[]>(initialMessages)
  const [status, setStatus] = useState<AgentChatStatus>("ready")
  const [error, setError] = useState<string>()
  const [steps, setSteps] = useState<LiveStep[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const assistantIdRef = useRef<string | null>(null)
  const assistantMetaRef = useRef<ChatUIMessage["metadata"]>(undefined)
  const failedTextRef = useRef<string | null>(null)

  const updateAssistant = useCallback(
    (
      update: (message: ChatUIMessage) => ChatUIMessage,
      fallbackParts: ChatUIMessage["parts"] = []
    ) => {
      const assistantId = assistantIdRef.current
      if (!assistantId) return

      setMessages((current) => {
        const exists = current.some((message) => message.id === assistantId)
        if (exists) {
          return current.map((message) =>
            message.id === assistantId ? update(message) : message
          )
        }

        return [
          ...current,
          update({
            id: assistantId,
            role: "assistant",
            metadata: assistantMetaRef.current,
            parts: fallbackParts,
          }),
        ]
      })
    },
    []
  )

  const handleEvent = useCallback(
    (event: AGEvent) => {
      switch (event.type) {
        case EventType.TEXT_MESSAGE_CONTENT:
          updateAssistant((message) => ({
            ...message,
            parts: appendTextDelta(message.parts, event.delta),
          }))
          break
        case EventType.STATE_SNAPSHOT: {
          const snapshot = event.snapshot
          if (!isRecord(snapshot)) return
          updateAssistant((message) =>
            applySnapshot(message, snapshot as unknown as AgentRunState)
          )
          break
        }
        case EventType.STEP_STARTED:
          setSteps((current) => [
            ...current,
            { name: event.stepName, status: "active" },
          ])
          break
        case EventType.STEP_FINISHED:
          setSteps((current) => {
            // Mark the most recent active step with this name as done.
            for (let index = current.length - 1; index >= 0; index--) {
              if (
                current[index].name === event.stepName &&
                current[index].status === "active"
              ) {
                return current.map((step, i) =>
                  i === index ? { ...step, status: "done" } : step
                )
              }
            }
            return [...current, { name: event.stepName, status: "done" }]
          })
          break
        case EventType.RUN_FINISHED:
          setSteps((current) =>
            current.map((step) => ({ ...step, status: "done" as const }))
          )
          setStatus("ready")
          break
        case EventType.RUN_ERROR:
          setStatus("error")
          setError(event.message)
          break
        default:
          break
      }
    },
    [updateAssistant]
  )

  const sendMessage = useCallback(
    async ({ text, metadata }: SendMessageInput) => {
      const trimmed = text.trim()
      if (!trimmed) return

      const runId = generateId()
      assistantIdRef.current = runId
      assistantMetaRef.current = metadata
      failedTextRef.current = null

      const userMessage: ChatUIMessage = {
        id: generateId(),
        role: "user",
        ...(metadata ? { metadata } : {}),
        parts: [{ type: "text", text: trimmed }],
      }
      const input: RunAgentInput = {
        threadId: chatId,
        runId,
        protocolVersion: PROTOCOL_VERSION,
        messages: [
          {
            id: userMessage.id,
            role: "user",
            content: trimmed,
            ...(metadata ? { metadata } : {}),
          },
        ],
        tools: [],
        context: [],
        forwardedProps: metadata ?? {},
      }

      setMessages((current) => [...current, userMessage])
      setStatus("submitted")
      setError(undefined)
      setSteps([])

      const controller = new AbortController()
      abortRef.current = controller
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        })
        if (!response.ok) {
          const body = await response.text().catch(() => "")
          throw new Error(
            body || `The request failed with status ${response.status}.`
          )
        }
        if (!response.body) {
          throw new Error("The server returned an empty response.")
        }

        setStatus("streaming")
        await readEventStream(response.body, handleEvent)
        setStatus((current) => (current === "error" ? current : "ready"))
      } catch (cause) {
        if (controller.signal.aborted) return
        failedTextRef.current = trimmed
        setStatus("error")
        setError(
          cause instanceof Error
            ? cause.message
            : "Something went wrong. Please try again."
        )
      } finally {
        abortRef.current = null
      }
    },
    [chatId, handleEvent]
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStatus("ready")
  }, [])

  const retry = useCallback(() => {
    const text = failedTextRef.current
    if (text) void sendMessage({ text, metadata: assistantMetaRef.current })
  }, [sendMessage])

  return {
    messages,
    setMessages,
    status,
    error,
    steps,
    sendMessage,
    stop,
    retry,
  }
}

export type UseAgentChat = ReturnType<typeof useAgentChat>
export type AgentChatSetMessages = Dispatch<SetStateAction<ChatUIMessage[]>>
