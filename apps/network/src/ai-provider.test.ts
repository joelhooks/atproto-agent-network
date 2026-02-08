import { afterEach, describe, expect, it, vi } from 'vitest'

type CompleteCall = {
  model: unknown
  context: unknown
  options: unknown
}

let lastCompleteCall: CompleteCall | undefined

vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-ai')>()

  return {
    ...actual,
    complete: vi.fn(async (model: any, context: any, options: any) => {
      lastCompleteCall = { model, context, options }
      options?.onPayload?.({ model: model?.id })
      return {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello from mock' }],
        api: model?.api ?? 'openai-completions',
        provider: model?.provider ?? 'openrouter',
        model: model?.id ?? 'unknown',
        usage: {
          input: 1,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 4,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
    }),
  }
})

describe('AI provider (Cloudflare AI Gateway -> OpenRouter)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    lastCompleteCall = undefined
  })

  it('builds the expected Cloudflare AI Gateway base URL for OpenRouter', async () => {
    const { getOpenRouterViaAiGatewayBaseUrl } = await import('./ai-provider')
    expect(
      getOpenRouterViaAiGatewayBaseUrl({
        CF_ACCOUNT_ID: 'acct_123',
        AI_GATEWAY_SLUG: 'atproto-agent-network',
      })
    ).toBe('https://gateway.ai.cloudflare.com/v1/acct_123/atproto-agent-network/openrouter')
  })

  it('normalizes extra slashes in the gateway slug', async () => {
    const { getOpenRouterViaAiGatewayBaseUrl } = await import('./ai-provider')
    expect(
      getOpenRouterViaAiGatewayBaseUrl({
        CF_ACCOUNT_ID: 'acct_123',
        AI_GATEWAY_SLUG: '/atproto-agent-network/',
      })
    ).toBe('https://gateway.ai.cloudflare.com/v1/acct_123/atproto-agent-network/openrouter')
  })

  it('throws a safe error when required env vars are missing', async () => {
    const { getOpenRouterModel } = await import('./ai-provider')
    expect(() =>
      getOpenRouterModel({
        CF_ACCOUNT_ID: 'acct_123',
        AI_GATEWAY_SLUG: 'atproto-agent-network',
        OPENROUTER_API_KEY: '',
        OPENROUTER_MODEL_DEFAULT: 'moonshot/kimi-k2',
      })
    ).toThrow(/OPENROUTER_API_KEY/i)
  })

  it('routes complete() through the Cloudflare AI Gateway base URL with a bearer token', async () => {
    const { completeWithOpenRouter, getOpenRouterViaAiGatewayBaseUrl } = await import('./ai-provider')
    const env = {
      CF_ACCOUNT_ID: 'acct_123',
      AI_GATEWAY_SLUG: 'atproto-agent-network',
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_MODEL_DEFAULT: 'moonshot/kimi-k2',
    }

    const baseUrl = getOpenRouterViaAiGatewayBaseUrl(env)

    const result = await completeWithOpenRouter(
      env,
      {
        messages: [{ role: 'user', content: 'say hello', timestamp: Date.now() }],
      },
      {
        onPayload: (payload) => {
          expect(payload).toMatchObject({ model: env.OPENROUTER_MODEL_DEFAULT })
        },
      }
    )

    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')

    expect(text).toBe('hello from mock')
    expect((lastCompleteCall?.model as any)?.baseUrl?.startsWith(baseUrl)).toBe(true)
    expect((lastCompleteCall?.options as any)?.apiKey).toBe(env.OPENROUTER_API_KEY)
    expect((lastCompleteCall?.model as any)?.id).toBe(env.OPENROUTER_MODEL_DEFAULT)
  })
})
