import { normalizeAgentEvent, summarizeLexiconRecord, type DashboardActivityEvent } from './activity'
import { renderEnvironmentCards, type EnvironmentDetail } from './environments'

type AgentCardState = {
  name: string
  displayName: string
  did?: string
  createdAt?: number
  publicKeys?: Record<string, unknown>
  memories?: number
  config?: {
    name: string
    personality: string
    specialty: string
    model: string
    fastModel: string
    loopIntervalMs: number
    goals: Array<{
      id: string
      description: string
      priority: number
      status: string
      progress: number
      createdAt: number
      completedAt?: number
    }>
    enabledTools: string[]
  }
  loop?: {
    loopRunning?: boolean
    loopCount?: number
    nextAlarm?: number | null
    // When we only have websocket loop.sleep context
    nextAlarmAt?: number | null
    lastLoopEventAt?: string
  }
  lastGoalsFingerprint?: string
  environments?: {
    loading: boolean
    error?: string
    items: EnvironmentDetail[]
    fetchedAt?: number
  }
}

const API_BASE =
  window.location.hostname === 'localhost'
    ? 'http://localhost:8787'
    : 'https://agent-network.joelhooks.workers.dev'

const WS_BASE = API_BASE.replace('https://', 'wss://').replace('http://', 'ws://')

const state: {
  agents: Map<string, AgentCardState>
  events: DashboardActivityEvent[]
  stats: { memories: number; messages: number }
  networkBirthday: number | null
  wsByAgent: Map<string, WebSocket>
  expandedAgent: string | null
} = {
  agents: new Map(),
  events: [],
  stats: { memories: 0, messages: 0 },
  networkBirthday: null,
  wsByAgent: new Map(),
  expandedAgent: null,
}

function getAdminToken(): string | null {
  const t = localStorage.getItem('adminToken')
  return t && t.trim().length ? t : null
}

async function fetchJson(url: string, opts?: { admin?: boolean }): Promise<any> {
  const headers: Record<string, string> = {}
  if (opts?.admin) {
    const token = getAdminToken()
    if (!token) throw new Error('admin token missing')
    headers.Authorization = `Bearer ${token}`
  }
  const res = await fetch(url, { headers })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json()
}

function addEvent(ev: DashboardActivityEvent) {
  const key = `${ev.agent}:${ev.type}:${ev.timestamp}:${ev.summary}`
  if ((addEvent as any)._seen?.has(key)) return
  ;(addEvent as any)._seen ??= new Set<string>()
  ;(addEvent as any)._seen.add(key)

  state.events.push(ev)
  state.events.sort((a, b) => (new Date(b.timestamp).getTime() || 0) - (new Date(a.timestamp).getTime() || 0))
  state.events = state.events.slice(0, 250)
}

function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return ''
  const div = document.createElement('div')
  div.textContent = String(str)
  return div.innerHTML
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

