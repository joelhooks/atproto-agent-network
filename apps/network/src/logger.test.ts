import { describe, expect, it, vi, afterEach } from 'vitest'

import { createLogger, logEvent } from './logger'

function parseJsonLogs(calls: Array<unknown[]>): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const call of calls) {
    const first = call[0]
    if (typeof first !== 'string') continue
    try {
      const parsed = JSON.parse(first)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>)
      }
    } catch {
      // ignore non-JSON logs
    }
  }
  return events
}

describe('logger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logEvent() emits a single-line JSON object with timestamp + event_type', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})

    logEvent({
      event_type: 'agent.cycle.start',
      level: 'info',
      did: 'did:cf:test-agent',
      context: { phase: 'alarm' },
    })

    const events = parseJsonLogs(spy.mock.calls)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event_type: 'agent.cycle.start',
      level: 'info',
      did: 'did:cf:test-agent',
      context: { phase: 'alarm' },
    })
    expect(typeof events[0]!.timestamp).toBe('string')
  })

  it('createLogger() merges base fields into each event', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const logger = createLogger({ did: 'did:cf:base', component: 'agent-do' })
    logger.info('agent.goal.update', { context: { goalCount: 2 } })

    const events = parseJsonLogs(spy.mock.calls)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event_type: 'agent.goal.update',
      level: 'info',
      did: 'did:cf:base',
      component: 'agent-do',
      context: { goalCount: 2 },
    })
  })
})

