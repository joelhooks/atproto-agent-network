/**
 * Agents of Catan — Simplified Catan for AI agents
 * 
 * Standard 19-hex board, 2-4 players, 10 VP to win.
 * Trading is the star mechanic.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type Resource = 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore'
export type HexType = Resource | 'desert'

export interface Hex {
  id: number
  type: HexType
  diceNumber: number | null // desert has no number
}

export interface Vertex {
  id: number
  hexIds: number[] // adjacent hex IDs
  owner: string | null // player name
}

export interface Edge {
  id: number
  vertices: [number, number]
  owner: string | null // player name
}

export interface PlayerState {
  name: string
  resources: Record<Resource, number>
  victoryPoints: number
  settlements: number[] // vertex IDs
  roads: number[] // edge IDs
}

export interface TradeOffer {
  id: string
  from: string
  to: string | 'bank'
  offering: Partial<Record<Resource, number>>
  requesting: Partial<Record<Resource, number>>
  status: 'pending' | 'accepted' | 'rejected' | 'countered' | 'expired'
}

export interface GameState {
  id: string
  phase: 'setup' | 'playing' | 'finished'
  turn: number
  currentPlayer: string
  players: PlayerState[]
  board: {
    hexes: Hex[]
    vertices: Vertex[]
    edges: Edge[]
  }
  lastDiceRoll: number | null
  trades: TradeOffer[]
  log: GameLogEntry[]
  winner: string | null
  setupRound: number // 1 or 2 during setup
}

export interface GameLogEntry {
  turn: number
  player: string
  action: string
  detail: string
  timestamp: number
}

// ─── Board Generation ────────────────────────────────────────────────

// Standard Catan: 19 hexes (4 wood, 3 brick, 4 sheep, 4 wheat, 3 ore, 1 desert)
const RESOURCE_TYPES: HexType[] = [
  'wood', 'wood', 'wood', 'wood',
  'brick', 'brick', 'brick',
  'sheep', 'sheep', 'sheep', 'sheep',
  'wheat', 'wheat', 'wheat', 'wheat',
  'ore', 'ore', 'ore',
  'desert',
]
// Standard number tokens (no 7 — that's robber)
const DICE_NUMBERS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]

// 7-hex flower pattern: center + 6 surrounding
// Each hex has vertices shared with neighbors
//
//    v0──v1
//   / h0  \
//  v5──v6──v2
//  |\ h5 /|\ h1 /|
//  v11─v7──v3
//  |/ h4 \|/ h2 \|
//  v10─v8──v4
//   \ h3  /
//    v9──v4
//
// Simplified: 12 vertices, 18 edges

function generateBoard(): { hexes: Hex[]; vertices: Vertex[]; edges: Edge[] } {
  // Shuffle resources
  const types = [...RESOURCE_TYPES]
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[types[i], types[j]] = [types[j], types[i]]
  }

  // Shuffle dice numbers (skip desert)
  const numbers = [...DICE_NUMBERS]
  for (let i = numbers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[numbers[i], numbers[j]] = [numbers[j], numbers[i]]
  }

  let numIdx = 0
  const hexes: Hex[] = types.map((type, id) => ({
    id,
    type,
    diceNumber: type === 'desert' ? null : numbers[numIdx++] ?? null,
  }))

  // Standard Catan board: 19 hexes arranged in rows of 3-4-5-4-3
  // 54 vertices, 72 edges
  // Hex layout (row by row):
  //   Row 0: hexes 0,1,2       (3 hexes)
  //   Row 1: hexes 3,4,5,6     (4 hexes)
  //   Row 2: hexes 7,8,9,10,11 (5 hexes)
  //   Row 3: hexes 12,13,14,15 (4 hexes)
  //   Row 4: hexes 16,17,18    (3 hexes)
  //
  // Each hex has 6 vertices. We deduplicate shared vertices.
  // Using axial coordinates to generate topology programmatically.

  const hexCoords: [number, number][] = [
    // Row 0 (q=-1..1, r=-2)
    [-1,-2], [0,-2], [1,-2],
    // Row 1 (q=-2..1, r=-1)
    [-2,-1], [-1,-1], [0,-1], [1,-1],
    // Row 2 (q=-2..2, r=0)
    [-2,0], [-1,0], [0,0], [1,0], [2,0],
    // Row 3 (q=-1..2, r=1)
    [-1,1], [0,1], [1,1], [2,1],
    // Row 4 (q=0..2, r=2)
    [0,2], [1,2], [2,2],
  ]

  // For each hex at axial (q,r), its 6 corner vertices in fractional cube coords.
  // We use a string key to deduplicate vertices shared between hexes.
  const vertexMap = new Map<string, { id: number; hexIds: number[] }>()
  let nextVertexId = 0

  // Hex corner offsets (flat-top hex): 6 corners at 60° intervals
  // Using 3x scaled integer coords to avoid floats
  // For axial (q,r), center in pixel-ish coords: cx = q*3, cy = r*3 + q*1.5 (approx)
  // But for vertex dedup we use a canonical key based on the three hex coords that share each vertex.
  // Each vertex is shared by up to 3 hexes. We key by sorted adjacent hex indices.

  // Alternative simpler approach: define vertex positions relative to hex centers
  // and round to a grid. Each hex corner at direction d (0-5) for hex h:
  // vertexKey = canonical sorted triple of (hex, direction)

  // Simplest correct approach: enumerate all hex-corner pairs and merge by position.
  // Vertex position for hex (q,r) corner d:
  //   Using doubled coordinates for exact integer math
  //   Hex center: col = 2*q + r, row = 2*r
  //   Corner offsets (flat-top):
  //     d=0: (1, -1)  d=1: (2, 0)  d=2: (1, 1)
  //     d=3: (-1, 1)  d=4: (-2, 0) d=5: (-1, -1)
  const cornerOffsets: [number, number][] = [
    [1, -1], [2, 0], [1, 1], [-1, 1], [-2, 0], [-1, -1],
  ]

  for (let h = 0; h < hexCoords.length; h++) {
    const [q, r] = hexCoords[h]
    const col = 2 * q + r
    const row = 2 * r
    for (let d = 0; d < 6; d++) {
      const vc = col + cornerOffsets[d][0]
      const vr = row + cornerOffsets[d][1]
      const key = `${vc},${vr}`
      if (!vertexMap.has(key)) {
        vertexMap.set(key, { id: nextVertexId++, hexIds: [] })
      }
      vertexMap.get(key)!.hexIds.push(h)
    }
  }

  const vertices: Vertex[] = Array.from(vertexMap.values()).map(v => ({
    id: v.id,
    hexIds: v.hexIds,
    owner: null,
  }))

  // Build edges: two vertices are connected if they are adjacent corners of the same hex
  const edgeSet = new Set<string>()
  const edgePairs: [number, number][] = []

  for (let h = 0; h < hexCoords.length; h++) {
    const [q, r] = hexCoords[h]
    const col = 2 * q + r
    const row = 2 * r
    for (let d = 0; d < 6; d++) {
      const d2 = (d + 1) % 6
      const k1 = `${col + cornerOffsets[d][0]},${row + cornerOffsets[d][1]}`
      const k2 = `${col + cornerOffsets[d2][0]},${row + cornerOffsets[d2][1]}`
      const v1 = vertexMap.get(k1)!.id
      const v2 = vertexMap.get(k2)!.id
      const eKey = v1 < v2 ? `${v1}-${v2}` : `${v2}-${v1}`
      if (!edgeSet.has(eKey)) {
        edgeSet.add(eKey)
        edgePairs.push([v1, v2])
      }
    }
  }

  const edges: Edge[] = edgePairs.map((verts, id) => ({
    id,
    vertices: verts,
    owner: null,
  }))

  return { hexes, vertices, edges }
}

// ─── Game Creation ───────────────────────────────────────────────────

export function createGame(id: string, playerNames: string[]): GameState {
  if (playerNames.length < 2 || playerNames.length > 4) {
    throw new Error('Agents of Catan requires 2-4 players')
  }

  const players: PlayerState[] = playerNames.map(name => ({
    name,
    resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 },
    victoryPoints: 0,
    settlements: [],
    roads: [],
  }))

  return {
    id,
    phase: 'setup',
    turn: 0,
    currentPlayer: playerNames[0],
    players,
    board: generateBoard(),
    lastDiceRoll: null,
    trades: [],
    log: [],
    winner: null,
    setupRound: 1,
  }
}

// ─── Dice Roll ───────────────────────────────────────────────────────

export function rollDice(): number {
  return Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1
}

export function distributeResources(state: GameState, roll: number): string[] {
  const events: string[] = []

  for (const hex of state.board.hexes) {
    if (hex.diceNumber !== roll || hex.type === 'desert') continue

    for (const vertex of state.board.vertices) {
      if (!vertex.owner || !vertex.hexIds.includes(hex.id)) continue

      const player = state.players.find(p => p.name === vertex.owner)
      if (!player) continue

      const resource = hex.type as Resource
      player.resources[resource] += 1
      events.push(`${player.name} collected 1 ${resource} from hex ${hex.id}`)
    }
  }

  return events
}

// ─── Actions ─────────────────────────────────────────────────────────

export type GameAction =
  | { type: 'roll_dice' }
  | { type: 'build_settlement'; vertexId: number }
  | { type: 'build_road'; edgeId: number }
  | { type: 'propose_trade'; to: string; offering: Partial<Record<Resource, number>>; requesting: Partial<Record<Resource, number>> }
  | { type: 'accept_trade'; tradeId: string }
  | { type: 'reject_trade'; tradeId: string }
  | { type: 'bank_trade'; offering: Resource; requesting: Resource }
  | { type: 'end_turn' }

export interface ActionResult {
  ok: boolean
  error?: string
  events: string[]
  gameOver?: boolean
}

const SETTLEMENT_COST: Record<Resource, number> = { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 }
const ROAD_COST: Record<Resource, number> = { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 }

function hasResources(player: PlayerState, cost: Record<Resource, number>): boolean {
  return (Object.keys(cost) as Resource[]).every(r => player.resources[r] >= cost[r])
}

function deductResources(player: PlayerState, cost: Record<Resource, number>): void {
  for (const [r, amount] of Object.entries(cost)) {
    player.resources[r as Resource] -= amount
  }
}

function getAdjacentVertices(state: GameState, vertexId: number): number[] {
  return state.board.edges
    .filter(e => e.vertices.includes(vertexId))
    .map(e => e.vertices[0] === vertexId ? e.vertices[1] : e.vertices[0])
}

function canPlaceSettlement(state: GameState, player: PlayerState, vertexId: number, isSetup: boolean): string | null {
  const vertex = state.board.vertices[vertexId]
  if (!vertex) return 'Invalid vertex'
  if (vertex.owner) return 'Vertex already occupied'

  // Distance rule: no adjacent settlements
  const adjacent = getAdjacentVertices(state, vertexId)
  for (const adjId of adjacent) {
    if (state.board.vertices[adjId]?.owner) return 'Too close to another settlement'
  }

  if (!isSetup) {
    // Must be connected to player's road network
    const connectedEdges = state.board.edges.filter(
      e => e.owner === player.name && e.vertices.includes(vertexId)
    )
    if (connectedEdges.length === 0) return 'Must be connected to your road network'

    if (!hasResources(player, SETTLEMENT_COST)) return 'Not enough resources'
  }

  return null // OK
}

function canPlaceRoad(state: GameState, player: PlayerState, edgeId: number, isSetup: boolean): string | null {
  const edge = state.board.edges[edgeId]
  if (!edge) return 'Invalid edge'
  if (edge.owner) return 'Edge already has a road'

  if (!isSetup) {
    // Must connect to player's settlement or road
    const connected = edge.vertices.some(vId => {
      const vertex = state.board.vertices[vId]
      if (vertex?.owner === player.name) return true
      return state.board.edges.some(
        e => e.owner === player.name && e.vertices.includes(vId)
      )
    })
    if (!connected) return 'Must connect to your network'
    if (!hasResources(player, ROAD_COST)) return 'Not enough resources'
  } else {
    // In setup, road must connect to the settlement just placed
    const lastSettlement = player.settlements[player.settlements.length - 1]
    if (lastSettlement === undefined || !edge.vertices.includes(lastSettlement)) {
      return 'Setup road must connect to your last settlement'
    }
  }

  return null // OK
}

export function executeAction(state: GameState, playerName: string, action: GameAction): ActionResult {
  const player = state.players.find(p => p.name === playerName)
  if (!player) return { ok: false, error: 'Player not found', events: [] }

  if (state.phase === 'finished') return { ok: false, error: 'Game is over', events: [] }

  // ─── Setup Phase ───
  if (state.phase === 'setup') {
    return executeSetupAction(state, player, action)
  }

  // ─── Playing Phase ───
  if (state.currentPlayer !== playerName) {
    // Allow trade responses from non-current players
    if (action.type === 'accept_trade' || action.type === 'reject_trade') {
      return executeTradeResponse(state, player, action)
    }
    return { ok: false, error: 'Not your turn', events: [] }
  }

  switch (action.type) {
    case 'roll_dice': {
      if (state.lastDiceRoll !== null) return { ok: false, error: 'Already rolled this turn', events: [] }
      const roll = rollDice()
      state.lastDiceRoll = roll
      const resourceEvents = distributeResources(state, roll)
      const events = [`Rolled ${roll}`, ...resourceEvents]
      addLog(state, playerName, 'roll_dice', `Rolled ${roll}`)
      return { ok: true, events }
    }

    case 'build_settlement': {
      if (state.lastDiceRoll === null) return { ok: false, error: 'Roll dice first', events: [] }
      const error = canPlaceSettlement(state, player, action.vertexId, false)
      if (error) return { ok: false, error, events: [] }
      deductResources(player, SETTLEMENT_COST)
      state.board.vertices[action.vertexId].owner = playerName
      player.settlements.push(action.vertexId)
      player.victoryPoints += 1
      addLog(state, playerName, 'build_settlement', `Built settlement at vertex ${action.vertexId}`)
      if (player.victoryPoints >= 10) {
        state.phase = 'finished'
        state.winner = playerName
        return { ok: true, events: [`Built settlement at vertex ${action.vertexId}`, `${playerName} wins with ${player.victoryPoints} VP!`], gameOver: true }
      }
      return { ok: true, events: [`Built settlement at vertex ${action.vertexId} (${player.victoryPoints} VP)`] }
    }

    case 'build_road': {
      if (state.lastDiceRoll === null) return { ok: false, error: 'Roll dice first', events: [] }
      const error = canPlaceRoad(state, player, action.edgeId, false)
      if (error) return { ok: false, error, events: [] }
      deductResources(player, ROAD_COST)
      state.board.edges[action.edgeId].owner = playerName
      player.roads.push(action.edgeId)
      addLog(state, playerName, 'build_road', `Built road on edge ${action.edgeId}`)
      return { ok: true, events: [`Built road on edge ${action.edgeId}`] }
    }

    case 'propose_trade': {
      return executeProposeTrade(state, player, action)
    }

    case 'bank_trade': {
      if (player.resources[action.offering] < 3) return { ok: false, error: 'Need 3 of a resource for bank trade', events: [] }
      player.resources[action.offering] -= 3
      player.resources[action.requesting] += 1
      addLog(state, playerName, 'bank_trade', `Traded 3 ${action.offering} for 1 ${action.requesting}`)
      return { ok: true, events: [`Traded 3 ${action.offering} → 1 ${action.requesting} with bank`] }
    }

    case 'end_turn': {
      state.lastDiceRoll = null
      // Expire pending trades
      for (const trade of state.trades) {
        if (trade.status === 'pending') trade.status = 'expired'
      }
      const nextIdx = (state.players.indexOf(player) + 1) % state.players.length
      state.currentPlayer = state.players[nextIdx].name
      state.turn += 1
      addLog(state, playerName, 'end_turn', `Turn ${state.turn}`)

      // Turn cap: after 300 turns, highest VP wins
      const MAX_TURNS = 300
      if (state.turn >= MAX_TURNS) {
        const sorted = [...state.players].sort((a, b) => b.victoryPoints - a.victoryPoints)
        state.phase = 'finished'
        state.winner = sorted[0].name
        addLog(state, sorted[0].name, 'game_over', `Turn cap reached (${MAX_TURNS}). ${sorted[0].name} wins with ${sorted[0].victoryPoints} VP!`)
        return { ok: true, events: [`Game over! Turn cap reached. ${sorted[0].name} wins with ${sorted[0].victoryPoints} VP!`] }
      }

      return { ok: true, events: [`Turn ended. Now ${state.currentPlayer}'s turn (turn ${state.turn})`] }
    }

    default:
      return { ok: false, error: `Unknown action: ${(action as any).type}`, events: [] }
  }
}

// ─── Setup Phase Logic ───────────────────────────────────────────────

function executeSetupAction(state: GameState, player: PlayerState, action: GameAction): ActionResult {
  if (state.currentPlayer !== player.name) return { ok: false, error: 'Not your turn in setup', events: [] }

  const settlementsThisRound = player.settlements.length
  const roadsThisRound = player.roads.length
  const needsSettlement = settlementsThisRound < state.setupRound
  const needsRoad = roadsThisRound < settlementsThisRound

  if (action.type === 'build_settlement' && needsSettlement) {
    const error = canPlaceSettlement(state, player, action.vertexId, true)
    if (error) return { ok: false, error, events: [] }
    state.board.vertices[action.vertexId].owner = player.name
    player.settlements.push(action.vertexId)
    player.victoryPoints += 1

    // In round 2, give initial resources from adjacent hexes
    if (state.setupRound === 2) {
      const vertex = state.board.vertices[action.vertexId]
      for (const hexId of vertex.hexIds) {
        const hex = state.board.hexes[hexId]
        if (hex.type !== 'desert') {
          player.resources[hex.type as Resource] += 1
        }
      }
    }

    addLog(state, player.name, 'setup_settlement', `Placed settlement at vertex ${action.vertexId}`)
    return { ok: true, events: [`Setup: ${player.name} placed settlement at vertex ${action.vertexId}`] }
  }

  if (action.type === 'build_road' && !needsSettlement && needsRoad) {
    const error = canPlaceRoad(state, player, action.edgeId, true)
    if (error) return { ok: false, error, events: [] }
    state.board.edges[action.edgeId].owner = player.name
    player.roads.push(action.edgeId)
    addLog(state, player.name, 'setup_road', `Placed road on edge ${action.edgeId}`)

    // Advance to next player or next round
    advanceSetup(state)

    return { ok: true, events: [`Setup: ${player.name} placed road on edge ${action.edgeId}`] }
  }

  if (needsSettlement) {
    return { ok: false, error: 'Must place a settlement first', events: [] }
  }
  return { ok: false, error: `Invalid setup action: ${action.type}`, events: [] }
}

function advanceSetup(state: GameState): void {
  const currentIdx = state.players.findIndex(p => p.name === state.currentPlayer)

  if (state.setupRound === 1) {
    // Forward order: 0 → 1 → 2
    if (currentIdx < state.players.length - 1) {
      state.currentPlayer = state.players[currentIdx + 1].name
    } else {
      // Start round 2 (reverse order: 2 → 1 → 0)
      state.setupRound = 2
      // Last player goes first in round 2
    }
  } else {
    // Reverse order: 2 → 1 → 0
    if (currentIdx > 0) {
      state.currentPlayer = state.players[currentIdx - 1].name
    } else {
      // Setup complete — start playing
      state.phase = 'playing'
      state.currentPlayer = state.players[0].name
      state.turn = 1
    }
  }
}

// ─── Trading ─────────────────────────────────────────────────────────

function executeProposeTrade(state: GameState, player: PlayerState, action: Extract<GameAction, { type: 'propose_trade' }>): ActionResult {
  const target = state.players.find(p => p.name === action.to)
  if (!target) return { ok: false, error: `Player ${action.to} not found`, events: [] }
  if (action.to === player.name) return { ok: false, error: 'Cannot trade with yourself', events: [] }

  // Check player has the resources to offer
  for (const [r, amount] of Object.entries(action.offering)) {
    if (player.resources[r as Resource] < (amount ?? 0)) {
      return { ok: false, error: `You don't have enough ${r}`, events: [] }
    }
  }

  const tradeId = `trade_${state.turn}_${Date.now()}`
  const trade: TradeOffer = {
    id: tradeId,
    from: player.name,
    to: action.to,
    offering: action.offering,
    requesting: action.requesting,
    status: 'pending',
  }
  state.trades.push(trade)

  const offerStr = Object.entries(action.offering).filter(([, v]) => v && v > 0).map(([k, v]) => `${v} ${k}`).join(', ')
  const requestStr = Object.entries(action.requesting).filter(([, v]) => v && v > 0).map(([k, v]) => `${v} ${k}`).join(', ')

  addLog(state, player.name, 'propose_trade', `Offered ${offerStr} for ${requestStr} to ${action.to}`)
  return { ok: true, events: [`${player.name} offers ${offerStr} for ${requestStr} to ${action.to} (trade: ${tradeId})`] }
}

function executeTradeResponse(state: GameState, player: PlayerState, action: Extract<GameAction, { type: 'accept_trade' | 'reject_trade' }>): ActionResult {
  const trade = state.trades.find(t => t.id === action.tradeId)
  if (!trade) return { ok: false, error: 'Trade not found', events: [] }
  if (trade.to !== player.name) return { ok: false, error: 'This trade is not for you', events: [] }
  if (trade.status !== 'pending') return { ok: false, error: `Trade already ${trade.status}`, events: [] }

  if (action.type === 'reject_trade') {
    trade.status = 'rejected'
    addLog(state, player.name, 'reject_trade', `Rejected trade ${trade.id}`)
    return { ok: true, events: [`${player.name} rejected trade from ${trade.from}`] }
  }

  // Accept: check both sides have resources
  const from = state.players.find(p => p.name === trade.from)
  if (!from) return { ok: false, error: 'Offerer not found', events: [] }

  for (const [r, amount] of Object.entries(trade.offering)) {
    if (from.resources[r as Resource] < (amount ?? 0)) {
      return { ok: false, error: `${trade.from} no longer has enough ${r}`, events: [] }
    }
  }
  for (const [r, amount] of Object.entries(trade.requesting)) {
    if (player.resources[r as Resource] < (amount ?? 0)) {
      return { ok: false, error: `You don't have enough ${r}`, events: [] }
    }
  }

  // Execute trade
  for (const [r, amount] of Object.entries(trade.offering)) {
    from.resources[r as Resource] -= amount ?? 0
    player.resources[r as Resource] += amount ?? 0
  }
  for (const [r, amount] of Object.entries(trade.requesting)) {
    player.resources[r as Resource] -= amount ?? 0
    from.resources[r as Resource] += amount ?? 0
  }

  trade.status = 'accepted'
  addLog(state, player.name, 'accept_trade', `Accepted trade ${trade.id} from ${trade.from}`)

  const offerStr = Object.entries(trade.offering).filter(([, v]) => v && v > 0).map(([k, v]) => `${v} ${k}`).join(', ')
  const requestStr = Object.entries(trade.requesting).filter(([, v]) => v && v > 0).map(([k, v]) => `${v} ${k}`).join(', ')

  return { ok: true, events: [`Trade accepted! ${trade.from} gave ${offerStr}, got ${requestStr} from ${player.name}`] }
}

// ─── Board Rendering (Text) ─────────────────────────────────────────

export function renderBoard(state: GameState): string {
  const lines: string[] = []

  lines.push('=== AGENTS OF CATAN ===')
  lines.push(`Turn ${state.turn} | Phase: ${state.phase} | Current: ${state.currentPlayer}`)
  if (state.lastDiceRoll !== null) lines.push(`Last roll: ${state.lastDiceRoll}`)
  lines.push('')

  // Hexes
  lines.push('── Board ──')
  for (const hex of state.board.hexes) {
    const numStr = hex.diceNumber !== null ? `(${hex.diceNumber})` : '(--)'
    lines.push(`  Hex ${hex.id}: ${hex.type.padEnd(7)} ${numStr}`)
  }
  lines.push('')

  // Settlements
  const settlements = state.board.vertices.filter(v => v.owner)
  if (settlements.length > 0) {
    lines.push('── Settlements ──')
    for (const v of settlements) {
      lines.push(`  Vertex ${v.id}: ${v.owner} (hexes: ${v.hexIds.join(',')})`)
    }
    lines.push('')
  }

  // Roads
  const roads = state.board.edges.filter(e => e.owner)
  if (roads.length > 0) {
    lines.push('── Roads ──')
    for (const e of roads) {
      lines.push(`  Edge ${e.id}: ${e.owner} (${e.vertices[0]}↔${e.vertices[1]})`)
    }
    lines.push('')
  }

  // Players
  lines.push('── Players ──')
  for (const p of state.players) {
    const res = Object.entries(p.resources)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${v}${k[0].toUpperCase()}`)
      .join(' ')
    lines.push(`  ${p.name}: ${p.victoryPoints} VP | ${res || 'no resources'} | ${p.settlements.length} settlements, ${p.roads.length} roads`)
  }

  // Pending trades
  const pending = state.trades.filter(t => t.status === 'pending')
  if (pending.length > 0) {
    lines.push('')
    lines.push('── Pending Trades ──')
    for (const t of pending) {
      const offer = Object.entries(t.offering).filter(([, v]) => v && v > 0).map(([k, v]) => `${v} ${k}`).join(', ')
      const req = Object.entries(t.requesting).filter(([, v]) => v && v > 0).map(([k, v]) => `${v} ${k}`).join(', ')
      lines.push(`  ${t.id}: ${t.from} offers ${offer} for ${req} to ${t.to}`)
    }
  }

  if (state.winner) {
    lines.push('')
    lines.push(`🏆 ${state.winner} WINS! 🏆`)
  }

  return lines.join('\n')
}

// ─── Helpers ─────────────────────────────────────────────────────────

function addLog(state: GameState, player: string, action: string, detail: string): void {
  state.log.push({ turn: state.turn, player, action, detail, timestamp: Date.now() })
  // Keep last 100 entries
  if (state.log.length > 100) state.log.splice(0, state.log.length - 100)
}

export function generateGameSummary(state: GameState): string {
  const lines: string[] = []
  lines.push(`# Agents of Catan — Game ${state.id}`)
  lines.push('')
  lines.push(`**Players:** ${state.players.map(p => p.name).join(', ')}`)
  lines.push(`**Turns:** ${state.turn}`)
  lines.push(`**Winner:** ${state.winner ?? 'none (in progress)'}`)
  lines.push('')
  lines.push('## Final Standings')
  for (const p of [...state.players].sort((a, b) => b.victoryPoints - a.victoryPoints)) {
    lines.push(`- **${p.name}**: ${p.victoryPoints} VP (${p.settlements.length} settlements, ${p.roads.length} roads)`)
  }
  lines.push('')
  lines.push('## Game Log')
  for (const entry of state.log) {
    lines.push(`- Turn ${entry.turn} | ${entry.player}: ${entry.detail}`)
  }
  return lines.join('\n')
}
