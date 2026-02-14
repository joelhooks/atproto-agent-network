import type { PersistentCharacter } from '@atproto-agent/core'

import {
  buildAbilityMenu,
  enemyIsNegotiable,
  enemyMoraleState,
  nextEncounterRoomIndex,
  type Character,
  type Enemy,
  type FeedMessageType,
  type RpgClass,
  type RpgGameState,
  XP_TABLE,
} from '../../games/rpg-engine'
import { deserializePhaseMachine } from '../phase-machine'
import {
  DM_SKILL,
  DM_SKILL_BRIEF,
  HEALER_SKILL,
  HEALER_SKILL_BRIEF,
  MAGE_SKILL,
  MAGE_SKILL_BRIEF,
  PARTY_TACTICS,
  SCOUT_SKILL,
  SCOUT_SKILL_BRIEF,
  WARRIOR_SKILL,
  WARRIOR_SKILL_BRIEF,
} from '../rpg-skills'
import type { EnvironmentContext } from '../types'
import { buildHubTownNarration, ensureHubTownState } from './systems/hub-town'

export type EnvironmentRow = { id: string; state: string; type?: string | null }

export type BuildContextDependencies = {
  isCharacter: (character: Character, identity: string) => boolean
  isReactiveModeEnabled: (ctx: EnvironmentContext) => boolean
}

function defaultIsCharacter(character: Character, identity: string): boolean {
  return character.agent === identity || character.name === identity
}

function listLivingEnemies(game: RpgGameState): Enemy[] {
  return (game.combat?.enemies ?? []).filter((enemy) => (enemy?.hp ?? 0) > 0)
}

export async function findActiveGameForAgent(ctx: EnvironmentContext): Promise<EnvironmentRow | null> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return null

  try {
    const asPlayer = await ctx.db
      .prepare("SELECT id, state, type FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup', 'hub_town') AND players LIKE ? LIMIT 1")
      .bind(`%${agentName}%`)
      .first<EnvironmentRow>()
    if (asPlayer) return asPlayer

    const asHost = await ctx.db
      .prepare("SELECT id, state, type FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup', 'hub_town') AND host_agent = ? LIMIT 1")
      .bind(agentName)
      .first<EnvironmentRow>()
    return asHost ?? null
  } catch {
    return null
  }
}

export async function findActiveGameWhereItsMyTurn(ctx: EnvironmentContext): Promise<EnvironmentRow | null> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return null

  try {
    const row = await ctx.db
      .prepare(
        "SELECT id, state, type FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup', 'hub_town') AND json_extract(state, '$.currentPlayer') = ?"
      )
      .bind(agentName)
      .first<EnvironmentRow>()
    return row ?? null
  } catch {
    return null
  }
}

export function summarizeParty(game: RpgGameState): string {
  return game.party
    .map((member) => {
      const agentTag = member.agent ? ` [${member.agent}]` : ''
      return `${member.name}(${member.klass})${agentTag} HP ${member.hp}/${member.maxHp} MP ${member.mp}/${member.maxMp}`
    })
    .join(' | ')
}

export function pickJoinClass(game: RpgGameState): RpgClass {
  const counts = new Map<RpgClass, number>([
    ['Warrior', 0],
    ['Scout', 0],
    ['Mage', 0],
    ['Healer', 0],
  ])
  for (const member of game.party) {
    counts.set(member.klass, (counts.get(member.klass) ?? 0) + 1)
  }

  let best: RpgClass = 'Warrior'
  let bestCount = Number.POSITIVE_INFINITY
  for (const klass of ['Warrior', 'Scout', 'Mage', 'Healer'] as const) {
    const count = counts.get(klass) ?? 0
    if (count < bestCount) {
      best = klass
      bestCount = count
    }
  }
  return best
}

