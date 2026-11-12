import {
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import { END, START, StateGraph } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"

import { AgentState } from "@/lib/agent/state"
import { agentModel } from "@/lib/agent/model"
import { kubernetesTools } from "@/lib/agent/kubernetes/tools"
import { getTeammateProfile } from "@/lib/teammate-profiles"

// The last N messages as a provider-valid window. Trimming from the front can
// orphan a tool result, so drop leading ToolMessages until the window starts on
// a regular message.
const MAX_HISTORY_MESSAGES = 12
export const MAX_TOOL_TURNS = 6

function recentMessages(
  messages: BaseMessage[],
  limit = MAX_HISTORY_MESSAGES
) {
  const recent = messages.slice(-limit)
  while (recent.length > 0 && recent[0] instanceof ToolMessage) recent.shift()
  return recent
}

const intake = (state: typeof AgentState.State) => {
  if (state.messages.length === 0) {
    return { error: "The agent needs a user message before it can run." }
  }

  return { error: undefined }
}

const callModel = async (state: typeof AgentState.State) => {
  const profile = getTeammateProfile(state.profileId)
  const outOfToolBudget = (state.toolTurns ?? 0) >= MAX_TOOL_TURNS
  const model = outOfToolBudget
    ? agentModel()
    : agentModel().bindTools(kubernetesTools)
  const response = await model.invoke([
    new SystemMessage(
      [
        profile.systemPrompt,
        "Evidence contract: report only facts returned by a successful tool call as observed evidence. Treat every failed or missing tool result as unknown; never fill it with a likely value. Do not claim a node label, taint, selector, event, resource, or scheduling reason unless the relevant returned object contains it. If evidence conflicts, show the conflict and ask for the next safe check. Before proposing a mutation, inspect the exact target and explain the expected effect, risk, and rollback. Only propose these available mutation tools: label_node, remove_deployment_node_selector, or recreate_pod_without_node_selector. If get_deployment returns not found, do not invent a Deployment or call its mutation. For an unmanaged standalone Pod, use recreate_pod_without_node_selector because scheduling fields cannot be edited in place; never claim it can be patched directly. If the user explicitly says proceed, apply, execute, approve, or fix after a proposed option, call the appropriate proposal tool in that same turn and do not ask for a second prose confirmation. The application will display the approval gate. Never propose removing taints, arbitrary fields, or executing shell commands because those actions are not available.",
        state.teammateInstructions?.trim()
          ? `Additional teammate instructions:\n${state.teammateInstructions.trim()}`
          : "",
        outOfToolBudget
          ? "The tool budget for this turn is exhausted. Answer using the evidence you already have and state clearly what remains unverified. Do not call more tools."
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    ),
    ...recentMessages(state.messages),
  ])

  return { messages: [response], error: undefined }
}

const routeAfterModel = (state: typeof AgentState.State) => {
  if ((state.toolTurns ?? 0) >= MAX_TOOL_TURNS) return END

  const lastMessage = state.messages.at(-1)
  return lastMessage instanceof AIMessage &&
    (lastMessage.tool_calls?.length ?? 0) > 0
    ? "tools"
    : END
}

const toolNode = new ToolNode(kubernetesTools)

// Count each model -> tools round trip so a stubborn model cannot loop forever.
const tools = async (state: typeof AgentState.State) => {
  const result = await toolNode.invoke(state)
  return { ...result, toolTurns: (state.toolTurns ?? 0) + 1 }
}

export const agentGraph = new StateGraph(AgentState)
  .addNode("intake", intake)
  .addNode("model", callModel)
  .addNode("tools", tools)
  .addEdge(START, "intake")
  .addEdge("intake", "model")
  .addConditionalEdges("model", routeAfterModel, ["tools", END])
  .addEdge("tools", "model")
  .compile()

export type AgentGraphInput = typeof AgentState.Update
export type AgentGraphOutput = typeof AgentState.State
