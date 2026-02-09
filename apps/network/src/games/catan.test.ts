import { describe, it, expect } from 'vitest'
import { createGame, executeAction, renderBoard, type GameState } from './catan'

describe('Agents of Catan', () => {
  function makeGame(names = ['grimlock', 'scout', 'weaver']): GameState {
    return createGame('test-game-1', names)
  }

  it('creates a game with correct initial state', () => {
    const game = makeGame()
    expect(game.phase).toBe('setup')
    expect(game.players).toHaveLength(3)
    expect(game.board.hexes).toHaveLength(7)
    expect(game.board.vertices).toHaveLength(18)
    expect(game.board.edges.length).toBeGreaterThan(0)
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
    const result = executeAction(game, 'scout', { type: 'build_settlement', vertexId: 0 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Not your turn')
  })

  describe('setup phase', () => {
    it('allows first player to place settlement then road', () => {
      const game = makeGame()
      
      // Place settlement
      const s1 = executeAction(game, 'grimlock', { type: 'build_settlement', vertexId: 0 })
      expect(s1.ok).toBe(true)
      expect(game.board.vertices[0].owner).toBe('grimlock')
      
      // Place road connected to settlement
      // Find an edge that includes vertex 0
      const edge = game.board.edges.find(e => e.vertices.includes(0) && !e.owner)!
      const r1 = executeAction(game, 'grimlock', { type: 'build_road', edgeId: edge.id })
      expect(r1.ok).toBe(true)
    })

    it('enforces distance rule in setup', () => {
      const game = makeGame()
      executeAction(game, 'grimlock', { type: 'build_settlement', vertexId: 12 })
      const edge = game.board.edges.find(e => e.vertices.includes(12) && !e.owner)!
      executeAction(game, 'grimlock', { type: 'build_road', edgeId: edge.id })

      // Scout tries adjacent vertex (should fail)
      // Vertex 12 is adjacent to 17 via inner ring edge
      const adj = game.board.edges
        .filter(e => e.vertices.includes(12))
        .map(e => e.vertices[0] === 12 ? e.vertices[1] : e.vertices[0])
      
      const result = executeAction(game, 'scout', { type: 'build_settlement', vertexId: adj[0] })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Too close')
    })

    it('transitions to playing phase after all setup rounds', () => {
      const game = makeGame(['a', 'b'])
      
      // Round 1: a, b (forward)
      executeAction(game, 'a', { type: 'build_settlement', vertexId: 0 })
      executeAction(game, 'a', { type: 'build_road', edgeId: 0 })
      
      executeAction(game, 'b', { type: 'build_settlement', vertexId: 4 })
      executeAction(game, 'b', { type: 'build_road', edgeId: 4 })
      
      expect(game.setupRound).toBe(2)
      
      // Round 2: b, a (reverse)
      executeAction(game, 'b', { type: 'build_settlement', vertexId: 8 })
      executeAction(game, 'b', { type: 'build_road', edgeId: 8 })
      
      executeAction(game, 'a', { type: 'build_settlement', vertexId: 12 })
      const edge = game.board.edges.find(e => e.vertices.includes(12) && !e.owner)!
      executeAction(game, 'a', { type: 'build_road', edgeId: edge.id })
      
      expect(game.phase).toBe('playing')
      expect(game.currentPlayer).toBe('a')
    })
  })

  describe('playing phase', () => {
    function setupGame(): GameState {
      const game = makeGame(['a', 'b'])
      // Quick setup - place settlements and roads
      executeAction(game, 'a', { type: 'build_settlement', vertexId: 0 })
      executeAction(game, 'a', { type: 'build_road', edgeId: 0 })
      executeAction(game, 'b', { type: 'build_settlement', vertexId: 4 })
      executeAction(game, 'b', { type: 'build_road', edgeId: 4 })
      executeAction(game, 'b', { type: 'build_settlement', vertexId: 8 })
      executeAction(game, 'b', { type: 'build_road', edgeId: 8 })
      executeAction(game, 'a', { type: 'build_settlement', vertexId: 12 })
      const edge = game.board.edges.find(e => e.vertices.includes(12) && !e.owner)!
      executeAction(game, 'a', { type: 'build_road', edgeId: edge.id })
      return game
    }

    it('requires dice roll before building', () => {
      const game = setupGame()
      const result = executeAction(game, 'a', { type: 'build_settlement', vertexId: 14 })
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
      
      executeAction(game, 'a', { type: 'roll_dice' })
      const result = executeAction(game, 'a', { type: 'bank_trade', offering: 'wood', requesting: 'brick' })
      expect(result.ok).toBe(true)
      expect(player.resources.wood).toBe(2)
      expect(player.resources.brick).toBe(1)
    })

    it('supports player-to-player trading', () => {
      const game = setupGame()
      game.players[0].resources = { wood: 2, brick: 0, sheep: 0, wheat: 0, ore: 0 }
      game.players[1].resources = { wood: 0, brick: 2, sheep: 0, wheat: 0, ore: 0 }

      executeAction(game, 'a', { type: 'roll_dice' })

      // Propose trade
      const propose = executeAction(game, 'a', {
        type: 'propose_trade',
        to: 'b',
        offering: { wood: 1 },
        requesting: { brick: 1 },
      })
      expect(propose.ok).toBe(true)
      const tradeId = game.trades[game.trades.length - 1].id

      // Accept trade (non-current player can respond)
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
