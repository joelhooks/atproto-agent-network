import { useState } from 'react'
import type { EnvironmentDetail } from '../lib/types'
import { Badge } from './ui/Badge'

function envIcon(type: string): string {
  switch (type) {
    case 'catan': return '\uD83E\uDDF1'
    case 'rpg': return '\uD83D\uDDE1'
    default: return '\uD83C\uDF10'
  }
}

function envLabel(id: string, type: string): string {
  const nice = type === 'catan' ? 'Catan' : type === 'rpg' ? 'RPG' : type
  const suffix = id.includes('_') ? id.split('_').slice(1).join('_') : id
  return suffix && suffix !== id ? `${nice} #${suffix}` : nice
}

function safeObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function safeArr(v: unknown): unknown[] { return Array.isArray(v) ? v : [] }
function safeNum(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null }

function CatanSummary({ state, agentName }: { state: Record<string, unknown>; agentName: string }) {
  const players = safeArr(state.players).map(safeObj).filter(Boolean) as Record<string, unknown>[]
  const me = players.find(p => String(p.name ?? '') === agentName) ?? players[0]
  const vp = safeNum(me?.victoryPoints) ?? 0
  const settlements = safeArr(me?.settlements).length
  const roads = safeArr(me?.roads).length
  const res = safeObj(me?.resources) ?? {}
  const resLine = ['wood', 'brick', 'sheep', 'wheat', 'ore'].map(r => `${r}:${safeNum((res as any)[r]) ?? 0}`).join(' ')

  return (
    <div className="env-summary">
      <div style={{ marginBottom: '0.25rem' }}>VP {vp} | settle {settlements} | roads {roads}</div>
      <div>{resLine}</div>
      {players.length > 1 && (
        <div style={{ marginTop: '0.375rem', display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
          {players.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{String(p.name ?? 'unknown')}</span>
              <span>VP {safeNum(p.victoryPoints) ?? 0}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RpgSummary({ state, agentName }: { state: Record<string, unknown>; agentName: string }) {
  const party = safeArr(state.party).map(safeObj).filter(Boolean) as Record<string, unknown>[]
  const me = party.find(p => String(p.name ?? '') === agentName) ?? party[0]
  const klass = String(me?.klass ?? 'Unknown')
  const hp = safeNum(me?.hp) ?? 0
  const maxHp = safeNum(me?.maxHp) ?? hp
  const roomIndex = safeNum(state.roomIndex) ?? 0
  const dungeon = safeArr(state.dungeon).map(safeObj).filter(Boolean) as Record<string, unknown>[]
  const room = dungeon[roomIndex]
  const roomType = room ? String(room.type ?? 'unknown') : 'unknown'

  return (
    <div className="env-summary">
      <div>{klass} | HP {hp}/{maxHp} | room: {roomType}</div>
      {party.length > 1 && (
        <div style={{ marginTop: '0.375rem', display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
          {party.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{String(p.name ?? 'unknown')} ({String(p.klass ?? '?')})</span>
              <span>HP {safeNum(p.hp) ?? 0}/{safeNum(p.maxHp) ?? 0}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function EnvironmentCard({ env, agentName }: { env: EnvironmentDetail; agentName: string }) {
  const [showRaw, setShowRaw] = useState(false)
  const stateObj = safeObj(env.state)
  const others = env.players.filter(p => p !== agentName)

  return (
    <div className="env-card">
      <div className="env-card-header">
        <span>{envIcon(env.type)}</span>
        <span className="env-card-name">{envLabel(env.id, env.type)}</span>
        <Badge variant={env.phase === 'playing' ? 'accent' : 'dim'}>{env.phase}</Badge>
        <div style={{ flex: 1 }} />
        {others.length > 0 && <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--dim)' }}>vs {others.join(', ')}</span>}
      </div>
      {env.type === 'catan' && stateObj ? <CatanSummary state={stateObj} agentName={agentName} /> :
       env.type === 'rpg' && stateObj ? <RpgSummary state={stateObj} agentName={agentName} /> :
       stateObj ? <div className="env-summary">State available</div> : null}
      {stateObj && (
        <button onClick={() => setShowRaw(!showRaw)} className="env-raw-toggle">
          {showRaw ? 'hide' : 'show'} raw state
        </button>
      )}
      {showRaw && <pre className="env-raw-pre">{JSON.stringify(env.state, null, 2)}</pre>}
    </div>
  )
}
