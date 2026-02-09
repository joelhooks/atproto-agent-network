import { describe, it, expect } from 'vitest'
import { createGame, executeAction, renderBoard, type GameState } from './catan'

describe('Agents of Catan', () => {
  function makeGame(names = ['grimlock', 'scout', 'weaver']): GameState {
    return createGame('test-game-1', names)
  }

  // Find vertices that satisfy distance rule (not adjacent to any occupied vertex)
  function findValidVertex(game: GameState, exclude: number[] = []): number {
    const occupied = new Set(game.board.vertices.filter(v => v.owner).map(v => v.id))
    for (const id of exclude) occupied.add(id)
    
    for (const v of game.board.vertices) {
      if (occupied.has(v.id)) continue
      // Check distance rule: no adjacent vertex is occupied
      const adjacent = new Set<number>()
      for (const e of game.board.edges) {
        if (e.vertices.includes(v.id)) {
          for (const av of e.vertices) if (av !== v.id) adjacent.add(av)
        }
      }
      if (![...adjacent].some(a => occupied.has(a))) return v.id
    }
    return -1
  }

  function findEdgeForVertex(game: GameState, vertexId: number): number {
    const edge = game.board.edges.find(e => e.vertices.includes(vertexId) && !e.owner)
    return edge ? edge.id : -1
  }

  it('creates a game with correct initial state', () => {
    const game = makeGame()
    expect(game.phase).toBe('setup')
    expect(game.players).toHaveLength(3)
    expect(game.board.hexes).toHaveLength(19)
    expect(game.board.vertices.length).toBeGreaterThanOrEqual(54)
    expect(game.board.edges.length).toBeGreaterThanOrEqual(72)
    expect(game.currentPlayer).toBe('grimlock')
    expect(game.winner).toBeNull()
  })

  it('has exactly one desert hex with no dice number', () => {
    const game = makeGame()
    const deserts = game.board.hexes.filter(h => h.type === 'desert')
    expect(deserts).toHaveLength(1)
    expect(deserts[0].diceNumber).toBeNull()
  })

  it('rejects actions from wrong player', () => {
    const game = makeGame()
    const v = findValidVertex(game)
    const result = executeAction(game, 'scout', { type: 'build_settlement', vertexId: v })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Not your turn')
  })

  describe('setup phase', () => {
    it('allows first player to place settlement then road', () => {
      const game = makeGame()
      const v = findValidVertex(game)
      
      const s1 = executeAction(game, 'grimlock', { type: 'build_settlement', vertexId: v })
      expect(s1.ok).toBe(true)
      expect(game.board.vertices.find(x => x.id === v)!.owner).toBe('grimlock')
      
      const edgeId = findEdgeForVertex(game, v)
      const r1 = executeAction(game, 'grimlock', { type: 'build_road', edgeId })
      expect(r1.ok).toBe(true)
    })

    it('enforces distance rule in setup', () => {
      const game = makeGame()
      const v1 = findValidVertex(game)
      executeAction(game, 'grimlock', { type: 'build_settlement', vertexId: v1 })
      executeAction(game, 'grimlock', { type: 'build_road', edgeId: findEdgeForVertex(game, v1) })

      // Find an adjacent vertex to v1 (should fail distance rule)
      const adjacent = game.board.edges
        .filter(e => e.vertices.includes(v1))
        .map(e => e.vertices[0] === v1 ? e.vertices[1] : e.vertices[0])
      
      if (adjacent.length > 0) {
        const result = executeAction(game, 'scout', { type: 'build_settlement', vertexId: adjacent[0] })
        expect(result.ok).toBe(false)
        expect(result.error).toContain('Too close')
      }
    })

    it('transitions to playing phase after all setup rounds', () => {
      const game = makeGame(['a', 'b'])
      
      // Round 1: a, b (forward)
      const v1 = findValidVertex(game)
      executeAction(game, 'a', { type: 'build_settlement', vertexId: v1 })
      executeAction(game, 'a', { type: 'build_road', edgeId: findEdgeForVertex(game, v1) })
      
      const v2 = findValidVertex(game)
      executeAction(game, 'b', { type: 'build_settlement', vertexId: v2 })
      executeAction(game, 'b', { type: 'build_road', edgeId: findEdgeForVertex(game, v2) })
      
      expect(game.setupRound).toBe(2)
      
      // Round 2: b, a (reverse)
      const v3 = findValidVertex(game)
      executeAction(game, 'b', { type: 'build_settlement', vertexId: v3 })
      executeAction(game, 'b', { type: 'build_road', edgeId: findEdgeForVertex(game, v3) })
      
      const v4 = findValidVertex(game)
      executeAction(game, 'a', { type: 'build_settlement', vertexId: v4 })
      executeAction(game, 'a', { type: 'build_road', edgeId: findEdgeForVertex(game, v4) })
      
      expect(game.phase).toBe('playing')
      expect(game.currentPlayer).toBe('a')
    })
  })

  describe('playing phase', () => {
    function setupGame(): GameState {
      const game = makeGame(['a', 'b'])
      // Round 1
      const v1 = findValidVertex(game)
      executeAction(game, 'a', { type: 'build_settlement', vertexId: v1 })
      executeAction(game, 'a', { type: 'build_road', edgeId: findEdgeForVertex(game, v1) })
      const v2 = findValidVertex(game)
      executeAction(game, 'b', { type: 'build_settlement', vertexId: v2 })
      executeAction(game, 'b', { type: 'build_road', edgeId: findEdgeForVertex(game, v2) })
      // Round 2
      const v3 = findValidVertex(game)
      executeAction(game, 'b', { type: 'build_settlement', vertexId: v3 })
      executeAction(game, 'b', { type: 'build_road', edgeId: findEdgeForVertex(game, v3) })
      const v4 = findValidVertex(game)
      executeAction(game, 'a', { type: 'build_settlement', vertexId: v4 })
      executeAction(game, 'a', { type: 'build_road', edgeId: findEdgeForVertex(game, v4) })
      return game
    }

    function findBuildableRoadEdge(game: GameState, playerName: string): number {
      const player = game.players.find((p) => p.name === playerName)
      if (!player) return -1

      const ownedSettlements = new Set(player.settlements)
      const ownedRoads = new Set(player.roads)

      for (const edge of game.board.edges) {
        if (edge.owner) continue
        const [v1, v2] = edge.vertices

        // Connected to the player's existing network (settlement or road endpoint).
        if (ownedSettlements.has(v1) || ownedSettlements.has(v2)) return edge.id
        if (
          game.board.edges.some(
            (e) =>
              e.owner === playerName &&
              (e.vertices.includes(v1) || e.vertices.includes(v2)) &&
              ownedRoads.has(e.id)
          )
        ) {
          return edge.id
        }
      }

      return -1
    }

    it('requires dice roll before building', () => {
      const game = setupGame()
      const v = findValidVertex(game)
      const result = executeAction(game, 'a', { type: 'build_settlement', vertexId: v })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Roll dice')
    })

    it('allows rolling dice and ending turn', () => {
      const game = setupGame()
      const roll = executeAction(game, 'a', { type: 'roll_dice' })
      expect(roll.ok).toBe(true)
      expect(game.lastDiceRoll).toBeGreaterThanOrEqual(2)
      expect(game.lastDiceRoll).toBeLessThanOrEqual(12)

      const end = executeAction(game, 'a', { type: 'end_turn' })
      expect(end.ok).toBe(true)
      expect(game.currentPlayer).toBe('b')
      expect(game.lastDiceRoll).toBeNull()
    })

    it('supports bank trading at 3:1', () => {
      const game = setupGame()
      const player = game.players[0]
      player.resources = { wood: 5, brick: 0, sheep: 0, wheat: 0, ore: 0 }
      
      const result = executeAction(game, 'a', { type: 'bank_trade', offering: 'wood', requesting: 'brick' })
      expect(result.ok).toBe(true)
      expect(player.resources.wood).toBe(2)
      expect(player.resources.brick).toBe(1)
    })

    it('ends the game by stalemate when no one builds for 20 consecutive turns', () => {
      const game = setupGame()

      // Force a clear points leader without triggering normal victory.
      game.players[0].victoryPoints = 6 // a
      game.players[1].victoryPoints = 4 // b

      for (let i = 0; i < 19; i++) {
        const current = game.currentPlayer
        const res = executeAction(game, current, { type: 'end_turn' })
        expect(res.ok).toBe(true)
        expect(game.phase).toBe('playing')
        expect(game.winner).toBeNull()
      }

      const lastCurrent = game.currentPlayer
      const last = executeAction(game, lastCurrent, { type: 'end_turn' }) as any
      expect(last.ok).toBe(true)
      expect(last.gameOver).toBe(true)
      expect(last.stalemate).toBe(true)
      expect(game.phase).toBe('finished')
      expect(game.winner).toBe('a')
    })

    it('resets the stale turn counter when a road is built', () => {
      const game = setupGame()

      // Run up the stale counter a bit.
      for (let i = 0; i < 5; i++) {
        const current = game.currentPlayer
        const res = executeAction(game, current, { type: 'end_turn' })
        expect(res.ok).toBe(true)
      }

      // Now build a road and ensure the counter resets.
      const builder = game.currentPlayer
      const player = game.players.find((p) => p.name === builder)!
      player.resources.wood = 10
      player.resources.brick = 10

      expect(executeAction(game, builder, { type: 'roll_dice' }).ok).toBe(true)
      const edgeId = findBuildableRoadEdge(game, builder)
      expect(edgeId).toBeGreaterThanOrEqual(0)

      const built = executeAction(game, builder, { type: 'build_road', edgeId })
      expect(built.ok).toBe(true)
      expect((game as any).staleTurns).toBe(0)

      const ended = executeAction(game, builder, { type: 'end_turn' })
      expect(ended.ok).toBe(true)
      expect((game as any).staleTurns).toBe(0)
      expect(game.phase).toBe('playing')
    })

    it('supports player-to-player trading', () => {
      const game = setupGame()
      game.players[0].resources = { wood: 2, brick: 0, sheep: 0, wheat: 0, ore: 0 }
      game.players[1].resources = { wood: 0, brick: 2, sheep: 0, wheat: 0, ore: 0 }

      const propose = executeAction(game, 'a', {
        type: 'propose_trade',
        to: 'b',
        offering: { wood: 1 },
        requesting: { brick: 1 },
      })
      expect(propose.ok).toBe(true)
      const tradeId = game.trades[game.trades.length - 1].id

      const accept = executeAction(game, 'b', { type: 'accept_trade', tradeId })
      expect(accept.ok).toBe(true)
      expect(game.players[0].resources.wood).toBe(1)
      expect(game.players[0].resources.brick).toBe(1)
      expect(game.players[1].resources.wood).toBe(1)
      expect(game.players[1].resources.brick).toBe(1)
    })
  })

  it('renders the board as text', () => {
    const game = makeGame()
    const rendered = renderBoard(game)
    expect(rendered).toContain('AGENTS OF CATAN')
    expect(rendered).toContain('grimlock')
    expect(rendered).toContain('Hex')
  })
})