export async function findJoinableEnvironmentsForAgent(
  ctx: EnvironmentContext,
  input: { limit?: number; isCharacter?: (character: Character, identity: string) => boolean }
): Promise<Array<{ id: string; game: RpgGameState }>> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return []

  const isCharacter = input.isCharacter ?? defaultIsCharacter

  try {
    const { results } = await ctx.db
      .prepare("SELECT id, state FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup') ORDER BY updated_at DESC")
      .all<EnvironmentRow>()

    const joinable: Array<{ id: string; game: RpgGameState }> = []
    const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 5)))

    for (const row of results) {
      if (!row?.id || typeof row.state !== 'string') continue
      try {
        const game = JSON.parse(row.state) as RpgGameState
        if (!game || game.type !== 'rpg') continue
        if (Array.isArray(game.party) && game.party.some((member) => member && isCharacter(member, agentName))) continue
        if (!Array.isArray(game.party) || game.party.length >= 3) continue
        joinable.push({ id: row.id, game })
        if (joinable.length >= limit) break
      } catch {
        // ignore corrupt state rows
      }
    }

    return joinable
  } catch {
    return []
  }
}

export async function buildContext(ctx: EnvironmentContext, deps: BuildContextDependencies): Promise<string[]> {
  const row = (await findActiveGameWhereItsMyTurn(ctx)) ?? (await findActiveGameForAgent(ctx))
  const isCharacter = deps.isCharacter ?? defaultIsCharacter
  const isReactiveModeEnabled = deps.isReactiveModeEnabled ?? (() => false)

  if (!row) {
    const joinable = await findJoinableEnvironmentsForAgent(ctx, { limit: 5, isCharacter })
    if (joinable.length === 0) return []

    const lines: string[] = []
    lines.push('🏰 Joinable Dungeon Crawls:')
    for (const candidate of joinable) {
      const recommended = pickJoinClass(candidate.game)
      lines.push(`- ${candidate.id}: Party: ${summarizeParty(candidate.game)} | Current: ${candidate.game.currentPlayer}`)
      lines.push(`  Join: {"command":"join_game","gameId":"${candidate.id}","klass":"${recommended}"}`)
    }
    return lines.filter(Boolean)
  }

  try {
    const game = JSON.parse(row.state) as RpgGameState
    const room = game.dungeon[game.roomIndex]
    const agentName = ctx.agentName.trim()
    const partyMember = game.party?.find((member) => member && isCharacter(member, agentName))
    const freeformExploration =
      isReactiveModeEnabled(ctx) && game.phase === 'playing' && game.mode === 'exploring' && Boolean(partyMember)
    const isMyTurn = game.currentPlayer === agentName || freeformExploration
    const setupPhase = (game as any).setupPhase as RpgGameState['setupPhase'] | undefined

    if (setupPhase && !setupPhase.complete) {
      const pmData = (game as any).phaseMachine
      if (pmData) {
        const phaseMachine = deserializePhaseMachine(pmData)
        const phase = phaseMachine.getCurrentPhase()
        if (phase && phaseMachine.isActiveAgent(agentName)) {
          return [
            `🎮🎮🎮 ${phase.prompt}`,
            '',
            '⚠️ The ONLY tool available to you right now is "rpg". No other tools exist during setup.',
          ]
        }
        if (phase && !phaseMachine.isActiveAgent(agentName)) {
          return [
            `Waiting for ${phase.activeAgent} to act in phase: ${phase.name}.`,
            'Use environment_broadcast to coordinate with teammates while you wait.',
          ]
        }
      }

      const party = Array.isArray(game.party) ? game.party : []
      const idx = Math.max(0, Math.min(party.length - 1, Math.floor(setupPhase.currentPlayerIndex ?? 0)))
      const current = party[idx]
      const currentAgent = current ? (current.agent ?? current.name) : ''

      if (agentName.toLowerCase() === 'grimlock') {
        return [
          '🎮🎮🎮 SETUP PHASE — YOUR ONLY ACTION:',
          'Call the "rpg" tool with these EXACT parameters:',
          `  { "command": "setup_narrate", "target": "${currentAgent}", "message": "<your question about their backstory>" }`,
          '',
          `You are interviewing ${currentAgent} about their character. Ask about their origin, motivation, or appearance.`,
          'After all players have responded, call: { "command": "setup_finalize", "backstories": { "<agent>": "<backstory>" } }',
          '',
          '⚠️ The ONLY tool available to you right now is "rpg". No other tools exist during setup.',
        ]
      }

      if (agentName === currentAgent) {
        return [
          '🎮🎮🎮 SETUP PHASE — YOUR ONLY ACTION:',
          'Call the "rpg" tool with these EXACT parameters:',
          '  { "command": "setup_respond", "message": "<your backstory response>" }',
          '',
          "The DM is asking about your character's backstory. Respond in character.",
          '',
          '⚠️ The ONLY tool available to you right now is "rpg". No other tools exist during setup.',
        ]
      }

      return [
        `Waiting for ${currentAgent || 'the current player'} to finish backstory with DM.`,
        'Use environment_broadcast to coordinate with teammates while you wait.',
      ]
    }

    if (game.phase === 'hub_town') {
      const hub = ensureHubTownState(game)
      const lines: string[] = []
      lines.push(buildHubTownNarration(game, { location: hub.location, cue: 'Downtime in town gives the party room to recover and prepare.' }))
      lines.push(`Location: ${hub.location}`)
      lines.push(`Idle turns: ${hub.idleTurns}/${hub.autoEmbarkAfter}`)
      lines.push(`Party: ${summarizeParty(game)}`)
      if (isMyTurn) {
        lines.push('Use one of: visit_location, buy_item, sell_item, rest, embark, status')
      } else {
        lines.push(`Waiting for ${game.currentPlayer} to act in hub town.`)
      }
      return lines.filter(Boolean)
    }

    const blockedRecruitment = (() => {
      if (!room || typeof room !== 'object') return ''
      const candidate = room as { type?: unknown; requiredClass?: unknown }
      if (candidate.type !== 'barrier') return ''
      const requiredClass = typeof candidate.requiredClass === 'string' ? candidate.requiredClass : ''
      if (!requiredClass) return ''
      const party = Array.isArray(game.party) ? game.party : []
      const hasClass = party.some((member) => member?.klass === requiredClass)
      if (hasClass) return ''
      return `URGENT: Recruit ${requiredClass} via message tool`
    })()

    const persistentLines: string[] = []
    if (ctx.loadCharacter) {
      try {
        const persistentCharacter = (await ctx.loadCharacter()) as PersistentCharacter | null
        if (persistentCharacter && persistentCharacter.klass) {
          const lvl = Number.isFinite(persistentCharacter.level) ? Math.max(1, Math.floor(persistentCharacter.level)) : 1
          const xp = Number.isFinite(persistentCharacter.xp) ? Math.max(0, Math.floor(persistentCharacter.xp)) : 0
          const next = XP_TABLE[Math.min(XP_TABLE.length - 1, lvl)] ?? XP_TABLE[XP_TABLE.length - 1]!
          persistentLines.push(`Level ${lvl} ${persistentCharacter.klass} (${xp}/${next} XP to next level)`)
          if (persistentCharacter.backstory) persistentLines.push(`Your backstory: ${persistentCharacter.backstory}`)
          if (Array.isArray(persistentCharacter.achievements) && persistentCharacter.achievements.length > 0) {
            persistentLines.push(`🏆 Your achievements: ${persistentCharacter.achievements.join(', ')}`)
          }
          if (Array.isArray(persistentCharacter.adventureLog) && persistentCharacter.adventureLog.length > 0) {
            persistentLines.push('📜 CAMPAIGN HISTORY:')
            persistentLines.push('Your previous adventures:')
            for (const entry of persistentCharacter.adventureLog.slice(-3)) {
              persistentLines.push(`- ${entry}`)
            }
          }
          if (persistentCharacter.gamesPlayed > 0) {
            persistentLines.push(
              `Veteran of ${persistentCharacter.gamesPlayed} adventures (Level ${persistentCharacter.level}, ${persistentCharacter.deaths} deaths)`
            )
          }
        }
      } catch {
        // non-fatal
      }
    }

    const isGrimlockAgent = ctx.agentName.trim().toLowerCase() === 'grimlock'
    const campaignLines: string[] = []
    const campaignContext = game.campaignContext
    if (campaignContext) {
      campaignLines.push(`Campaign: ${campaignContext.name}`)
      if (campaignContext.premise) campaignLines.push(`Premise: ${campaignContext.premise}`)
      if (campaignContext.activeArcs.length > 0) campaignLines.push(`Active arcs: ${campaignContext.activeArcs.join(', ')}`)
      if (campaignContext.factions.length > 0) {
        campaignLines.push('Faction standing:')
        for (const factionLine of campaignContext.factions.slice(0, 4)) {
          campaignLines.push(`- ${factionLine}`)
        }
      }
      if (campaignContext.npcs.length > 0) campaignLines.push(`Recurring NPCs: ${campaignContext.npcs.join(', ')}`)
    }
    if (isGrimlockAgent) {
      const recaps = Array.isArray(game.campaignLog)
        ? game.campaignLog
          .filter((line): line is string => typeof line === 'string' && line.startsWith('Previously on: '))
          .map((line) => line.slice('Previously on: '.length).trim())
          .filter(Boolean)
          .slice(-3)
        : []
      if (recaps.length > 0) {
        campaignLines.push('Previously on...')
        for (const recap of recaps) {
          campaignLines.push(`- ${recap}`)
        }
      }
    }

    const roleSkillLines: string[] = []
    if (isGrimlockAgent) {
      const skill = isMyTurn ? DM_SKILL : DM_SKILL_BRIEF
      roleSkillLines.push(skill)
    } else {
      const klass = partyMember?.klass?.toLowerCase() ?? ''
      const skillMap: Record<string, { full: string; brief: string }> = {
        warrior: { full: WARRIOR_SKILL, brief: WARRIOR_SKILL_BRIEF },
        scout: { full: SCOUT_SKILL, brief: SCOUT_SKILL_BRIEF },
        mage: { full: MAGE_SKILL, brief: MAGE_SKILL_BRIEF },
        healer: { full: HEALER_SKILL, brief: HEALER_SKILL_BRIEF },
      }
      const classSkill = skillMap[klass]
      if (isMyTurn) {
        roleSkillLines.push(classSkill?.full ?? 'Play your class to its strengths.')
        roleSkillLines.push(PARTY_TACTICS)
      } else {
        roleSkillLines.push(classSkill?.brief ?? 'Wait for your turn. Coordinate with the party via environment_broadcast.')
      }
    }

    const lines: string[] = []
    const feedLines: string[] = []
    const feed = Array.isArray(game.feedMessages) ? game.feedMessages : []
    if (feed.length > 0) {
      const mention = `@${agentName.toLowerCase()}`
      const isDm = agentName.toLowerCase() === 'grimlock'
      const relevant = feed.filter((message: any) => {
        const to = typeof message?.to === 'string' ? message.to.toLowerCase() : ''
        const text = typeof message?.message === 'string' ? message.message.toLowerCase() : ''
        if (to === '@party') return true
        if (to === mention) return true
        if (to === '@dm' && isDm) return true
        return Boolean(mention && text.includes(mention))
      })
      const recent = relevant.slice(-10)
      if (recent.length > 0) {
        feedLines.push('Recent messages (no response required):')
        for (const message of recent) {
          const to = typeof message?.to === 'string' ? message.to : ''
          const content = typeof message?.message === 'string' ? message.message : ''
          const sender = typeof message?.sender === 'string' ? message.sender : 'unknown'
          const kind = message?.type === 'ic' || message?.type === 'ooc' ? (message.type as FeedMessageType) : 'ooc'

          if (kind === 'ic') {
            const senderCharacter = Array.isArray(game.party)
              ? game.party.find((member) => member && isCharacter(member, sender))
              : undefined
            const senderName = senderCharacter?.name ?? sender
            const targetHandle = to.toLowerCase()
            const targetAgent = targetHandle.startsWith('@') ? targetHandle.slice(1) : targetHandle
            const targetCharacter = Array.isArray(game.party)
              ? game.party.find((member) => member && isCharacter(member, targetAgent))
              : undefined
            const targetName = targetHandle === '@party' ? 'the party' : targetHandle === '@dm' ? 'the DM' : targetCharacter?.name ?? to
            feedLines.push(`- IC ${senderName} -> ${targetName} (${to}): ${content}`)
          } else {
            feedLines.push(`- OOC ${sender} -> ${to}: ${content}`)
          }
        }
      }
    }

    if (isMyTurn) {
      lines.push(`🎮🎮🎮 IT IS YOUR TURN in RPG adventure ${row.id}!`)
      if (freeformExploration) lines.push('Exploration mode is freeform: any party member can act right now.')
      if (partyMember) lines.push(`You are ${partyMember.name} the ${partyMember.klass} (HP: ${partyMember.hp}/${partyMember.maxHp})`)
      lines.push(...persistentLines)
      lines.push(...campaignLines)
      lines.push(...feedLines)
      if (room) lines.push(`Current room: ${room.description ?? ''} (type: ${room.type})`)
      if (blockedRecruitment) lines.push(blockedRecruitment)
      lines.push(...roleSkillLines)
      lines.push('')
      if (game.mode === 'combat') {
        const livingEnemies = listLivingEnemies(game)
        const enemies =
          livingEnemies
            .map((enemy) => {
              const negotiable = enemyIsNegotiable(enemy) ? 'yes' : 'no'
              const morale = enemyMoraleState(enemy)
              return `${enemy.name} (HP:${enemy.hp}/${enemy.maxHp}, negotiable:${negotiable}, morale:${morale})`
            })
            .join(', ') || 'unknown'
        const negotiableNow = livingEnemies.filter((enemy) => enemyIsNegotiable(enemy)).map((enemy) => enemy.name)
        lines.push(`⚔️ COMBAT! Enemies: ${enemies}`)
        lines.push(`Negotiable now: ${negotiableNow.length > 0 ? negotiableNow.join(', ') : 'none'}`)
        if (room?.type === 'boss') lines.push('Boss encounter: flee is unavailable.')
        lines.push('')
        if (partyMember) lines.push(buildAbilityMenu(partyMember))
        lines.push('')
        lines.push('ACTIONS: attack, cast_spell <spell>, use_skill <ability>, use_item <item>, negotiate, flee, intimidate, resurrect')
        lines.push(`Example: rpg({"command":"cast_spell","spell":"fireball","gameId":"${row.id}"})`)
      } else {
        lines.push(`Use the rpg tool to act: rpg({"command":"explore","gameId":"${row.id}"})`)
        if (nextEncounterRoomIndex(game) != null) {
          lines.push(`Optional: rpg({"command":"sneak","gameId":"${row.id}"}) to bypass the next encounter.`)
        }
      }
      lines.push('DO NOT create a new environment.')
    } else {
      if (freeformExploration) {
        lines.push(`🎮🎮🎮 RPG adventure ${row.id} is in freeform exploration mode.`)
      } else {
        lines.push(`🎲 Active RPG adventure: ${row.id} — waiting for ${game.currentPlayer}.`)
      }
      if (partyMember) lines.push(`You are ${partyMember.name} the ${partyMember.klass} (HP: ${partyMember.hp}/${partyMember.maxHp})`)
      lines.push(...persistentLines)
      lines.push(...campaignLines)
      lines.push(...feedLines)
      if (room) lines.push(`Current room: ${room.description ?? ''} (type: ${room.type})`)
      if (blockedRecruitment) lines.push(blockedRecruitment)
      lines.push(...roleSkillLines)
      if (freeformExploration) {
        lines.push(`Use the rpg tool to act now: rpg({"command":"explore","gameId":"${row.id}"})`)
      } else {
        lines.push('Wait for your turn.')
        lines.push('Use environment_broadcast to coordinate with teammates while waiting.')
      }
      lines.push('DO NOT create a new environment.')
    }

    return lines.filter(Boolean)
  } catch {
    return []
  }
}
