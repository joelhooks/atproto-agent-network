export interface CorsEnv {
  /**
   * Configure allowed origins for browser clients.
   *
   * - Omitted / "*" => allow all (development default)
   * - Single origin => allow that origin
   * - Comma-separated origins => allowlisted
   */
  CORS_ORIGIN?: string
}

const DEFAULT_ALLOW_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS'
const DEFAULT_ALLOW_HEADERS = 'Authorization, Content-Type'
const DEFAULT_MAX_AGE_SECONDS = '86400'

function mergeVary(existing: string | null, next: string): string {
  const values = new Set<string>()

  for (const chunk of [existing ?? '', next]) {
    for (const part of chunk.split(',')) {
      const trimmed = part.trim()
      if (trimmed) values.add(trimmed)
    }
  }

  return Array.from(values).join(', ')
}

function resolveAllowedOrigin(request: Request, env: CorsEnv): string {
  const configured = (env.CORS_ORIGIN ?? '*').trim()
  if (!configured || configured === '*') return '*'

  const origin = request.headers.get('Origin')
  const allowed = configured
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (!origin) {
    return allowed[0] ?? configured
  }

  if (allowed.includes('*')) return '*'
  if (allowed.includes(origin)) return origin

  // Deliberately do not echo untrusted origins; browsers will block.
  return 'null'
}

export function buildCorsHeaders(request: Request, env: CorsEnv): Headers {
  const headers = new Headers()
  const allowOrigin = resolveAllowedOrigin(request, env)

  headers.set('Access-Control-Allow-Origin', allowOrigin)
  headers.set('Access-Control-Allow-Methods', DEFAULT_ALLOW_METHODS)
  headers.set(
    'Access-Control-Allow-Headers',
    request.headers.get('Access-Control-Request-Headers') ?? DEFAULT_ALLOW_HEADERS
  )
  headers.set('Access-Control-Max-Age', DEFAULT_MAX_AGE_SECONDS)

  // Cache variations safely when not using "*".
  headers.set(
    'Vary',
    allowOrigin === '*'
      ? 'Access-Control-Request-Headers'
      : 'Origin, Access-Control-Request-Headers'
  )

  return headers
}

export function applyCorsHeaders(response: Response, request: Request, env: CorsEnv): Response {
  const cors = buildCorsHeaders(request, env)
  const merged = new Headers(response.headers)

  for (const [key, value] of cors.entries()) {
    if (key.toLowerCase() === 'vary') {
      merged.set('Vary', mergeVary(merged.get('Vary'), value))
      continue
    }
    merged.set(key, value)
  }

  const webSocket = (response as unknown as { webSocket?: WebSocket }).webSocket
  const init: ResponseInit & { webSocket?: WebSocket } = {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  }

  if (webSocket) {
    init.webSocket = webSocket
  }

  return new Response(response.body, init)
}

export function corsPreflightResponse(request: Request, env: CorsEnv): Response {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request, env),
  })
}

