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
const FETCH_TIMEOUT_MS = 20_000

/** A single step in the agentic tool loop — for o11y */
export interface LoopStep {
  step: number
  timestamp: number
  durationMs: number
  model?: string
  fallbackUsed?: string
  modelResponse?: { role: string; content?: string; toolCalls?: Array<{ name: string; arguments: unknown }> }
  toolResults?: Array<{ name: string; durationMs: number; resultPreview: string }>
}

/** Full transcript of an agentic loop run */
export interface LoopTranscript {
  steps: LoopStep[]
  totalDurationMs: number
  totalSteps: number
  totalToolCalls: number
  model: string
  startedAt: number
}

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

    // Build fallback chain: primary → fastModel → hardcoded fallbacks
    const fastModel = typeof init.initialState?.fastModel === 'string' ? init.initialState.fastModel : null
    const fallbackModels: string[] = [
      modelId,
      ...(fastModel && fastModel !== modelId ? [fastModel] : []),
      'google/gemini-3-flash-preview',
      'moonshotai/kimi-k2.5',
    ].filter((v, i, a) => a.indexOf(v) === i) // dedupe

    const tools: PiAgentTool[] = Array.isArray(init.initialState?.tools) ? init.initialState!.tools! : []
    const enabledToolsRaw = (init.initialState as Record<string, unknown> | undefined)?.enabledTools
    const enabledToolsAllowlist = Array.isArray(enabledToolsRaw)
      ? enabledToolsRaw.filter((tool): tool is string => typeof tool === 'string' && tool.length > 0)
      : []
    // Backward compat: if enabledTools is empty or missing, expose all tools.
    const allowlist = enabledToolsAllowlist.length > 0 ? new Set(enabledToolsAllowlist) : null
    const baseExposedTools = allowlist ? tools.filter((t) => allowlist.has(t.name)) : tools

    // Mutable runtime tool policy hook:
    // AgentDO can set `agent.state.suppressedTools = ['think_aloud', 'recall']` before a prompt
    // (e.g. during active gameplay turns) to keep the model focused on actions.
    const state: { messages: unknown[]; suppressedTools?: unknown; phaseWhitelist?: unknown } = { messages: [] }
    const messages: OpenRouterMessage[] = [{ role: 'system', content: systemPrompt }]

    const baseUrl = getOpenRouterViaAiGatewayBaseUrl(env)

    type CallModelResult = {
      message: OpenRouterMessage
      toolCalls: Array<{ id: string; name: string; arguments: unknown }>
      text: string
      model: string
      fallbackUsed?: string
      usage?: { input: number; output: number; totalTokens: number }
    }

    async function callModelOnce(msgs: OpenRouterMessage[], maxTokens: number, useModel: string): Promise<CallModelResult> {
      const suppressedRaw = state.suppressedTools
      const suppressed = Array.isArray(suppressedRaw)
        ? suppressedRaw.filter((t): t is string => typeof t === 'string' && t.length > 0)
        : []
      const suppressedSet = suppressed.length > 0 ? new Set(suppressed) : null

      // Phase whitelist: if set, ONLY these tools are available (overrides suppressedTools)
      const whitelistRaw = state.phaseWhitelist
      const whitelist = Array.isArray(whitelistRaw)
        ? whitelistRaw.filter((t): t is string => typeof t === 'string' && t.length > 0)
        : null
      const whitelistSet = whitelist && whitelist.length > 0 ? new Set(whitelist) : null

      let effectiveTools = suppressedSet
        ? baseExposedTools.filter((t) => !suppressedSet.has(t.name))
        : baseExposedTools

      // Whitelist takes precedence: only expose whitelisted tools
      if (whitelistSet) {
        effectiveTools = effectiveTools.filter((t) => whitelistSet.has(t.name))
      }

      const toolDefs: OpenRouterToolDef[] = effectiveTools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description ?? `Tool: ${tool.name}`,
          parameters: (tool.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        },
      }))
      const body: Record<string, unknown> = {
        model: useModel,
        messages: msgs,
        max_tokens: maxTokens,
      }
      if (toolDefs.length > 0) {
        body.tools = toolDefs
        body.tool_choice = 'auto'
      }

      const controller = new AbortController()
      const fetchTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://highswarm.com',
            'X-Title': 'HighSwarm Agent Network',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(fetchTimer)
      }

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
        model: (data.model ?? useModel) as string,
        usage: usage ? {
          input: (usage.prompt_tokens ?? 0) as number,
          output: (usage.completion_tokens ?? 0) as number,
          totalTokens: (usage.total_tokens ?? 0) as number,
        } : undefined,
      }
    }

    async function callModel(msgs: OpenRouterMessage[], maxTokens: number): Promise<CallModelResult> {
      let lastError: Error | null = null
      for (let i = 0; i < fallbackModels.length; i++) {
        const model = fallbackModels[i]
        try {
          const result = await callModelOnce(msgs, maxTokens, model)
          if (i > 0) {
            console.log('Model fallback succeeded', { primary: fallbackModels[0], fallback: model, attempt: i + 1 })
            result.fallbackUsed = model
          }
          return result
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          console.error('Model call failed, trying fallback', {
            model,
            attempt: i + 1,
            totalFallbacks: fallbackModels.length,
            error: lastError.message.slice(0, 200),
          })
          // Only retry on 5xx, 429, or network errors — not 400-level (bad request)
          if (lastError.message.includes('API error 4') && !lastError.message.includes('API error 429')) {
            throw lastError // Don't fallback on client errors (except rate limit)
          }
        }
      }
      throw lastError ?? new Error('All model fallbacks exhausted')
    }

    // O11y state — accessible via (agent as any)._o11y
    const _o11y: { lastTranscript: LoopTranscript | null; lastPromptMessages: OpenRouterMessage[] | null } = {
      lastTranscript: null,
      lastPromptMessages: null,
    }

    return Object.assign({
      state,

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

        // Snapshot the prompt for o11y (deep copy to freeze state)
        _o11y.lastPromptMessages = workingMessages.map(m => ({ ...m }))

        // Accumulate all tool calls across the loop
        const allToolCalls: Array<{ id: string; name: string; arguments: unknown }> = []
        let finalText = ''
        let finalModel = modelId
        let totalUsage = { input: 0, output: 0, totalTokens: 0 }
        let steps = 0
        const transcript: LoopStep[] = []

        // Agentic tool loop — model calls tools, sees results, decides next action
        while (true) {
          if (Date.now() - startedAt > TOOL_LOOP_TIMEOUT_MS) {
            console.log('Tool loop timeout', { steps, elapsed: Date.now() - startedAt })
            break
          }

          steps++
          const stepStart = Date.now()
          const result = await callModel(workingMessages, maxTokens)
          const modelDuration = Date.now() - stepStart

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

          const loopStep: LoopStep = {
            step: steps,
            timestamp: stepStart,
            durationMs: modelDuration,
            model: result.model,
            fallbackUsed: result.fallbackUsed,
            modelResponse: {
              role: 'assistant',
              content: result.text || undefined,
              toolCalls: result.toolCalls.length > 0
                ? result.toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments }))
                : undefined,
            },
          }

          // No tool calls = model is done
          if (result.toolCalls.length === 0) {
            transcript.push(loopStep)
            console.log('Tool loop complete (no more tool calls)', { steps, totalToolCalls: allToolCalls.length })
            break
          }

          allToolCalls.push(...result.toolCalls.map(tc => ({ ...tc, _executed: true })))

          console.log('Tool loop step', {
            step: steps,
            toolCalls: result.toolCalls.map(tc => tc.name),
            elapsed: Date.now() - startedAt,
          })

          // Execute each tool call and feed results back, with per-tool timing
          const toolResults: LoopStep['toolResults'] = []
          for (const tc of result.toolCalls) {
            const suppressedRaw = state.suppressedTools
            const suppressed = Array.isArray(suppressedRaw)
              ? suppressedRaw.filter((t): t is string => typeof t === 'string' && t.length > 0)
              : []
            const suppressedSet = suppressed.length > 0 ? new Set(suppressed) : null

            // Phase whitelist for execution path
            const whitelistRaw2 = state.phaseWhitelist
            const whitelist2 = Array.isArray(whitelistRaw2)
              ? whitelistRaw2.filter((t): t is string => typeof t === 'string' && t.length > 0)
              : null
            const whitelistSet2 = whitelist2 && whitelist2.length > 0 ? new Set(whitelist2) : null

            let effectiveTools = suppressedSet
              ? baseExposedTools.filter((t) => !suppressedSet.has(t.name))
              : baseExposedTools

            if (whitelistSet2) {
              effectiveTools = effectiveTools.filter((t) => whitelistSet2.has(t.name))
            }

            const tool = effectiveTools.find(t => t.name === tc.name)
            let toolResult: string
            const toolStart = Date.now()

            if (!tool?.execute) {
              // If enabledTools is configured, treat missing tools as a hard error rather than a "pending" tool.
              toolResult = allowlist
                ? JSON.stringify({ error: 'Tool not enabled', name: tc.name })
                : JSON.stringify({ pending: true, name: tc.name, arguments: tc.arguments })
            } else {
              try {
                const execResult = await tool.execute(tc.id, tc.arguments, undefined, undefined)
                toolResult = typeof execResult === 'string' ? execResult : JSON.stringify(execResult)
              } catch (err) {
                toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
              }
            }

            toolResults.push({
              name: tc.name,
              durationMs: Date.now() - toolStart,
              resultPreview: toolResult.slice(0, 500),
            })

            const toolMsg: OpenRouterMessage = {
              role: 'tool',
              content: toolResult,
              tool_call_id: tc.id,
            }
            workingMessages.push(toolMsg)
            messages.push(toolMsg)
          }

          loopStep.durationMs = Date.now() - stepStart // include tool execution time
          loopStep.toolResults = toolResults
          transcript.push(loopStep)
        }

        const totalDuration = Date.now() - startedAt

        // Store transcript for o11y
        _o11y.lastTranscript = {
          steps: transcript,
          totalDurationMs: totalDuration,
          totalSteps: steps,
          totalToolCalls: allToolCalls.length,
          model: finalModel,
          startedAt,
        }

        console.log('OpenRouter agentic prompt complete', {
          model: finalModel,
          steps,
          totalToolCalls: allToolCalls.length,
          toolNames: allToolCalls.map(tc => tc.name),
          elapsed: totalDuration,
        })

        return {
          text: finalText,
          model: finalModel,
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
          usage: totalUsage.totalTokens > 0 ? totalUsage : undefined,
        }
      },
    }, { _o11y }) as any
  }
}
