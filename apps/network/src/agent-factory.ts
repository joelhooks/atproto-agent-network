/**
 * Custom agent factory that uses OpenRouter via CF AI Gateway
 * with tool-calling support (OpenAI-compatible API).
 */
import type { PiAgentFactory, PiAgentInit, PiAgentLike, PiAgentTool } from '@atproto-agent/agent'
import { getOpenRouterViaAiGatewayBaseUrl, type OpenRouterViaAiGatewayEnv, DEFAULT_OPENROUTER_MODEL } from './ai-provider'

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface OpenRouterToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * Creates a PiAgentLike implementation backed by OpenRouter with tool calling.
 */
export function createOpenRouterAgentFactory(
  env: OpenRouterViaAiGatewayEnv
): PiAgentFactory {
  return (init: PiAgentInit): PiAgentLike => {
    const systemPrompt = init.initialState?.systemPrompt ?? 'You are a helpful AI agent.'
    const modelId = typeof init.initialState?.model === 'string'
      ? init.initialState.model
      : (env.OPENROUTER_MODEL_DEFAULT ?? DEFAULT_OPENROUTER_MODEL)

    const tools: PiAgentTool[] = Array.isArray(init.initialState?.tools) ? init.initialState!.tools! : []
    const messages: OpenRouterMessage[] = [{ role: 'system', content: systemPrompt }]

    // Convert PiAgentTools to OpenRouter tool definitions
    function buildToolDefs(): OpenRouterToolDef[] {
      return tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description ?? `Tool: ${tool.name}`,
          parameters: (tool.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        },
      }))
    }

    const baseUrl = getOpenRouterViaAiGatewayBaseUrl(env)

    return {
      state: { messages: [] },

      async prompt(input: string, options?: Record<string, unknown>): Promise<unknown> {
        const maxTokens = typeof options?.maxTokens === 'number' ? options.maxTokens : 2048

        messages.push({ role: 'user', content: input })

        const toolDefs = buildToolDefs()

        const body: Record<string, unknown> = {
          model: modelId,
          messages,
          max_tokens: maxTokens,
        }

        if (toolDefs.length > 0) {
          body.tools = toolDefs
          body.tool_choice = 'auto'
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://highswarm.com',
            'X-Title': 'HighSwarm Agent Network',
          },
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          const errorText = await response.text().catch(() => '')
          throw new Error(`OpenRouter API error ${response.status}: ${errorText}`)
        }

        const data = (await response.json()) as Record<string, unknown>
        const choices = (data.choices ?? []) as Array<Record<string, unknown>>
        const choice = choices[0] ?? {}
        const message = (choice.message ?? {}) as Record<string, unknown>

        // Track assistant message for conversation continuity
        messages.push(message as unknown as OpenRouterMessage)

        const text = typeof message.content === 'string' ? message.content : ''

        // Extract tool calls
        const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
        const toolCalls = rawToolCalls.map((tc: any) => ({
          id: tc.id ?? '',
          name: tc.function?.name ?? '',
          arguments: (() => {
            try {
              return typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments ?? {}
            } catch {
              return {}
            }
          })(),
        }))

        // Extract usage
        const usage = data.usage as Record<string, unknown> | undefined

        return {
          text,
          model: (data.model ?? modelId) as string,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: usage
            ? {
                input: (usage.prompt_tokens ?? 0) as number,
                output: (usage.completion_tokens ?? 0) as number,
                totalTokens: (usage.total_tokens ?? 0) as number,
              }
            : undefined,
        }
      },
    }
  }
}
