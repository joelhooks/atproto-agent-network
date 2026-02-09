import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PiAgentTool } from '@atproto-agent/agent'

describe('OpenRouter agent factory (tool exposure)', () => {
  const env = {
    CF_ACCOUNT_ID: 'acct_123',
    AI_GATEWAY_SLUG: 'gateway_slug',
    OPENROUTER_API_KEY: 'sk-or-test',
    OPENROUTER_MODEL_DEFAULT: 'openrouter/test-model',
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeTool(name: string, execute?: PiAgentTool['execute']): PiAgentTool {
    return {
      name,
      description: `tool ${name}`,
      parameters: { type: 'object', properties: {} },
      execute,
    }
  }

  it('only sends tool definitions included in initialState.enabledTools (when non-empty)', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: Array<{ function?: { name?: string } }> }
      const names = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean)
      expect(names).toEqual(['remember'])

      return new Response(
        JSON.stringify({
          model: env.OPENROUTER_MODEL_DEFAULT,
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    vi.stubGlobal('fetch', fetchSpy)

    const { createOpenRouterAgentFactory } = await import('./agent-factory')
    const factory = createOpenRouterAgentFactory(env)

    const agent = await factory({
      initialState: {
        systemPrompt: 'system',
        model: env.OPENROUTER_MODEL_DEFAULT,
        tools: [makeTool('remember'), makeTool('recall'), makeTool('search')],
        enabledTools: ['remember'],
      },
    })

    await agent.prompt('hello')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('exposes all tool definitions when enabledTools is empty (backward compat)', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: Array<{ function?: { name?: string } }> }
      const names = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean).sort()
      expect(names).toEqual(['recall', 'remember', 'search'])

      return new Response(
        JSON.stringify({
          model: env.OPENROUTER_MODEL_DEFAULT,
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    vi.stubGlobal('fetch', fetchSpy)

    const { createOpenRouterAgentFactory } = await import('./agent-factory')
    const factory = createOpenRouterAgentFactory(env)

    const agent = await factory({
      initialState: {
        systemPrompt: 'system',
        model: env.OPENROUTER_MODEL_DEFAULT,
        tools: [makeTool('remember'), makeTool('recall'), makeTool('search')],
        enabledTools: [],
      },
    })

    await agent.prompt('hello')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not execute disabled tools even if the model calls them', async () => {
    const recallExecute = vi.fn(async () => 'should-not-run')

    let call = 0
    const fetchSpy = vi.fn(async () => {
      call++
      if (call === 1) {
        return new Response(
          JSON.stringify({
            model: env.OPENROUTER_MODEL_DEFAULT,
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'tc_1',
                      type: 'function',
                      function: { name: 'recall', arguments: JSON.stringify({ query: 'x' }) },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({
          model: env.OPENROUTER_MODEL_DEFAULT,
          choices: [{ message: { role: 'assistant', content: 'done' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    vi.stubGlobal('fetch', fetchSpy)

    const { createOpenRouterAgentFactory } = await import('./agent-factory')
    const factory = createOpenRouterAgentFactory(env)

    const agent = await factory({
      initialState: {
        systemPrompt: 'system',
        model: env.OPENROUTER_MODEL_DEFAULT,
        tools: [makeTool('remember'), makeTool('recall', recallExecute)],
        enabledTools: ['remember'],
      },
    })

    const result = await agent.prompt('hello')
    expect(String((result as any)?.text ?? '')).toContain('done')
    expect(recallExecute).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

