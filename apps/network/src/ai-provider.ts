import { complete, getModel, type Context, type Model, type ProviderStreamOptions } from '@mariozechner/pi-ai'

export interface OpenRouterViaAiGatewayEnv {
  /**
   * Cloudflare account ID (used to build the AI Gateway base URL).
   *
   * Note: Wrangler does not inject this automatically; it must be provided via
   * vars/secrets or otherwise supplied by the runtime.
   */
  CF_ACCOUNT_ID: string
  /** Cloudflare AI Gateway slug (Dashboard -> AI -> AI Gateway). */
  AI_GATEWAY_SLUG: string
  /** OpenRouter API key (wrangler secret). */
  OPENROUTER_API_KEY: string
  /** Default OpenRouter model id (wrangler var). */
  OPENROUTER_MODEL_DEFAULT?: string
}

export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.0-flash-001'

function requireNonEmptyString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

function normalizePathSegment(value: string): string {
  return value.trim().replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Cloudflare AI Gateway base URL for OpenRouter requests.
 *
 * Example:
 * `https://gateway.ai.cloudflare.com/v1/<accountId>/<gatewaySlug>/openrouter`
 */
export function getOpenRouterViaAiGatewayBaseUrl(
  env: Pick<OpenRouterViaAiGatewayEnv, 'CF_ACCOUNT_ID' | 'AI_GATEWAY_SLUG'>
): string {
  const accountId = normalizePathSegment(requireNonEmptyString('CF_ACCOUNT_ID', env.CF_ACCOUNT_ID))
  const slug = normalizePathSegment(
    requireNonEmptyString('AI_GATEWAY_SLUG', env.AI_GATEWAY_SLUG)
  )

  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${slug}/openrouter`
}

function createFallbackOpenRouterModel(modelId: string): Model<'openai-completions'> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  }
}

function getBaseOpenRouterModel(modelId: string): Model<any> {
  // pi-ai maintains a generated model registry; fall back to a minimal model
  // definition so users can still pass new OpenRouter model IDs.
  const model = getModel('openrouter', modelId as never) as unknown as Model<any> | undefined
  return model ?? createFallbackOpenRouterModel(modelId)
}

/**
 * Returns the default reasoning model for OpenRouter (via Cloudflare AI Gateway).
 */
export function getOpenRouterModel(
  env: OpenRouterViaAiGatewayEnv,
  modelId: string = env.OPENROUTER_MODEL_DEFAULT ?? DEFAULT_OPENROUTER_MODEL
) {
  // Validate required secret early for consistent error messages and tests.
  requireNonEmptyString('OPENROUTER_API_KEY', env.OPENROUTER_API_KEY)

  const baseUrl = getOpenRouterViaAiGatewayBaseUrl(env)
  const baseModel = getBaseOpenRouterModel(modelId)

  return {
    ...baseModel,
    baseUrl,
  }
}

export async function completeWithOpenRouter(
  env: OpenRouterViaAiGatewayEnv,
  context: Context,
  options?: ProviderStreamOptions & { modelId?: string }
) {
  const modelId = options?.modelId
  const model = getOpenRouterModel(env, modelId)

  return complete(model, context, {
    ...options,
    apiKey: env.OPENROUTER_API_KEY,
  })
}
