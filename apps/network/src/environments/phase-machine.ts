/**
 * Phase-based tool restriction state machine.
 *
 * Each phase declares exactly which agent can act and which tools are available.
 * All other tools are suppressed — not hinted away, structurally removed.
 *
 * This replaces behavioral prompting ("please use X") with structural constraints.
 */

export interface Phase {
  /** Unique phase name, e.g. "setup_narrate_slag" */
  name: string
  /** Agent name or role that can act in this phase */
  activeAgent: string
  /** ONLY these tools exist for the active agent in this phase */
  availableTools: string[]
  /** Context prompt injected for this phase */
  prompt: string
  /** Tool call command that triggers transition (e.g. "setup_narrate") */
  transitionOn: string
  /** Next phase name, or a function that computes it from the tool call result */
  nextPhase: string | ((result: unknown) => string)
}

export interface PhaseMachine {
  phases: Record<string, Phase>
  currentPhase: string
  /** Advance the machine after a tool call completes. Returns the new phase name. */
  advance(toolCallResult: unknown): string | null
  /** Get available tools for a given agent in the current phase. Returns null if no restriction. */
  getAvailableTools(agentName: string): string[] | null
  /** Get the active agent for the current phase */
  getActiveAgent(): string
  /** Get the prompt context for the current phase */
  getPhasePrompt(): string
  /** Check if a given agent is the active agent in the current phase */
  isActiveAgent(agentName: string): boolean
  /** Get current phase object */
  getCurrentPhase(): Phase | null
  /** Check if the machine has completed (no current phase or phase doesn't exist) */
  isComplete(): boolean
}

export interface PhaseMachineConfig {
  phases: Record<string, Phase>
  initialPhase: string
}

/**
 * Create a phase machine from config.
 */
export function createPhaseMachine(config: PhaseMachineConfig): PhaseMachine {
  const { phases } = config
  let currentPhase = config.initialPhase

  return {
    phases,
    get currentPhase() {
      return currentPhase
    },
    set currentPhase(value: string) {
      currentPhase = value
    },

    advance(toolCallResult: unknown): string | null {
      const phase = phases[currentPhase]
      if (!phase) return null

      const next =
        typeof phase.nextPhase === 'function'
          ? phase.nextPhase(toolCallResult)
          : phase.nextPhase

      if (next && phases[next]) {
        currentPhase = next
        return next
      }

      // If next is a string but not in phases, machine is complete
      if (typeof next === 'string' && next !== '') {
        currentPhase = next
        return next
      }

      return null
    },

    getAvailableTools(agentName: string): string[] | null {
      const phase = phases[currentPhase]
      if (!phase) return null

      // Only the active agent gets tools; everyone else gets nothing
      if (phase.activeAgent !== agentName) {
        return []
      }
      return [...phase.availableTools]
    },

    getActiveAgent(): string {
      return phases[currentPhase]?.activeAgent ?? ''
    },

    getPhasePrompt(): string {
      return phases[currentPhase]?.prompt ?? ''
    },

    isActiveAgent(agentName: string): boolean {
      return phases[currentPhase]?.activeAgent === agentName
    },

    getCurrentPhase(): Phase | null {
      return phases[currentPhase] ?? null
    },

    isComplete(): boolean {
      return !phases[currentPhase]
    },
  }
}

/**
 * Build the RPG setup phase machine for a given player list.
 * 
 * Flow: for each player, DM narrates → player responds, repeated maxExchanges times.
 * After all players: DM finalizes.
 */
export function createRpgSetupPhaseMachine(
  playerAgents: string[],
  maxExchanges: number = 2,
  dmAgent: string = 'grimlock'
): PhaseMachine {
  const phases: Record<string, Phase> = {}

  for (let pIdx = 0; pIdx < playerAgents.length; pIdx++) {
    const agent = playerAgents[pIdx]!
    for (let ex = 0; ex < maxExchanges; ex++) {
      const narrateName = `setup_narrate_${agent}_${ex}`
      const respondName = `setup_respond_${agent}_${ex}`

      // Determine next phase after respond
      let nextAfterRespond: string
      if (ex + 1 < maxExchanges) {
        // More exchanges for this player
        nextAfterRespond = `setup_narrate_${agent}_${ex + 1}`
      } else if (pIdx + 1 < playerAgents.length) {
        // Move to next player
        nextAfterRespond = `setup_narrate_${playerAgents[pIdx + 1]}_0`
      } else {
        // All players done, finalize
        nextAfterRespond = 'setup_finalize'
      }

      phases[narrateName] = {
        name: narrateName,
        activeAgent: dmAgent,
        availableTools: ['rpg'],
        prompt:
          `SETUP PHASE — Interview ${agent} about their backstory (exchange ${ex + 1}/${maxExchanges}).\n` +
          `Call: { "command": "setup_narrate", "target": "${agent}", "message": "<your question>" }`,
        transitionOn: 'setup_narrate',
        nextPhase: respondName,
      }

      phases[respondName] = {
        name: respondName,
        activeAgent: agent,
        availableTools: ['rpg'],
        prompt:
          `SETUP PHASE — Respond to the DM's backstory question.\n` +
          `Call: { "command": "setup_respond", "message": "<your response>" }`,
        transitionOn: 'setup_respond',
        nextPhase: nextAfterRespond,
      }
    }
  }

  // Finalize phase
  phases['setup_finalize'] = {
    name: 'setup_finalize',
    activeAgent: dmAgent,
    availableTools: ['rpg'],
    prompt:
      `SETUP PHASE — All backstory interviews are complete. Finalize the backstories.\n` +
      `Call: { "command": "setup_finalize", "backstories": { "<agent>": "<backstory>" } }`,
    transitionOn: 'setup_finalize',
    nextPhase: 'complete',
  }

  const initialPhase = playerAgents.length > 0
    ? `setup_narrate_${playerAgents[0]}_0`
    : 'setup_finalize'

  return createPhaseMachine({ phases, initialPhase })
}

/**
 * Serialize a phase machine to plain object for storage (e.g. in game state JSON).
 */
export function serializePhaseMachine(machine: PhaseMachine): { currentPhase: string; phasesSnapshot: Record<string, Omit<Phase, 'nextPhase'> & { nextPhase: string }> } {
  // We can't serialize functions, so for RPG setup the nextPhase is always a string
  const snapshot: Record<string, any> = {}
  for (const [key, phase] of Object.entries(machine.phases)) {
    snapshot[key] = {
      ...phase,
      nextPhase: typeof phase.nextPhase === 'function' ? '' : phase.nextPhase,
    }
  }
  return {
    currentPhase: machine.currentPhase,
    phasesSnapshot: snapshot,
  }
}

/**
 * Deserialize a phase machine from stored state.
 */
export function deserializePhaseMachine(data: { currentPhase: string; phasesSnapshot: Record<string, Phase> }): PhaseMachine {
  return createPhaseMachine({
    phases: data.phasesSnapshot,
    initialPhase: data.currentPhase,
  })
}
