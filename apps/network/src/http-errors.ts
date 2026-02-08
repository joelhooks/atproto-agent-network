export interface RouteErrorContext {
  route?: string
  request?: Request
}

export async function withErrorHandling(
  handler: () => Promise<Response> | Response,
  context: RouteErrorContext = {}
): Promise<Response> {
  try {
    return await handler()
  } catch (error) {
    if (error instanceof Response) {
      return error
    }

    const request = context.request

    // Log with enough context to debug without leaking secrets to the client.
    try {
      console.error('Unhandled route error', {
        route: context.route,
        method: request?.method,
        url: request?.url,
        error,
      })
    } catch {
      // Best-effort logging only.
    }

    return Response.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
