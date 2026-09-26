import {
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages"
import { END, START, StateGraph } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"

import { AgentState } from "@/lib/agent/state"
import { agentModel } from "@/lib/agent/model"
import { kubernetesTools } from "@/lib/agent/kubernetes/tools"
import { getTeammateProfile } from "@/lib/teammate-profiles"

function messageText(message: BaseMessage | undefined) {
  if (!message) return ""
  if (typeof message.content === "string") return message.content

  return message.content
    .map((part) =>
      typeof part === "string" ? part : "text" in part ? part.text : ""
    )
    .join(" ")
}

function classifyIntent(text: string): "inspect" | "plan" | "change" {
  if (
    /\b(apply|create|delete|patch|remove|restart|rollback|scale|update)\b/i.test(
      text
    )
  ) {
    return "change"
  }

  if (/\b(plan|deploy|optimize|recommend|design|manifest)\b/i.test(text)) {
    return "plan"
  }

  return "inspect"
}

const intake = (state: typeof AgentState.State) => {
  if (state.messages.length === 0) {
    return { error: "The agent needs a user message before it can run." }
  }

  return { error: undefined }
}

const loadTeammate = () => ({
  error: undefined,
})

const classify = (state: typeof AgentState.State) => ({
  intent: classifyIntent(messageText(state.messages.at(-1))),
})

const plan = () => ({
  awaitingApproval: false,
})

const routeAfterPlan = () => "model"

const callModel = async (state: typeof AgentState.State) => {
  const profile = getTeammateProfile(state.profileId)
  const model = agentModel().bindTools(kubernetesTools)
  const response = await model.invoke([
    new SystemMessage(
      [
        profile.systemPrompt,
        "Evidence contract: report only facts returned by a successful tool call as observed evidence. Treat every failed or missing tool result as unknown; never fill it with a likely value. Do not claim a node label, taint, selector, event, resource, or scheduling reason unless the relevant returned object contains it. If evidence conflicts, show the conflict and ask for the next safe check. Before proposing a mutation, inspect the exact target and explain the expected effect, risk, and rollback. Only propose these available mutation tools: label_node, remove_deployment_node_selector, or recreate_pod_without_node_selector. If get_deployment returns not found, do not invent a Deployment or call its mutation. For an unmanaged standalone Pod, use recreate_pod_without_node_selector because scheduling fields cannot be edited in place; never claim it can be patched directly. If the user explicitly says proceed, apply, execute, approve, or fix after a proposed option, call the appropriate proposal tool in that same turn and do not ask for a second prose confirmation. The application will display the approval gate. Never propose removing taints, arbitrary fields, or executing shell commands because those actions are not available.",
        state.teammateInstructions?.trim(),
      ]
        .filter(Boolean)
        .join("\n\nAdditional teammate instructions:\n")
    ),
    ...state.messages.slice(-12),
  ])

  return { messages: [response], error: undefined }
}

const routeAfterModel = (state: typeof AgentState.State) => {
  const lastMessage = state.messages.at(-1)
  return lastMessage instanceof AIMessage &&
    (lastMessage.tool_calls?.length ?? 0) > 0
    ? "tools"
    : "respond"
}

const respond = (state: typeof AgentState.State) => {
  if (!state.awaitingApproval) return {}

  return {
    messages: [
      new AIMessage(
        "This request would change Kubernetes state. Please explicitly approve the proposed action before I execute it."
      ),
    ],
  }
}

const tools = new ToolNode(kubernetesTools)

export const agentGraph = new StateGraph(AgentState)
  .addNode("intake", intake)
  .addNode("loadTeammate", loadTeammate)
  .addNode("classifyIntent", classify)
  .addNode("plan", plan)
  .addNode("model", callModel)
  .addNode("tools", tools)
  .addNode("respond", respond)
  .addEdge(START, "intake")
  .addEdge("intake", "loadTeammate")
  .addEdge("loadTeammate", "classifyIntent")
  .addEdge("classifyIntent", "plan")
  .addConditionalEdges("plan", routeAfterPlan, ["model", "respond"])
  .addConditionalEdges("model", routeAfterModel, ["tools", "respond"])
  .addEdge("tools", "model")
  .addEdge("respond", END)
  .compile()

export type AgentGraphInput = typeof AgentState.Update
export type AgentGraphOutput = typeof AgentState.State
