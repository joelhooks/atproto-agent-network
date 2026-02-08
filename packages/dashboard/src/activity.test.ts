import { describe, expect, it } from 'vitest'

import { normalizeAgentEvent, summarizeLexiconRecord } from './activity'

describe('dashboard activity utils', () => {
  it('normalizes agent.think_aloud websocket payloads', () => {
    const ev = normalizeAgentEvent(
      {
        id: 'tid_1',
        agent_did: 'did:cf:abc123',
        session_id: 'ses_1',
        event_type: 'agent.think_aloud',
        outcome: 'success',
        timestamp: '2026-02-08T01:02:03.000Z',
        trace_id: 'trace_1',
        span_id: 'span_1',
        context: { message: 'UI-only reasoning' },
      },
      { agentNameHint: 'grimlock' }
    )

    expect(ev).toBeTruthy()
    expect(ev!.type).toBe('agent.think_aloud')
    expect(ev!.agent).toBe('grimlock')
    expect(ev!.kind).toBe('think_aloud')
    expect(ev!.summary).toBe('UI-only reasoning')
    expect(ev!.timestamp).toBe('2026-02-08T01:02:03.000Z')
  })

  it('normalizes loop.sleep payloads into a human summary', () => {
    const ev = normalizeAgentEvent(
      {
        id: 'tid_2',
        agent_did: 'did:cf:abc123',
        session_id: 'ses_1',
        event_type: 'loop.sleep',
        outcome: 'success',
        timestamp: '2026-02-08T01:02:03.000Z',
        span_id: 'span_2',
        context: { intervalMs: 60000, nextAlarmAt: 1760000000000 },
      },
      { agentNameHint: 'grimlock' }
    )

    expect(ev).toBeTruthy()
    expect(ev!.kind).toBe('loop')
    expect(ev!.summary).toContain('Sleep')
    expect(ev!.summary).toContain('60s')
  })

  it('normalizes tool-call-ish payloads as kind=tool with tool name', () => {
    const ev = normalizeAgentEvent(
      {
        id: 'tid_3',
        agent_did: 'did:cf:abc123',
        session_id: 'ses_1',
        event_type: 'agent.tool.call',
        outcome: 'success',
        timestamp: '2026-02-08T01:02:03.000Z',
        span_id: 'span_3',
        context: { tool: { name: 'remember', arguments: { text: 'hello' } } },
      },
      { agentNameHint: 'grimlock' }
    )

    expect(ev).toBeTruthy()
    expect(ev!.kind).toBe('tool')
    expect(ev!.summary).toContain('remember')
  })

  it('summarizes agent.comms.message records with sender/recipient', () => {
    const rec = {
      $type: 'agent.comms.message',
      sender: 'did:cf:sender',
      recipient: 'did:cf:recipient',
      content: { kind: 'text', text: 'hello' },
      createdAt: '2026-02-08T01:02:03.000Z',
    }

    const summary = summarizeLexiconRecord(rec)
    expect(summary.kind).toBe('message')
    expect(summary.summary).toContain('did:cf:sender')
    expect(summary.summary).toContain('did:cf:recipient')
    expect(summary.text).toContain('hello')
  })
})
