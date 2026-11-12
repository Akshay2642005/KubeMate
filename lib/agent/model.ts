import { ChatOpenAI } from "@langchain/openai"

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function maxTokensFromEnv() {
  const value = Number(process.env.AI_MAX_TOKENS ?? 1200)
  return Number.isFinite(value) && value > 0 ? value : 1200
}

export function agentModel() {
  const provider = process.env.AI_PROVIDER ?? "groq"
  const maxTokens = maxTokensFromEnv()

  if (provider === "openrouter") {
    return new ChatOpenAI({
      apiKey: requiredEnv("OPENROUTER__API_KEY"),
      model: requiredEnv("OPENROUTER__MODEL"),
      maxTokens,
      maxRetries: 0,
      configuration: { baseURL: "https://openrouter.ai/api/v1" },
    })
  }

  if (provider === "groq") {
    return new ChatOpenAI({
      apiKey: requiredEnv("GROQ__API_KEY"),
      model: requiredEnv("GROQ__MODEL"),
      maxTokens,
      maxRetries: 0,
      configuration: { baseURL: "https://api.groq.com/openai/v1" },
    })
  }

  if (provider === "nvidia") {
    return new ChatOpenAI({
      apiKey: requiredEnv("NVIDIA__API_KEY"),
      model: requiredEnv("NVIDIA__CHAT_MODEL"),
      maxTokens,
      maxRetries: 0,
      configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
    })
  }

  throw new Error(`Unsupported AI_PROVIDER: ${provider}`)
}
