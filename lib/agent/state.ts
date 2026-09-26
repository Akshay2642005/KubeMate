import type { BaseMessage } from "@langchain/core/messages"
import { Annotation, messagesStateReducer } from "@langchain/langgraph"

import type { TeammateProfileId } from "@/db/schema"

const replaceValue = <T>(_current: T, next: T) => next

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  chatId: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  teammateId: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  profileId: Annotation<TeammateProfileId>({
    reducer: replaceValue,
    default: () => "custom",
  }),
  teammateInstructions: Annotation<string | undefined>({
    reducer: replaceValue,
    default: () => undefined,
  }),
  namespace: Annotation<string | undefined>({
    reducer: replaceValue,
    default: () => undefined,
  }),
  intent: Annotation<"inspect" | "plan" | "change">({
    reducer: replaceValue,
    default: () => "inspect",
  }),
  awaitingApproval: Annotation<boolean>({
    reducer: replaceValue,
    default: () => false,
  }),
  lastToolName: Annotation<string | undefined>({
    reducer: replaceValue,
    default: () => undefined,
  }),
  lastToolResult: Annotation<string | undefined>({
    reducer: replaceValue,
    default: () => undefined,
  }),
  error: Annotation<string | undefined>({
    reducer: replaceValue,
    default: () => undefined,
  }),
})

export type AgentStateValue = typeof AgentState.State
export type AgentStateUpdate = typeof AgentState.Update
