/**
 * Custom agent factory that uses OpenRouter via CF AI Gateway
 * instead of the missing @mariozechner/pi-agent-core dependency.
 */
import { generateText } from 'ai'
import type { PiAgentFactory, PiAgentInit, PiAgentLike } from '@atproto-agent/agent'
import { getOpenRouterModel, type OpenRouterViaAiGatewayEnv } from './ai-provider'

/**
 * Creates a PiAgentLike implementation backed by OpenRouter.
 */
export function createOpenRouterAgentFactory(
  env: OpenRouterViaAiGatewayEnv
): PiAgentFactory {
  return (init: PiAgentInit): PiAgentLike => {
    const systemPrompt = init.initialState?.systemPrompt ?? 'You are a helpful AI agent.'
    const modelId = typeof init.initialState?.model === 'string'
      ? init.initialState.model
      : undefined

    return {
      async prompt(input: string, options?: Record<string, unknown>): Promise<unknown> {
        const model = getOpenRouterModel(env, modelId)
        const maxTokens = typeof options?.maxTokens === 'number' ? options.maxTokens : 1024

        const result = await generateText({
          model,
          system: systemPrompt,
          prompt: input,
          maxOutputTokens: maxTokens,
        })

        return {
          text: result.text,
          model: result.response?.modelId ?? modelId ?? 'unknown',
          usage: result.usage,
        }
      },
    }
  }
}
