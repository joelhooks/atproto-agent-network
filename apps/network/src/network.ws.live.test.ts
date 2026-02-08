import { describe, expect, it } from 'vitest'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  stepMs = 250
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T
  while (Date.now() < deadline) {
    last = await fn()
    if (predicate(last)) return last
    await sleep(stepMs)
  }
  return last!
}

function toWsUrl(httpUrl: string, pathname: string): string {
  const url = new URL(httpUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = pathname
  url.search = ''
  url.hash = ''
  return url.toString()
}

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://agent-network.joelhooks.workers.dev'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ''
const SHOULD_RUN_LIVE = Boolean(ADMIN_TOKEN)

const describeLive = SHOULD_RUN_LIVE ? describe : describe.skip

describeLive('network live WS: loop lifecycle broadcast', () => {
  it(
    'broadcasts loop.observe/loop.think/loop.reflect with O11Y fields and tolerates disconnects',
    async () => {
      const agentName = `test-ws-${Date.now()}`
      const wsUrl = toWsUrl(BASE_URL, `/agents/${agentName}/ws`)
      const httpBase = new URL(BASE_URL)

      const ws = new WebSocket(wsUrl)
      const messages: any[] = []

      const opened = new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true })
        ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
      })

      ws.addEventListener('message', (evt) => {
        try {
          messages.push(JSON.parse(String(evt.data)))
        } catch {
          // ignore non-JSON payloads
        }
      })

      await opened

      try {
        // Speed up the loop for the live test. (Min interval is 5000ms.)
        await fetch(new URL(`/agents/${agentName}/config`, httpBase), {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ loopIntervalMs: 5000 }),
        })

        const startRes = await fetch(new URL(`/agents/${agentName}/loop/start`, httpBase), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
          },
        })
        expect(startRes.status).toBe(200)

        await waitFor(
          () => messages.map((m) => m.event_type),
          (types) =>
            types.includes('loop.observe') &&
            types.includes('loop.think') &&
            types.includes('loop.reflect'),
          60_000
        )

        for (const msg of messages) {
          if (!msg || typeof msg !== 'object') continue
          if (typeof msg.event_type !== 'string') continue
          if (!msg.event_type.startsWith('loop.')) continue

          expect(typeof msg.agent_did).toBe('string')
          expect(String(msg.agent_did)).toMatch(/^did:cf:/)
          expect(String(msg.trace_id)).toMatch(/^[0-9a-f]{32}$/)
          expect(String(msg.span_id)).toMatch(/^[0-9a-f]{16}$/)
        }

        // Stale connection handling: disconnect and ensure loop keeps ticking.
        ws.close()

        await waitFor(
          async () => {
            const res = await fetch(new URL(`/agents/${agentName}/loop/status`, httpBase), {
              headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
            })
            expect(res.status).toBe(200)
            return (await res.json()) as { loopCount: number }
          },
          (status) => status.loopCount >= 2,
          60_000,
          1000
        )
      } finally {
        try {
          await fetch(new URL(`/agents/${agentName}/loop/stop`, httpBase), {
            method: 'POST',
            headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
          })
        } catch {
          // ignore cleanup failures in live env
        }
      }
    },
    120_000
  )
})

