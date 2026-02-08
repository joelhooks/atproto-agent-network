import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateText } from 'ai'

import { getOpenRouterModel, getOpenRouterViaAiGatewayBaseUrl } from './ai-provider'

describe('AI provider (Cloudflare AI Gateway -> OpenRouter)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('builds the expected Cloudflare AI Gateway base URL for OpenRouter', () => {
    expect(
      getOpenRouterViaAiGatewayBaseUrl({
        CF_ACCOUNT_ID: 'acct_123',
        AI_GATEWAY_SLUG: 'atproto-agent-network',
      })
    ).toBe('https://gateway.ai.cloudflare.com/v1/acct_123/atproto-agent-network/openrouter')
  })

  it('normalizes extra slashes in the gateway slug', () => {
    expect(
      getOpenRouterViaAiGatewayBaseUrl({
        CF_ACCOUNT_ID: 'acct_123',
        AI_GATEWAY_SLUG: '/atproto-agent-network/',
      })
    ).toBe('https://gateway.ai.cloudflare.com/v1/acct_123/atproto-agent-network/openrouter')
  })

  it('throws a safe error when required env vars are missing', () => {
    expect(() =>
      getOpenRouterModel({
        CF_ACCOUNT_ID: 'acct_123',
        AI_GATEWAY_SLUG: 'atproto-agent-network',
        OPENROUTER_API_KEY: '',
        OPENROUTER_MODEL_DEFAULT: 'moonshot/kimi-k2',
      })
    ).toThrow(/OPENROUTER_API_KEY/i)
  })

  it('routes generateText() through the Cloudflare AI Gateway base URL with a bearer token', async () => {
    const env = {
      CF_ACCOUNT_ID: 'acct_123',
      AI_GATEWAY_SLUG: 'atproto-agent-network',
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_MODEL_DEFAULT: 'moonshot/kimi-k2',
    }

    const baseUrl = getOpenRouterViaAiGatewayBaseUrl(env)

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      )

      expect(url.startsWith(baseUrl)).toBe(true)
      expect(headers.get('authorization')).toBe(`Bearer ${env.OPENROUTER_API_KEY}`)

      const bodyText =
        typeof init?.body === 'string'
          ? init.body
          : input instanceof Request
            ? await input.clone().text()
            : ''

      const payload = bodyText ? (JSON.parse(bodyText) as { model?: string }) : {}
      expect(payload.model).toBe(env.OPENROUTER_MODEL_DEFAULT)

      return new Response(
        JSON.stringify({
          id: 'chatcmpl_test',
          object: 'chat.completion',
          created: 0,
          model: env.OPENROUTER_MODEL_DEFAULT,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello from mock' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    vi.stubGlobal('fetch', fetchMock)

    const result = await generateText({
      model: getOpenRouterModel(env),
      prompt: 'say hello',
    })

    expect(result.text).toBe('hello from mock')
    expect(fetchMock).toHaveBeenCalled()
  })
})