function truncate(str: unknown, max = 140): string {
  const s = typeof str === 'string' ? str : str === null || str === undefined ? '' : String(str)
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function truncateDid(did: unknown): string {
  const s = typeof did === 'string' ? did : ''
  if (!s || s.length < 20) return s
  const parts = s.split(':')
  if (parts.length >= 3) return `${parts[0]}:${parts[1]}:${parts[2].slice(0, 8)}…`
  return s.slice(0, 12) + '…'
}

/** Replace full DIDs with clickable truncated spans (for HTML contexts) */
function didToClickable(text: string): string {
  return text.replace(/did:[a-z]+:[a-f0-9]{16,}/g, (fullDid) => {
    const short = truncateDid(fullDid)
    return `<span class="did-copy" title="Click to copy: ${fullDid}" data-did="${fullDid}">${escapeHtml(short)}</span>`
  })
}

/** Same but for already-escaped HTML — operates on the escaped DID pattern */
function didToClickableInHtml(html: string): string {
  return html.replace(/did:[a-z]+:[a-f0-9]{16,}/g, (fullDid) => {
    const short = truncateDid(fullDid)
    return `<span class="did-copy" title="Click to copy: ${fullDid}" data-did="${fullDid}">${escapeHtml(short)}</span>`
  })
}

function resolveDidToName(did: string): string {
  for (const [name, agent] of state.agents) {
    if (agent.did === did) return name
  }
  return truncateDid(did)
}

function heartbeatActive(agent: AgentCardState): boolean {
  const next =
    agent.loop?.nextAlarmAt ??
    (typeof agent.loop?.nextAlarm === 'number' ? agent.loop?.nextAlarm : null)
  if (!next) return false
  const running = agent.loop?.loopRunning
  // If we only have nextAlarmAt from websocket loop.sleep, assume running when it's in the future.
  if (running === false) return false
  return Date.now() < next + 2_000
}

function statusPill(agent: AgentCardState): string {
  const loopRunning = agent.loop?.loopRunning
  const next =
    agent.loop?.nextAlarmAt ??
    (typeof agent.loop?.nextAlarm === 'number' ? agent.loop?.nextAlarm : null)
  const count = typeof agent.loop?.loopCount === 'number' ? agent.loop.loopCount : null

  const parts: string[] = []
  if (loopRunning === true) parts.push('running')
  if (loopRunning === false) parts.push('stopped')
  if (count !== null) parts.push(`iter:${count}`)
  if (typeof next === 'number') parts.push(`next:${new Date(next).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`)
  return parts.length ? parts.join(' · ') : 'loop: unknown'
}

function goalStatusClass(status: string): string {
  switch (status) {
    case 'completed':
      return 'goal-status completed'
    case 'in_progress':
      return 'goal-status in_progress'
    case 'blocked':
      return 'goal-status blocked'
    case 'cancelled':
      return 'goal-status cancelled'
    case 'pending':
    default:
      return 'goal-status pending'
  }
}

function recentThinkAloud(agentName: string): string[] {
  return state.events
    .filter((e) => e.agent === agentName && e.type === 'agent.think_aloud')
    .slice(0, 3)
    .map((e) => e.summary)
}

function renderAgents() {
  const el = document.getElementById('agentsList')!
  const agents = Array.from(state.agents.values()).sort((a, b) => a.name.localeCompare(b.name))

  document.getElementById('agentCount')!.textContent = String(agents.length)
  document.getElementById('agentBadge')!.textContent = String(agents.length)

  if (!agents.length) {
    el.innerHTML =
      '<div class="empty"><div class="empty-icon">🔍</div><div class="empty-text">Discovering agents...</div></div>'
    return
  }

  el.innerHTML = agents
    .map((a) => {
      const active = state.expandedAgent === a.name
      const hb = heartbeatActive(a)
      const goals = a.config?.goals ?? []
      const think = recentThinkAloud(a.name)

      const model = a.config?.model ? truncate(a.config.model, 22) : '—'
      const personalitySnippet = a.config?.personality ? truncate(a.config.personality.trim(), 220) : '—'
      const loopLine = statusPill(a)
      const envState = a.environments
      const envHtml = (() => {
        if (!active) return ''
        if (!getAdminToken()) return '<div class="detail-empty">Admin token required to load environments.</div>'
        if (!envState) return '<div class="detail-empty">Loading environments...</div>'
        if (envState.loading) return '<div class="detail-empty">Loading environments...</div>'
        if (envState.error) return `<div class="detail-empty">Failed to load environments: ${escapeHtml(envState.error)}</div>`
        return renderEnvironmentCards(envState.items, a.name)
      })()

      return `
        <div class="agent-card ${active ? 'active expanded' : ''}" data-name="${escapeHtml(a.name)}" role="button" tabindex="0">
          <div class="agent-title">
            <span class="heartbeat ${hb ? 'on' : ''}" title="${hb ? 'loop active' : 'loop idle'}"></span>
            <span class="agent-name">${escapeHtml(a.displayName || a.name)}</span>
          </div>
          <div class="agent-did" title="${escapeHtml(a.did ?? '')}">${escapeHtml(truncateDid(a.did ?? ''))}</div>
          <div class="agent-meta">
            <span class="agent-tag">🧠 ${a.memories ?? 0} mem</span>
            <span class="agent-tag">🤖 ${escapeHtml(model)}</span>
            <span class="agent-tag">⏱ ${escapeHtml(loopLine)}</span>
          </div>
          <div class="agent-detail">
            <div class="detail-grid">
              <div class="detail-block">
                <div class="detail-label">Goals</div>
                ${
                  goals.length
                    ? `<div class="goals">${goals
                        .slice()
                        .sort((g1, g2) => (g2.priority ?? 0) - (g1.priority ?? 0))
                        .slice(0, 8)
                        .map(
                          (g) => `
                          <div class="goal">
                            <span class="${goalStatusClass(String(g.status))}"></span>
                            <span class="goal-text">${escapeHtml(g.description)}</span>
                            <span class="goal-pct">${Number.isFinite(g.progress) ? Math.round(g.progress) : 0}%</span>
                          </div>
                        `
                        )
                        .join('')}</div>`
                    : `<div class="detail-empty">No goals yet.</div>`
                }
              </div>
              <div class="detail-block">
                <div class="detail-label">Loop</div>
                <div class="kv">
                  <div class="kv-row"><span class="kv-k">Heartbeat</span><span class="kv-v">${hb ? 'active' : 'idle'}</span></div>
                  <div class="kv-row"><span class="kv-k">Iteration</span><span class="kv-v">${typeof a.loop?.loopCount === 'number' ? a.loop.loopCount : '—'}</span></div>
                  <div class="kv-row"><span class="kv-k">Last event</span><span class="kv-v">${a.loop?.lastLoopEventAt ? escapeHtml(formatTime(a.loop.lastLoopEventAt)) : '—'}</span></div>
                  <div class="kv-row"><span class="kv-k">Next alarm</span><span class="kv-v">${
                    typeof (a.loop?.nextAlarmAt ?? a.loop?.nextAlarm) === 'number'
                      ? escapeHtml(
                          new Date(Number(a.loop?.nextAlarmAt ?? a.loop?.nextAlarm)).toLocaleString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })
                        )
                      : '—'
                  }</span></div>
                </div>
              </div>
              <div class="detail-block">
                <div class="detail-label">Config</div>
                <div class="kv">
                  <div class="kv-row"><span class="kv-k">Model</span><span class="kv-v">${escapeHtml(a.config?.model ?? '—')}</span></div>
                  <div class="kv-row"><span class="kv-k">Fast</span><span class="kv-v">${escapeHtml(a.config?.fastModel ?? '—')}</span></div>
                  <div class="kv-row"><span class="kv-k">Interval</span><span class="kv-v">${typeof a.config?.loopIntervalMs === 'number' ? escapeHtml(formatUptime(a.config.loopIntervalMs)) : '—'}</span></div>
                  <div class="kv-row"><span class="kv-k">Tools</span><span class="kv-v">${Array.isArray(a.config?.enabledTools) ? a.config!.enabledTools.length : 0}</span></div>
                </div>
              </div>
              <div class="detail-block detail-wide">
                <div class="detail-label">Personality</div>
                <div class="mono-box">${escapeHtml(personalitySnippet)}</div>
              </div>
              <div class="detail-block detail-wide">
                <div class="detail-label">Recent think_aloud</div>
                ${
                  think.length
                    ? `<div class="thoughts">${think.map((t) => `<div class="thought-line">${escapeHtml(t)}</div>`).join('')}</div>`
                    : `<div class="detail-empty">No think_aloud yet.</div>`
                }
              </div>
              <div class="detail-block detail-wide">
                <div class="detail-label">Environments</div>
                ${envHtml}
              </div>
            </div>
          </div>
        </div>
      `
    })
    .join('')
}

function eventIcon(kind: string): { icon: string; cls: string } {
  if (kind === 'memory') return { icon: '🧠', cls: 'memory' }
  if (kind === 'message') return { icon: '💬', cls: 'message' }
  if (kind === 'identity') return { icon: '🔑', cls: 'identity' }
  if (kind === 'prompt') return { icon: '🤖', cls: 'prompt' }
  if (kind === 'tool') return { icon: '🔧', cls: 'tool' }
  if (kind === 'think_aloud') return { icon: '…', cls: 'thought' }
  if (kind === 'loop') return { icon: '⟳', cls: 'loop' }
  if (kind === 'goal') return { icon: '◎', cls: 'goal' }
  if (kind === 'error') return { icon: '⚠', cls: 'system' }
  return { icon: '⚡', cls: 'system' }
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function getEventContext(ev: DashboardActivityEvent): Record<string, unknown> | null {
  const details = asPlainObject(ev.details) ?? {}
  const ctx = asPlainObject(details.context)
  // If this is a "real" agent event, details.context is where structured data lives.
  if (ctx) return ctx
  // For memory-record-derived events, we often store record metadata directly in `details`.
  return Object.keys(details).length ? details : null
}

function renderFeed() {
  const el = document.getElementById('activityFeed')!
  document.getElementById('memoryCount')!.textContent = String(state.stats.memories)
  document.getElementById('messageCount')!.textContent = String(state.stats.messages)

  if (state.networkBirthday) {
    const ms = Date.now() - state.networkBirthday
    document.getElementById('uptimeDisplay')!.textContent = formatUptime(ms)
  }

  if (!state.events.length) {
    el.innerHTML =
      '<div class="empty"><div class="empty-icon">📡</div><div class="empty-text">Waiting for activity...</div></div>'
    return
  }

  el.innerHTML = state.events.slice(0, 120).map((ev) => renderEvent(ev)).join('')
}

function renderEvent(ev: DashboardActivityEvent): string {
  const { icon, cls } = eventIcon(ev.kind)
  const isThought = ev.kind === 'think_aloud'
  const ctx = getEventContext(ev)
  const isToolish = ev.kind === 'tool' || ev.type.includes('tool') || Boolean((ctx as any)?.tool)

  // Render DIDs as truncated clickable spans (copy full DID on click)
  let body = `<div class="event-body ${isThought ? 'thought-body' : ''}">${didToClickableInHtml(escapeHtml(ev.summary))}</div>`

  if (ev.text) {
    body += `<div class="memory-text">${didToClickableInHtml(escapeHtml(ev.text))}</div>`
  }

  const tags = [...(ev.tags ?? [])]
  if (isToolish && !tags.includes('tool')) tags.push('tool')
  if (tags.length) {
    body += `<div class="event-tags">${tags
      .slice(0, 8)
      .map((t) => `<span class="event-tag">${escapeHtml(t)}</span>`)
      .join('')}</div>`
  }

  const details = asPlainObject(ev.details) ?? {}
  const err = asPlainObject(details.error)

  if (ctx) {
    if (ev.kind === 'goal' && Array.isArray((ctx as any).goals)) {
      const goals = ((ctx as any).goals as unknown[]).filter((g) => g && typeof g === 'object' && !Array.isArray(g)) as Array<
        Record<string, unknown>
      >
      body += `<div class="inline-block"><div class="inline-label">Goals</div><div class="goals compact">${goals
        .slice()
        .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0))
        .slice(0, 6)
        .map((g) => {
          const status = String(g.status ?? 'pending')
          const desc = String(g.description ?? '')
          const pct = typeof g.progress === 'number' && Number.isFinite(g.progress) ? Math.round(g.progress) : 0
          return `<div class="goal"><span class="${goalStatusClass(status)}"></span><span class="goal-text">${escapeHtml(
            desc
          )}</span><span class="goal-pct">${pct}%</span></div>`
        })
        .join('')}</div></div>`
    } else if (ev.kind === 'message') {
      const sender = typeof (ctx as any).sender === 'string' ? (ctx as any).sender : null
      const recipient = typeof (ctx as any).recipient === 'string' ? (ctx as any).recipient : null
      const content = asPlainObject((ctx as any).content)
      const kind = content && typeof content.kind === 'string' ? content.kind : null
      if (sender || recipient || kind) {
        const senderName = sender ? resolveDidToName(sender) : null
        const recipientName = recipient ? resolveDidToName(recipient) : null
        body += `<div class="inline-block"><div class="inline-label">Message</div><div class="inline-kv">${
          senderName && recipientName ? `${escapeHtml(senderName)} → ${escapeHtml(recipientName)}` : escapeHtml(senderName ?? recipientName ?? '—')
        }${kind ? ` <span class="chip">kind:${escapeHtml(kind)}</span>` : ''}</div></div>`
      }
    } else if (ev.kind === 'tool') {
      const tool =
        typeof (ctx as any).toolName === 'string'
          ? (ctx as any).toolName
          : typeof (ctx as any).tool === 'string'
            ? (ctx as any).tool
            : asPlainObject((ctx as any).tool) && typeof (asPlainObject((ctx as any).tool)!.name) === 'string'
              ? String(asPlainObject((ctx as any).tool)!.name)
              : null
      const args = (ctx as any).arguments ?? (ctx as any).args ?? (ctx as any).input
      if (tool || args !== undefined) {
        body += `<div class="inline-block"><div class="inline-label">Tool</div><div class="inline-kv">${escapeHtml(
          tool ?? 'tool'
        )}</div></div>`
      }
    }

    // Show raw context as a collapsible block (trim very large payloads by truncating stringified output).
    const json = JSON.stringify(ctx, null, 2)
    if (json && json !== '{}' && json.length < 25_000) {
      body += `<details class="event-details"><summary>details</summary><pre>${didToClickableInHtml(escapeHtml(json))}</pre></details>`
    }
  }
  if (err) {
    body += `<details class="event-details error"><summary>error</summary><pre>${escapeHtml(
      JSON.stringify(err, null, 2)
    )}</pre></details>`
  }

  return `
    <div class="event ${isThought ? 'event-thought' : ''}">
      <div class="event-icon ${cls}">${escapeHtml(icon)}</div>
      <div class="event-content">
        <div class="event-header">
          <span class="event-agent">${didToClickableInHtml(escapeHtml(ev.agent))}<span class="event-type">${escapeHtml(ev.type)}</span></span>
          <span class="event-time">${escapeHtml(formatTime(ev.timestamp))}</span>
        </div>
        ${body}
      </div>
    </div>
  `
}

function updateStatus(status: 'online' | 'connecting' | 'offline') {
  const dot = document.getElementById('statusDot')!
  const text = document.getElementById('statusText')!
  dot.className = 'status-dot ' + status
  text.textContent = status === 'online' ? 'connected' : status === 'connecting' ? 'connecting...' : 'offline'
}

async function fetchHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`)
    const data = (await res.json().catch(() => null)) as unknown
    if (data && typeof data === 'object' && !Array.isArray(data) && 'status' in data && (data as any).status === 'ok') {
      updateStatus('online')
    }
    else updateStatus('connecting')
  } catch {
    updateStatus('offline')
  }
}

async function fetchAgent(name: string) {
  const existing: AgentCardState =
    state.agents.get(name) ?? {
      name,
      displayName: name.charAt(0).toUpperCase() + name.slice(1),
    }

  try {
    const [identity, config] = await Promise.all([
      fetchJson(`${API_BASE}/agents/${encodeURIComponent(name)}/identity`).catch(() => null),
      fetchJson(`${API_BASE}/agents/${encodeURIComponent(name)}/config`).catch(() => null),
    ])

    if (identity && typeof identity === 'object') {
      existing.did = typeof (identity as any).did === 'string' ? (identity as any).did : existing.did
      existing.createdAt = typeof (identity as any).createdAt === 'number' ? (identity as any).createdAt : existing.createdAt
      existing.publicKeys = (identity as any).publicKeys ?? existing.publicKeys
      if (typeof (identity as any).createdAt === 'number') {
        if (!state.networkBirthday || (identity as any).createdAt < state.networkBirthday) {
          state.networkBirthday = (identity as any).createdAt
        }
      }
    }

    if (config && typeof config === 'object') {
      existing.config = config as any

      const goals = Array.isArray((config as any).goals) ? (config as any).goals : []
      const fp = JSON.stringify(
        goals
          .slice()
          .sort((a: any, b: any) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')))
          .map((g: any) => ({ id: g.id, status: g.status, progress: g.progress, description: g.description, priority: g.priority }))
      )

      if (existing.lastGoalsFingerprint && existing.lastGoalsFingerprint !== fp) {
        addEvent({
          type: 'agent.goals.updated',
          agent: name,
          kind: 'goal',
          summary: `Goals updated (${goals.length})`,
          timestamp: new Date().toISOString(),
          details: { context: { goals } },
        })
      }
      existing.lastGoalsFingerprint = fp
    }

    // Protected but useful: loop status.
    if (getAdminToken()) {
      const loop = await fetchJson(`${API_BASE}/agents/${encodeURIComponent(name)}/loop/status`, { admin: true }).catch(() => null)
      if (loop && typeof loop === 'object') {
        existing.loop = {
          ...(existing.loop ?? {}),
          loopRunning: Boolean((loop as any).loopRunning),
          loopCount: typeof (loop as any).loopCount === 'number' ? (loop as any).loopCount : existing.loop?.loopCount,
          nextAlarm: typeof (loop as any).nextAlarm === 'number' ? (loop as any).nextAlarm : null,
        }
      }
    }

    // Memory list (keep small, used for counts + initial feed population).
    const memory = await fetchJson(`${API_BASE}/agents/${encodeURIComponent(name)}/memory?limit=50`).catch(() => ({ entries: [] }))
    const entries = Array.isArray(memory?.entries) ? memory.entries : []
    existing.memories = entries.length

    // Recompute stats across agents.
    state.stats.memories = 0
    state.stats.messages = 0
    for (const [, a] of state.agents) {
      state.stats.memories += a.memories ?? 0
    }
    for (const entry of entries) {
      const record = entry?.record
      const s = summarizeLexiconRecord(record)
      if (s.kind === 'message') state.stats.messages += 1
      addEvent({
        type: typeof (record as any)?.$type === 'string' ? (record as any).$type : 'agent.record',
        agent: name,
        kind: s.kind,
        summary: s.summary,
        text: s.text,
        tags: s.tags,
        timestamp: (s.timestamp ?? (record as any)?.createdAt ?? new Date().toISOString()) as string,
        details: s.details,
      })
    }

    state.agents.set(name, existing)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    addEvent({
      type: 'dashboard.error',
      agent: name,
      kind: 'error',
      summary: `Failed to fetch agent data: ${message}`,
      timestamp: new Date().toISOString(),
    })
  }
}

function normalizeEnvironmentDetail(value: any): EnvironmentDetail | null {
  if (!value || typeof value !== 'object') return null
  const id = typeof value.id === 'string' ? value.id : null
  const type = typeof value.type === 'string' ? value.type : null
  const hostAgent = typeof value.hostAgent === 'string' ? value.hostAgent : 'unknown'
  const phase = typeof value.phase === 'string' ? value.phase : 'unknown'
  const players = Array.isArray(value.players) ? value.players.filter((p: any) => typeof p === 'string') : []
  if (!id || !type) return null
  return {
    id,
    type,
    hostAgent,
    phase,
    players,
    winner: typeof value.winner === 'string' ? value.winner : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
    state: (value as any).state,
  }
}

async function loadAgentEnvironments(agentName: string) {
  const agent = state.agents.get(agentName)
  if (!agent) return
  if (!getAdminToken()) return

  const now = Date.now()
  const existing = agent.environments
  if (existing?.loading) return
  if (existing?.fetchedAt && now - existing.fetchedAt < 10_000) return

  agent.environments = {
    loading: true,
    items: existing?.items ?? [],
    fetchedAt: existing?.fetchedAt,
  }
  state.agents.set(agentName, agent)
  renderAgents()

  try {
    const list = await fetchJson(`${API_BASE}/environments?player=${encodeURIComponent(agentName)}`, { admin: true })
    const envs = Array.isArray(list?.environments) ? list.environments : []

    // Dashboard wants active environments; exclude finished, keep ordering from API (updated_at DESC).
    const active = envs.filter((e: any) => e && typeof e === 'object' && String(e.phase ?? '') !== 'finished')

    const details = await Promise.all(
      active.map(async (e: any) => {
        const id = typeof e?.id === 'string' ? e.id : null
        if (!id) return null
        try {
          const detail = await fetchJson(`${API_BASE}/environments/${encodeURIComponent(id)}`, { admin: true })
          return normalizeEnvironmentDetail(detail)
        } catch {
          // Fall back to the list payload if detail fetch fails.
          return normalizeEnvironmentDetail({ ...e, state: null })
        }
      })
    )

    agent.environments = {
      loading: false,
      items: details.filter(Boolean) as EnvironmentDetail[],
      fetchedAt: now,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    agent.environments = { loading: false, items: existing?.items ?? [], fetchedAt: now, error: message }
  }

  state.agents.set(agentName, agent)
  renderAgents()
}

function connectAgentWebSocket(agentName: string) {
  if (state.wsByAgent.has(agentName)) return

  try {
    const wsUrl = `${WS_BASE}/agents/${encodeURIComponent(agentName)}/ws`
    const ws = new WebSocket(wsUrl)
    state.wsByAgent.set(agentName, ws)

    ws.onopen = () => {
      document.getElementById('wsIndicator')!.textContent = '⚡ live'
      document.getElementById('wsIndicator')!.className = 'ws-indicator live'
      document.getElementById('feedBadge')!.textContent = '⚡ live'
    }

    ws.onmessage = (event) => {
      const data = safeJsonParse(event.data)
      const normalized = normalizeAgentEvent(data, { agentNameHint: agentName })
      if (!normalized) return

      const agent = state.agents.get(agentName)
      if (agent) {
        agent.loop ??= {}
        agent.loop.lastLoopEventAt = normalized.timestamp
        if (normalized.type === 'loop.sleep') {
          const nextAlarmAt = (normalized.details?.context as any)?.nextAlarmAt
          if (typeof nextAlarmAt === 'number' && Number.isFinite(nextAlarmAt)) {
            agent.loop.nextAlarmAt = nextAlarmAt
          }
        }
        if (normalized.type === 'loop.started') {
          agent.loop.loopRunning = true
        }
        if (normalized.type === 'loop.error') {
          // no-op; rendered in feed
        }
      }

      addEvent(normalized)
      renderAgents()
      renderFeed()
    }

    ws.onclose = () => {
      state.wsByAgent.delete(agentName)
      document.getElementById('wsIndicator')!.textContent = '◯ polling'
      document.getElementById('wsIndicator')!.className = 'ws-indicator'
      document.getElementById('feedBadge')!.textContent = 'polling'
      setTimeout(() => connectAgentWebSocket(agentName), 5_000)
    }

    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function safeJsonParse(input: unknown): unknown {
  if (typeof input !== 'string') return null
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

async function pollAgents() {
  await fetchHealth()

  // If admin token is present, prefer the registry list (includes config).
  const token = getAdminToken()
  if (token) {
    try {
      const list = await fetchJson(`${API_BASE}/agents`, { admin: true })
      const agents = Array.isArray(list?.agents) ? list.agents : []
      for (const a of agents) {
        if (!a || typeof a !== 'object') continue
        const name = typeof (a as any).name === 'string' ? (a as any).name : null
        if (!name) continue
        state.agents.set(name, {
          ...(state.agents.get(name) ?? { name, displayName: name.charAt(0).toUpperCase() + name.slice(1) }),
          did: typeof (a as any).did === 'string' ? (a as any).did : undefined,
          createdAt: typeof (a as any).createdAt === 'number' ? (a as any).createdAt : undefined,
          publicKeys: (a as any).publicKeys ?? undefined,
          config: (a as any).config ?? undefined,
        })
      }
    } catch {
      // fall back to known agents
    }
  }

  const knownFallback = ['grimlock', 'swoop', 'sludge']
  const names = state.agents.size ? Array.from(state.agents.keys()) : knownFallback

  for (const name of names) {
    await fetchAgent(name)
    connectAgentWebSocket(name)
  }

  renderAgents()
  renderFeed()
}

function checkTokenFromQuery() {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token')
  if (token) {
    localStorage.setItem('adminToken', token)
    window.history.replaceState({}, '', window.location.pathname)
  }
}

function bindUI() {
  const agentsList = document.getElementById('agentsList')!
  agentsList.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null
    const card = target?.closest?.('.agent-card') as HTMLElement | null
    if (!card) return
    const name = card.dataset.name
    if (!name) return
    state.expandedAgent = state.expandedAgent === name ? null : name
    renderAgents()
    if (state.expandedAgent === name) {
      loadAgentEnvironments(name)
    }
  })

  // Click-to-copy for truncated DIDs (delegated to document)
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null
    if (!target?.classList?.contains('did-copy')) return
    const fullDid = target.dataset.did
    if (!fullDid) return
    navigator.clipboard.writeText(fullDid).then(() => {
      target.classList.add('copied')
      const orig = target.textContent
      target.textContent = 'copied!'
      setTimeout(() => {
        target.classList.remove('copied')
        target.textContent = orig
      }, 1200)
    }).catch(() => {
      // Fallback: select the text
      const range = document.createRange()
      range.selectNodeContents(target)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    })
  })
}

function start() {
  checkTokenFromQuery()
  bindUI()
  pollAgents()
  setInterval(pollAgents, 15_000)

  // Network age display
  setInterval(() => {
    if (!state.networkBirthday) return
    const ms = Date.now() - state.networkBirthday
    document.getElementById('uptimeDisplay')!.textContent = formatUptime(ms)
  }, 1_000)
}

start()
