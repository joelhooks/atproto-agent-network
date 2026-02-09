export type EnvironmentListItem = {
  id: string
  type: string
  hostAgent: string
  phase: string
  players: string[]
  winner: string | null
  createdAt?: string
  updatedAt?: string
}

export type EnvironmentDetail = EnvironmentListItem & {
  state: unknown
}

function escapeHtml(input: unknown): string {
  const s = input === null || input === undefined ? '' : String(input)
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function envIcon(type: string): string {
  switch (type) {
    case 'catan':
      return '🧱'
    case 'rpg':
      return '🗡'
    default:
      return '🌐'
  }
}

function envLabel(id: string, type: string): string {
  const nice = type === 'catan' ? 'Catan' : type === 'rpg' ? 'RPG' : type
  const suffix = id.includes('_') ? id.split('_').slice(1).join('_') : id
  // Keep it short and human.
  return suffix && suffix !== id ? `${nice} #${suffix}` : nice
}

function safeObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function renderCatanSummary(state: Record<string, unknown>, agentName: string): { statsLine: string; detailHtml: string } {
  const players = safeArray(state.players).map(safeObject).filter(Boolean) as Array<Record<string, unknown>>
  const me = players.find((p) => String(p.name ?? '') === agentName) ?? players[0] ?? null

  const vp = safeNumber(me?.victoryPoints) ?? 0
  const settlements = safeArray(me?.settlements).length
  const roads = safeArray(me?.roads).length
  const resources = safeObject(me?.resources) ?? {}

  const resLine = ['wood', 'brick', 'sheep', 'wheat', 'ore']
    .map((r) => `${r}:${safeNumber((resources as any)[r]) ?? 0}`)
    .join(' ')

  const statsLine = `VP ${vp} | settle ${settlements} | roads ${roads} | ${resLine}`

  const rows = players
    .map((p) => {
      const name = String(p.name ?? 'unknown')
      const pvp = safeNumber(p.victoryPoints) ?? 0
      const psettle = safeArray(p.settlements).length
      const proads = safeArray(p.roads).length
      const pres = safeObject(p.resources) ?? {}
      const presLine = ['wood', 'brick', 'sheep', 'wheat', 'ore']
        .map((r) => `${r}:${safeNumber((pres as any)[r]) ?? 0}`)
        .join(' ')
      return `<div class="env-kv-row"><span class="env-k">${escapeHtml(name)}</span><span class="env-v">VP ${pvp} · settle ${psettle} · roads ${proads} · ${escapeHtml(
        presLine
      )}</span></div>`
    })
    .join('')

  const detailHtml = `
    <div class="env-section">
      <div class="env-section-title">Board summary</div>
      <div class="env-kv">${rows || '<div class="env-empty">No player state.</div>'}</div>
    </div>
    <details class="env-details"><summary>full state</summary><pre>${escapeHtml(toJson(state))}</pre></details>
  `.trim()

  return { statsLine, detailHtml }
}

function renderRpgSummary(state: Record<string, unknown>, agentName: string): { statsLine: string; detailHtml: string } {
  const party = safeArray(state.party).map(safeObject).filter(Boolean) as Array<Record<string, unknown>>
  const me = party.find((p) => String(p.name ?? '') === agentName) ?? party[0] ?? null

  const klass = String(me?.klass ?? 'Unknown')
  const hp = safeNumber(me?.hp) ?? 0
  const maxHp = safeNumber(me?.maxHp) ?? hp
  const mp = safeNumber(me?.mp) ?? 0
  const maxMp = safeNumber(me?.maxMp) ?? mp

  const skills = safeObject(me?.skills) ?? {}
  const skillLine = ['attack', 'dodge', 'cast_spell', 'use_skill']
    .map((k) => `${k}:${safeNumber((skills as any)[k]) ?? 0}`)
    .join(' ')

  const roomIndex = safeNumber(state.roomIndex) ?? 0
  const dungeon = safeArray(state.dungeon).map(safeObject).filter(Boolean) as Array<Record<string, unknown>>
  const room = dungeon[roomIndex] ?? null
  const roomType = room ? String(room.type ?? 'unknown') : 'unknown'
  const roomDesc = room ? String(room.description ?? '') : ''

  const statsLine = `${escapeHtml(klass)} | HP ${hp}/${maxHp} | MP ${mp}/${maxMp} | room ${escapeHtml(roomType)}`

  const partyRows = party
    .map((p) => {
      const name = String(p.name ?? 'unknown')
      const pklass = String(p.klass ?? 'Unknown')
      const php = safeNumber(p.hp) ?? 0
      const pmaxHp = safeNumber(p.maxHp) ?? php
      const pskills = safeObject(p.skills) ?? {}
      const pskillLine = ['attack', 'dodge', 'cast_spell', 'use_skill']
        .map((k) => `${k}:${safeNumber((pskills as any)[k]) ?? 0}`)
        .join(' ')
      return `<div class="env-kv-row"><span class="env-k">${escapeHtml(name)}</span><span class="env-v">${escapeHtml(
        pklass
      )} · HP ${php}/${pmaxHp} · ${escapeHtml(pskillLine)}</span></div>`
    })
    .join('')

  const detailHtml = `
    <div class="env-section">
      <div class="env-section-title">Character sheet</div>
      <div class="env-section-subtitle">Skills</div>
      <div class="env-kv">${partyRows || '<div class="env-empty">No party members.</div>'}</div>
    </div>
    <div class="env-section">
      <div class="env-section-title">Room</div>
      <div class="env-room">${escapeHtml(roomType)}${roomDesc ? `: ${escapeHtml(roomDesc)}` : ''}</div>
    </div>
    <details class="env-details"><summary>full state</summary><pre>${escapeHtml(toJson(state))}</pre></details>
  `.trim()

  return { statsLine, detailHtml }
}

function renderUnknownSummary(state: unknown): { statsLine: string; detailHtml: string } {
  return {
    statsLine: 'state available',
    detailHtml: `<details class="env-details"><summary>full state</summary><pre>${escapeHtml(toJson(state))}</pre></details>`,
  }
}

export function renderEnvironmentCard(env: EnvironmentDetail, agentName: string): string {
  const players = Array.isArray(env.players) ? env.players : []
  const others = players.filter((p) => p !== agentName)

  const stateObj = safeObject(env.state)
  const label = envLabel(env.id, env.type)

  let summary: { statsLine: string; detailHtml: string }
  if (env.type === 'catan' && stateObj) summary = renderCatanSummary(stateObj, agentName)
  else if (env.type === 'rpg' && stateObj) summary = renderRpgSummary(stateObj, agentName)
  else summary = renderUnknownSummary(env.state)

  return `
    <div class="env-card" data-env-id="${escapeHtml(env.id)}" data-env-type="${escapeHtml(env.type)}">
      <div class="env-head">
        <div class="env-title">
          <span class="env-icon" aria-hidden="true">${escapeHtml(envIcon(env.type))}</span>
          <span class="env-name">${escapeHtml(label)}</span>
          <span class="env-phase">${escapeHtml(env.phase)}</span>
        </div>
        <div class="env-meta">
          <span class="env-chip">host:${escapeHtml(env.hostAgent)}</span>
          <span class="env-chip">players:${escapeHtml(players.length)}</span>
          ${others.length ? `<span class="env-chip">others:${escapeHtml(others.join(', '))}</span>` : ''}
        </div>
      </div>
      <div class="env-stats">${summary.statsLine}</div>
      <div class="env-body">${summary.detailHtml}</div>
    </div>
  `.trim()
}

export function renderEnvironmentCards(envs: EnvironmentDetail[], agentName: string): string {
  if (!envs.length) return '<div class="env-empty">No environments.</div>'
  return `<div class="env-cards">${envs.map((e) => renderEnvironmentCard(e, agentName)).join('')}</div>`
}
