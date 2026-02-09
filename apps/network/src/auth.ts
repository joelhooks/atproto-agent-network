export interface BearerAuthEnv {
  /**
   * Shared admin bearer token required for all network endpoints.
   * Configure via `wrangler secret put ADMIN_TOKEN`.
   */
  ADMIN_TOKEN?: string
}

function parseBearerToken(header: string | null): string | null {
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+?)\s*$/i)
  return match ? match[1] : null
}

/**
 * Enforces a shared admin bearer token for the network.
 *
 * Returns `null` when authorized; otherwise returns an HTTP response that should
 * be returned immediately by the caller.
 */
export function requireAdminBearerAuth(request: Request, env: BearerAuthEnv): Response | null {
  const expected = env.ADMIN_TOKEN
  if (!expected) {
    return Response.json({ error: 'Auth token not configured' }, { status: 500 })
  }

  // Support query param auth for WebSocket connections (browsers can't set headers on WS)
  const url = new URL(request.url)
  const token = parseBearerToken(request.headers.get('Authorization')) || url.searchParams.get('token')
  if (!token || token !== expected) {
    return Response.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    )
  }

  return null
}
