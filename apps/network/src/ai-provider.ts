import { createOpenRouter } from '@openrouter/ai-sdk-provider'

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

export const DEFAULT_OPENROUTER_MODEL = 'moonshotai/kimi-k2'

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

/**
 * Creates an OpenRouter provider configured to route through Cloudflare AI Gateway.
 */
export function createOpenRouterViaAiGateway(
  env: Pick<OpenRouterViaAiGatewayEnv, 'CF_ACCOUNT_ID' | 'AI_GATEWAY_SLUG' | 'OPENROUTER_API_KEY'>
) {
  const apiKey = requireNonEmptyString('OPENROUTER_API_KEY', env.OPENROUTER_API_KEY)
  const baseURL = getOpenRouterViaAiGatewayBaseUrl(env)

  return createOpenRouter({ apiKey, baseURL })
}

/**
 * Returns the default reasoning model for OpenRouter (via Cloudflare AI Gateway).
 */
export function getOpenRouterModel(
  env: OpenRouterViaAiGatewayEnv,
  modelId: string = env.OPENROUTER_MODEL_DEFAULT ?? DEFAULT_OPENROUTER_MODEL
) {
  const openrouter = createOpenRouterViaAiGateway(env)
  return openrouter(modelId)
}

