/**
 * Custom agent factory that uses OpenRouter via CF AI Gateway
 * with AGENTIC tool-calling loops (Pi-style).
 *
 * The model calls tools → sees results → decides next action → loops
 * until it stops calling tools or hits the step limit.
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

// Pi philosophy: agent decides when it's done, timeout is the only limit
const TOOL_LOOP_TIMEOUT_MS = 25_000

/**
 * Creates a PiAgentLike implementation backed by OpenRouter with agentic tool loops.
 * Model calls tools → sees results → decides next action → loops until done.
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

    async function callModel(msgs: OpenRouterMessage[], maxTokens: number): Promise<{
      message: OpenRouterMessage
      toolCalls: Array<{ id: string; name: string; arguments: unknown }>
      text: string
      model: string
      usage?: { input: number; output: number; totalTokens: number }
    }> {
      const toolDefs = buildToolDefs()
      const body: Record<string, unknown> = {
        model: modelId,
        messages: msgs,
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
      const message = (choice.message ?? {}) as OpenRouterMessage

      const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      const toolCalls = rawToolCalls.map((tc: any) => ({
        id: tc.id ?? '',
        name: tc.function?.name ?? '',
        arguments: (() => {
          try {
            return typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments ?? {}
          } catch { return {} }
        })(),
      }))

      const usage = data.usage as Record<string, unknown> | undefined

      return {
        message,
        toolCalls,
        text: typeof message.content === 'string' ? message.content : '',
        model: (data.model ?? modelId) as string,
        usage: usage ? {
          input: (usage.prompt_tokens ?? 0) as number,
          output: (usage.completion_tokens ?? 0) as number,
          totalTokens: (usage.total_tokens ?? 0) as number,
        } : undefined,
      }
    }

    return {
      state: { messages: [] },

      resetConversation() {
        messages.length = 1
      },

      async prompt(input: string, options?: Record<string, unknown>): Promise<unknown> {
        const maxTokens = typeof options?.maxTokens === 'number' ? options.maxTokens : 2048
        const startedAt = Date.now()

        messages.push({ role: 'user', content: input })

        // Trim to system + last N messages
        const MAX_HISTORY = 12
        const workingMessages = messages.length > MAX_HISTORY + 1
          ? [messages[0], ...messages.slice(-MAX_HISTORY)]
          : [...messages]

        // Accumulate all tool calls across the loop
        const allToolCalls: Array<{ id: string; name: string; arguments: unknown }> = []
        let finalText = ''
        let finalModel = modelId
        let totalUsage = { input: 0, output: 0, totalTokens: 0 }
        let steps = 0

        // Agentic tool loop — model calls tools, sees results, decides next action
        while (true) {
          if (Date.now() - startedAt > TOOL_LOOP_TIMEOUT_MS) {
            console.log('Tool loop timeout', { steps, elapsed: Date.now() - startedAt })
            break
          }

          steps++
          const result = await callModel(workingMessages, maxTokens)

          // Track conversation
          workingMessages.push(result.message)
          messages.push(result.message)

          finalText = result.text
          finalModel = result.model
          if (result.usage) {
            totalUsage.input += result.usage.input
            totalUsage.output += result.usage.output
            totalUsage.totalTokens += result.usage.totalTokens
          }

          // No tool calls = model is done
          if (result.toolCalls.length === 0) {
            console.log('Tool loop complete (no more tool calls)', { steps, totalToolCalls: allToolCalls.length })
            break
          }

          allToolCalls.push(...result.toolCalls.map(tc => ({ ...tc, _executed: true })))

          console.log('Tool loop step', {
            step: steps,
            toolCalls: result.toolCalls.map(tc => tc.name),
            elapsed: Date.now() - startedAt,
          })

          // Execute each tool call and feed results back
          for (const tc of result.toolCalls) {
            const tool = tools.find(t => t.name === tc.name)
            let toolResult: string

            if (!tool?.execute) {
              // No execute handler — return the tool call info for act() to handle
              toolResult = JSON.stringify({ pending: true, name: tc.name, arguments: tc.arguments })
            } else {
              try {
                const execResult = await tool.execute(tc.id, tc.arguments, undefined, undefined)
                toolResult = typeof execResult === 'string' ? execResult : JSON.stringify(execResult)
              } catch (err) {
                toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
              }
            }

            const toolMsg: OpenRouterMessage = {
              role: 'tool',
              content: toolResult,
              tool_call_id: tc.id,
            }
            workingMessages.push(toolMsg)
            messages.push(toolMsg)
          }
        }

        console.log('OpenRouter agentic prompt complete', {
          model: finalModel,
          steps,
          totalToolCalls: allToolCalls.length,
          toolNames: allToolCalls.map(tc => tc.name),
          elapsed: Date.now() - startedAt,
        })

        return {
          text: finalText,
          model: finalModel,
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
          usage: totalUsage.totalTokens > 0 ? totalUsage : undefined,
        }
      },
    }
  }
}
