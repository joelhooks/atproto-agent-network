import { describe, expect, it } from 'vitest'

import {
  createPhaseMachine,
  createRpgSetupPhaseMachine,
  serializePhaseMachine,
  deserializePhaseMachine,
  type Phase,
} from './phase-machine'

describe('PhaseMachine', () => {
  it('creates a machine and tracks current phase', () => {
    const phases: Record<string, Phase> = {
      a: { name: 'a', activeAgent: 'alice', availableTools: ['t1'], prompt: 'do A', transitionOn: 'act_a', nextPhase: 'b' },
      b: { name: 'b', activeAgent: 'bob', availableTools: ['t2'], prompt: 'do B', transitionOn: 'act_b', nextPhase: 'done' },
    }
    const machine = createPhaseMachine({ phases, initialPhase: 'a' })

    expect(machine.currentPhase).toBe('a')
    expect(machine.getActiveAgent()).toBe('alice')
    expect(machine.getPhasePrompt()).toBe('do A')
    expect(machine.isActiveAgent('alice')).toBe(true)
    expect(machine.isActiveAgent('bob')).toBe(false)
  })

  it('returns available tools only for the active agent', () => {
    const phases: Record<string, Phase> = {
      a: { name: 'a', activeAgent: 'alice', availableTools: ['rpg'], prompt: '', transitionOn: 'act', nextPhase: 'b' },
      b: { name: 'b', activeAgent: 'bob', availableTools: ['rpg', 'extra'], prompt: '', transitionOn: 'act', nextPhase: '' },
    }
    const machine = createPhaseMachine({ phases, initialPhase: 'a' })

    expect(machine.getAvailableTools('alice')).toEqual(['rpg'])
    expect(machine.getAvailableTools('bob')).toEqual([])
    expect(machine.getAvailableTools('nobody')).toEqual([])
  })

  it('advances to the next phase', () => {
    const phases: Record<string, Phase> = {
      a: { name: 'a', activeAgent: 'alice', availableTools: ['t1'], prompt: '', transitionOn: 'act', nextPhase: 'b' },
      b: { name: 'b', activeAgent: 'bob', availableTools: ['t2'], prompt: '', transitionOn: 'act', nextPhase: 'done' },
    }
    const machine = createPhaseMachine({ phases, initialPhase: 'a' })

    const next = machine.advance({})
    expect(next).toBe('b')
    expect(machine.currentPhase).toBe('b')
    expect(machine.getActiveAgent()).toBe('bob')

    const next2 = machine.advance({})
    expect(next2).toBe('done')
    expect(machine.isComplete()).toBe(true)
  })

  it('supports function-based nextPhase', () => {
    const phases: Record<string, Phase> = {
      start: {
        name: 'start',
        activeAgent: 'dm',
        availableTools: ['rpg'],
        prompt: '',
        transitionOn: 'act',
        nextPhase: (result: any) => result?.good ? 'good_end' : 'bad_end',
      },
      good_end: { name: 'good_end', activeAgent: 'dm', availableTools: [], prompt: '', transitionOn: '', nextPhase: '' },
      bad_end: { name: 'bad_end', activeAgent: 'dm', availableTools: [], prompt: '', transitionOn: '', nextPhase: '' },
    }
    const machine = createPhaseMachine({ phases, initialPhase: 'start' })

    machine.advance({ good: true })
    expect(machine.currentPhase).toBe('good_end')
  })

  it('isComplete returns true when phase does not exist', () => {
    const machine = createPhaseMachine({ phases: {}, initialPhase: 'nonexistent' })
    expect(machine.isComplete()).toBe(true)
  })
})

