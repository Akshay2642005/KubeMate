import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModelV4 } from "@ai-sdk/provider"

type Model = LanguageModelV4

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function createConfiguredModel(): Model {
  const provider = process.env.AI_PROVIDER ?? "groq"

  if (provider === "openrouter") {
    const openrouter = createOpenAI({
      name: "openrouter",
      apiKey: requiredEnv("OPENROUTER__API_KEY"),
      baseURL: "https://openrouter.ai/api/v1",
    })
    return openrouter.chat(requiredEnv("OPENROUTER__MODEL"))
  }

  if (provider === "groq") {
    const groq = createOpenAI({
      name: "groq",
      apiKey: requiredEnv("GROQ__API_KEY"),
      baseURL: "https://api.groq.com/openai/v1",
    })
    return groq.chat(requiredEnv("GROQ__MODEL"))
  }

  if (provider === "nvidia") {
    const nvidia = createOpenAI({
      name: "nvidia",
      apiKey: requiredEnv("NVIDIA__API_KEY"),
      baseURL: "https://integrate.api.nvidia.com/v1",
    })
    return nvidia.chat(requiredEnv("NVIDIA__CHAT_MODEL"))
  }

  throw new Error(`Unsupported AI_PROVIDER: ${provider}`)
}

export function chatModel(): Model {
  return createConfiguredModel()
}
