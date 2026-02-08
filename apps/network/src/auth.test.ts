import { describe, expect, it } from 'vitest'

import { requireAdminBearerAuth } from './auth'

describe('requireAdminBearerAuth', () => {
  it('returns 500 when the admin token is not configured', async () => {
    const response = requireAdminBearerAuth(new Request('https://example.com/'), {})

    expect(response?.status).toBe(500)
    await expect(response?.json()).resolves.toMatchObject({
      error: 'Auth token not configured',
    })
  })

  it('returns 401 when the Authorization header is missing', async () => {
    const response = requireAdminBearerAuth(new Request('https://example.com/'), {
      ADMIN_TOKEN: 'secret',
    })

    expect(response?.status).toBe(401)
    expect(response?.headers.get('WWW-Authenticate')).toBe('Bearer')
    await expect(response?.json()).resolves.toMatchObject({ error: 'Unauthorized' })
  })

  it('returns 401 when the bearer token is wrong', async () => {
    const response = requireAdminBearerAuth(
      new Request('https://example.com/', {
        headers: { Authorization: 'Bearer wrong' },
      }),
      { ADMIN_TOKEN: 'secret' }
    )

    expect(response?.status).toBe(401)
    await expect(response?.json()).resolves.toMatchObject({ error: 'Unauthorized' })
  })

  it('returns null when the bearer token matches', () => {
    const response = requireAdminBearerAuth(
      new Request('https://example.com/', {
        headers: { Authorization: 'Bearer secret' },
      }),
      { ADMIN_TOKEN: 'secret' }
    )

    expect(response).toBeNull()
  })
})