describe('createRpgSetupPhaseMachine', () => {
  it('creates phases for all players with correct transitions', () => {
    const players = ['slag', 'snarl', 'swoop']
    const machine = createRpgSetupPhaseMachine(players, 2, 'grimlock')

    // Should start with narrate for first player
    expect(machine.currentPhase).toBe('setup_narrate_slag_0')
    expect(machine.getActiveAgent()).toBe('grimlock')
    expect(machine.getAvailableTools('grimlock')).toEqual(['rpg'])
    expect(machine.getAvailableTools('slag')).toEqual([])

    // Advance: narrate_slag_0 → respond_slag_0
    machine.advance({})
    expect(machine.currentPhase).toBe('setup_respond_slag_0')
    expect(machine.getActiveAgent()).toBe('slag')
    expect(machine.getAvailableTools('slag')).toEqual(['rpg'])
    expect(machine.getAvailableTools('grimlock')).toEqual([])

    // Advance: respond_slag_0 → narrate_slag_1
    machine.advance({})
    expect(machine.currentPhase).toBe('setup_narrate_slag_1')
    expect(machine.getActiveAgent()).toBe('grimlock')

    // Advance: narrate_slag_1 → respond_slag_1
    machine.advance({})
    expect(machine.currentPhase).toBe('setup_respond_slag_1')
    expect(machine.getActiveAgent()).toBe('slag')

    // Advance: respond_slag_1 → narrate_snarl_0 (next player)
    machine.advance({})
    expect(machine.currentPhase).toBe('setup_narrate_snarl_0')
    expect(machine.getActiveAgent()).toBe('grimlock')

    // Fast-forward through snarl
    machine.advance({}); machine.advance({}); machine.advance({}); machine.advance({})
    expect(machine.currentPhase).toBe('setup_narrate_swoop_0')

    // Fast-forward through swoop
    machine.advance({}); machine.advance({}); machine.advance({}); machine.advance({})
    expect(machine.currentPhase).toBe('setup_finalize')
    expect(machine.getActiveAgent()).toBe('grimlock')

    // Finalize → complete
    machine.advance({})
    expect(machine.currentPhase).toBe('complete')
    expect(machine.isComplete()).toBe(true)
  })

  it('handles single player', () => {
    const machine = createRpgSetupPhaseMachine(['slag'], 1, 'grimlock')
    expect(machine.currentPhase).toBe('setup_narrate_slag_0')

    machine.advance({}) // → respond_slag_0
    expect(machine.currentPhase).toBe('setup_respond_slag_0')

    machine.advance({}) // → finalize
    expect(machine.currentPhase).toBe('setup_finalize')

    machine.advance({}) // → complete
    expect(machine.isComplete()).toBe(true)
  })

  it('handles empty player list', () => {
    const machine = createRpgSetupPhaseMachine([], 2, 'grimlock')
    expect(machine.currentPhase).toBe('setup_finalize')
  })
})

describe('serialize/deserialize', () => {
  it('round-trips a phase machine', () => {
    const machine = createRpgSetupPhaseMachine(['slag', 'snarl'], 1, 'grimlock')
    machine.advance({}) // → respond_slag_0

    const data = serializePhaseMachine(machine)
    expect(data.currentPhase).toBe('setup_respond_slag_0')

    const restored = deserializePhaseMachine(data)
    expect(restored.currentPhase).toBe('setup_respond_slag_0')
    expect(restored.getActiveAgent()).toBe('slag')
    expect(restored.getAvailableTools('slag')).toEqual(['rpg'])
    expect(restored.getAvailableTools('grimlock')).toEqual([])

    // Continue advancing the restored machine
    restored.advance({}) // → narrate_snarl_0
    expect(restored.currentPhase).toBe('setup_narrate_snarl_0')
    expect(restored.getActiveAgent()).toBe('grimlock')
  })
})

describe('tool filtering integration', () => {
  it('non-active agents get empty tool list', () => {
    const machine = createRpgSetupPhaseMachine(['slag', 'snarl', 'swoop'], 2, 'grimlock')

    // During narrate phase, only grimlock gets tools
    expect(machine.getAvailableTools('grimlock')).toEqual(['rpg'])
    expect(machine.getAvailableTools('slag')).toEqual([])
    expect(machine.getAvailableTools('snarl')).toEqual([])
    expect(machine.getAvailableTools('swoop')).toEqual([])
  })

  it('only correct player can act during respond phase', () => {
    const machine = createRpgSetupPhaseMachine(['slag', 'snarl', 'swoop'], 2, 'grimlock')
    machine.advance({}) // → respond_slag_0

    expect(machine.getAvailableTools('slag')).toEqual(['rpg'])
    expect(machine.getAvailableTools('snarl')).toEqual([])
    expect(machine.getAvailableTools('swoop')).toEqual([])
    expect(machine.getAvailableTools('grimlock')).toEqual([])
  })

  it('full setup flow end-to-end', () => {
    const players = ['slag', 'snarl', 'swoop']
    const machine = createRpgSetupPhaseMachine(players, 2, 'grimlock')
    const transitions: string[] = [machine.currentPhase]

    while (!machine.isComplete()) {
      machine.advance({})
      transitions.push(machine.currentPhase)
    }

    // Expected: for each player, 2x (narrate + respond), then finalize, then complete
    // 3 players * 2 exchanges * 2 phases + finalize + complete = 14 total transitions
    expect(transitions).toHaveLength(14)
    expect(transitions[0]).toBe('setup_narrate_slag_0')
    expect(transitions[transitions.length - 2]).toBe('setup_finalize')
    expect(transitions[transitions.length - 1]).toBe('complete')

    // Verify pattern: narrate → respond → narrate → respond → ... → finalize → complete
    for (let i = 0; i < transitions.length - 2; i++) {
      const t = transitions[i]!
      if (t.startsWith('setup_narrate_')) {
        expect(transitions[i + 1]).toMatch(/^setup_respond_/)
      }
    }
  })
})
