/**
 * Custom agent factory that uses OpenRouter via CF AI Gateway
 * using Pi's model + completion API.
 */
import { complete, type Context } from '@mariozechner/pi-ai'
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

        const context: Context = {
          systemPrompt,
          messages: [{ role: 'user', content: input, timestamp: Date.now() }],
        }

        const result = await complete(model, context, {
          apiKey: env.OPENROUTER_API_KEY,
          maxTokens,
        })

        const text = result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')

        return {
          text,
          model: result.model ?? modelId ?? 'unknown',
          usage: result.usage,
        }
      },
    }
  }
}
