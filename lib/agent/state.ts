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
  // How many model -> tools round trips have run for this invocation.
  toolTurns: Annotation<number>({
    reducer: replaceValue,
    default: () => 0,
  }),
  error: Annotation<string | undefined>({
    reducer: replaceValue,
    default: () => undefined,
  }),
})

export type AgentStateValue = typeof AgentState.State
export type AgentStateUpdate = typeof AgentState.Update
