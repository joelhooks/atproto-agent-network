import type { z } from 'zod'

export type JsonValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response }

export async function validateRequestJson<TSchema extends z.ZodTypeAny>(
  request: Request,
  schema: TSchema,
  options?: {
    invalidJsonError?: string
    invalidBodyError?: string
  }
): Promise<JsonValidationResult<z.infer<TSchema>>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return {
      ok: false,
      response: Response.json(
        { error: options?.invalidJsonError ?? 'Invalid JSON' },
        { status: 400 }
      ),
    }
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return {
      ok: false,
      response: Response.json(
        {
          error: options?.invalidBodyError ?? 'Invalid record',
          issues: parsed.error.issues,
        },
        { status: 400 }
      ),
    }
  }

  return { ok: true, data: parsed.data }
}

