import {
  XP_PER_BOSS_KILL,
  XP_PER_ENEMY_KILL,
  XP_PER_PUZZLE,
  XP_PER_TRAP_DISARM,
  cloneEnemiesForCombat,
  enemyIsNegotiable,
  explore,
  findIntimidatableEnemies,
  gmInterveneIfStuck,
  isBossEncounterRoom,
  nextEncounterRoomIndex,
  partyAverageLevel,
  type Character,
  type Dice,
  type Enemy,
  type RpgGameState,
  describeRoom,
} from '../../../games/rpg-engine'
import {
  ensureHubTownState,
  buildHubTownNarration,
  transitionCampaignCompletionToHubTown,
} from '../systems/hub-town'
import {
  addLoggedXp,
  addXpEarned,
  awardAdventureCompleteXp,
  awardBarrierClearMilestoneXp,
  awardRoomClearXp,
  calculateEncounterXp,
} from '../systems/xp-system'
import { resolveTreasureLoot } from '../systems/loot-system'
import { runEnemyFreeAttackRound } from '../systems/combat-resolver'
import { advanceTurn } from '../systems/turn-manager'

type CommandFailure = { ok: false; error: string }
type CommandSuccess = {
  content: Array<{ type: 'text'; text: string }>
  details?: Record<string, unknown>
}

export type ExplorationCommandResult = CommandFailure | CommandSuccess

export type EncounterDispositionInput = {
  game: RpgGameState
  enemies: Enemy[]
  resolution: 'kill' | 'negotiate'
  reason: string
}

export type ExplorationCommandDeps = {
  saveGame: () => Promise<void>
  summarizeParty: (game: RpgGameState) => string
  emitEnvironmentCompleted: () => Promise<void>
  applyEncounterDispositionToCampaign: (input: EncounterDispositionInput) => Promise<void>
}

export type ExplorationCommandInput = {
  command: string
  game: RpgGameState
  gameId: string
  params: Record<string, unknown>
  agentName: string
  dice: Dice
  deps: ExplorationCommandDeps
}

function toTextContent(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

function characterId(c: Character | undefined | null): string {
  if (!c) return 'unknown'
  return c.agent ?? c.name
}

function isCharacter(c: Character, identity: string): boolean {
  return c.agent === identity || c.name === identity
}

function clampSkill(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(100, Math.floor(value)))
}

function listLivingEnemies(game: RpgGameState): Enemy[] {
  return (game.combat?.enemies ?? []).filter((enemy) => (enemy?.hp ?? 0) > 0)
}

function livingPartyIds(game: RpgGameState): string[] {
  const party = Array.isArray(game.party) ? game.party : []
  return party.filter((p) => (p?.hp ?? 0) > 0).map((p) => characterId(p))
}

function findActingCharacter(game: RpgGameState, agentName: string): Character | undefined {
  const agent = String(agentName ?? '').trim()
  return (
    (Array.isArray(game.party) ? game.party.find((p) => p && isCharacter(p, agent)) : undefined) ??
    (Array.isArray(game.party) ? game.party.find((p) => p && isCharacter(p, game.currentPlayer)) : undefined) ??
    (Array.isArray(game.party) ? game.party[0] : undefined)
  )
}

export async function executeExplorationCommand(input: ExplorationCommandInput): Promise<ExplorationCommandResult | null> {
  const { command, game, gameId, agentName, dice, deps } = input

  if (command === 'explore') {
    if (game.currentPlayer !== agentName) {
      return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
    }
    if (game.dungeon.length === 0) {
      return { ok: false, error: 'No dungeon yet — the GM must craft_dungeon before the adventure can begin. Wait for the Dungeon Master.' }
    }
    const atDungeonEnd = game.roomIndex >= Math.max(0, game.dungeon.length - 1)
    if (atDungeonEnd) {
      game.mode = 'exploring'
      game.combat = undefined
    }
    const combatActive = game.mode === 'combat' && (game.combat?.enemies ?? []).some((enemy) => (enemy?.hp ?? 0) > 0)
    if (combatActive) {
      return {
        ok: false,
        error: "You're in combat! Use: attack, negotiate, flee, or intimidate. Type 'status' for details.",
      }
    }
    if (game.mode === 'combat') {
      game.mode = 'exploring'
      game.combat = undefined
    }

    const beforePhase = game.phase
    const beforeRoomIndex = game.roomIndex
    const beforeLogLength = (game.log ??= []).length
    const actingBefore = findActingCharacter(game, agentName)
    const actingBeforeId = characterId(actingBefore)
    const actingUseSkillBefore = Number.isFinite(actingBefore?.skills?.use_skill)
      ? Math.max(0, Math.floor((actingBefore?.skills?.use_skill as number)))
      : null
    const attemptedRoomIndex = game.roomIndex + 1
    const result = explore(game, { dice })
    let lootLine = ''

    if (game.roomIndex > beforeRoomIndex) {
      const enteredRoom = game.dungeon[game.roomIndex]
      const newLogSlice = game.log.slice(beforeLogLength)
      if (enteredRoom?.type === 'treasure') {
        const actor = findActingCharacter(game, agentName)
        if (actor) {
          lootLine = resolveTreasureLoot(game, actor, dice)
        }
      }
      if (enteredRoom?.type === 'trap' && actingUseSkillBefore != null) {
        const actorAfter = game.party.find((p) => p && isCharacter(p, actingBeforeId))
        if (actorAfter && actorAfter.skills.use_skill > actingUseSkillBefore) {
          addLoggedXp(game, characterId(actorAfter), XP_PER_TRAP_DISARM, 'trap disarm')
        }
      }
      if (enteredRoom?.type === 'puzzle' && actingUseSkillBefore != null) {
        const actorAfter = game.party.find((p) => p && isCharacter(p, actingBeforeId))
        if (actorAfter && actorAfter.skills.use_skill > actingUseSkillBefore) {
          for (const id of livingPartyIds(game)) addLoggedXp(game, id, XP_PER_PUZZLE, 'puzzle')
        }
      }
      if (enteredRoom?.type === 'barrier') {
        awardBarrierClearMilestoneXp(game, { logSlice: newLogSlice, fallbackActorId: actingBeforeId })
      }
    }

    gmInterveneIfStuck(game, {
      player: agentName || 'unknown',
      action: 'explore',
      target: `room:${attemptedRoomIndex}:${result.room?.type ?? 'none'}`,
    })

    if (game.roomIndex > beforeRoomIndex) {
      awardRoomClearXp(game)
    }

    if (beforePhase !== 'finished' && game.phase === 'finished' && game.dungeon.length > 1) {
      awardAdventureCompleteXp(game)
    }

    advanceTurn(game)
    const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

    await deps.saveGame()

    if (completion.completed) {
      await deps.emitEnvironmentCompleted()
    }

    return {
      content: toTextContent(
        (() => {
          if (game.phase === 'hub_town') {
            const hub = ensureHubTownState(game)
            return `${buildHubTownNarration(game, {
              location: hub.location,
              cue: 'The dungeon expedition ends for now, and town life resumes.',
            })}\n\nParty: ${deps.summarizeParty(game)}`
          }
          if (game.phase !== 'playing') return 'The adventure is complete.'
          const roomNow = game.dungeon[game.roomIndex]
          if (!roomNow) return 'The adventure is complete.'
          const lootText = lootLine ? `\n${lootLine}` : ''
          return `You enter: ${roomNow.type}\n${describeRoom(game, game.roomIndex)}${lootText}\n\nParty: ${deps.summarizeParty(game)}`
        })()
      ),
      details: { gameId, room: game.phase === 'playing' ? game.dungeon[game.roomIndex] ?? null : null, mode: game.mode },
    }
  }

  if (command === 'negotiate') {
    if (game.currentPlayer !== agentName) {
      return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
    }
    if (game.mode !== 'combat') {
      return { ok: false, error: 'You can only negotiate during combat.' }
    }

    const beforePhase = game.phase
    const actorName = agentName || 'unknown'
    const actor = game.party.find((p) => isCharacter(p, actorName))
    if (!actor) throw new Error('Create your character before negotiating')

    const enemies = listLivingEnemies(game)
    if (enemies.length === 0) {
      game.mode = 'exploring'
      game.combat = undefined
      return { ok: false, error: 'There are no enemies to negotiate with.' }
    }

    if (enemies.some((enemy) => enemy.negotiable !== true || !enemyIsNegotiable(enemy))) {
      return { ok: false, error: 'Negotiation fails: some enemies are mindless or unwilling to parley.' }
    }

    const target = clampSkill(40 + partyAverageLevel(game.party) * 5)
    const roll = dice.d100()
    const success = roll <= target
    const lines: string[] = []

    if (success) {
      const encounterXp = calculateEncounterXp(enemies)
      const partialXp = Math.max(0, Math.floor(encounterXp * 0.75))
      for (const id of livingPartyIds(game)) addXpEarned(game, id, partialXp)

      await deps.applyEncounterDispositionToCampaign({
        game,
        enemies,
        resolution: 'negotiate',
        reason: `${actorName} negotiated a peaceful resolution after combat tensions.`,
      })

      game.mode = 'exploring'
      game.combat = undefined

      const boon = dice.d(2) === 1
        ? 'The foes trade safe-passage terms and reveal a useful route ahead.'
        : 'The foes accept terms and leave behind a small cache of supplies.'
      lines.push(`Negotiation succeeds (${roll} <= ${target}). The enemies stand down.`)
      lines.push(boon)
      if (partialXp > 0) {
        lines.push(`Party gains ${partialXp} XP (diplomatic resolution).`)
        game.log.push({ at: Date.now(), who: actorName, what: `gained ${partialXp} XP (negotiate)` })
      }
    } else {
      lines.push(`Negotiation fails (${roll} > ${target}). The enemies seize the initiative!`)
      lines.push(...runEnemyFreeAttackRound(game, dice))
    }

    gmInterveneIfStuck(game, {
      player: actorName,
      action: 'negotiate',
      target: enemies.map((enemy) => enemy.name).join(','),
    })

    if (game.phase === 'playing') {
      advanceTurn(game)
    }
    const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

    await deps.saveGame()

    if (completion.completed) {
      await deps.emitEnvironmentCompleted()
    }

    return {
      content: toTextContent(`${lines.join('\n')}\n\nParty: ${deps.summarizeParty(game)}`),
      details: { gameId, success, roll, target },
    }
  }

  if (command === 'flee') {
    if (game.currentPlayer !== agentName) {
      return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
    }
    if (game.mode !== 'combat') {
      return { ok: false, error: 'You can only flee during combat.' }
    }
    if (isBossEncounterRoom(game)) {
      return { ok: false, error: 'You cannot flee from a boss encounter.' }
    }

    const beforePhase = game.phase
    const actorName = agentName || 'unknown'
    const actor = game.party.find((p) => isCharacter(p, actorName))
    if (!actor) throw new Error('Create your character before fleeing')

    const roll = dice.d100()
    const target = 50
    const success = roll <= target
    const lines: string[] = []

    if (success) {
      addLoggedXp(game, actorName, 10, 'flee')
      lines.push(`Retreat succeeds (${roll} <= ${target}). The party escapes without taking damage.`)
      lines.push('You gain 10 XP for surviving the retreat.')
    } else {
      lines.push(`Retreat falters (${roll} > ${target}). You escape under enemy fire.`)
      lines.push(...runEnemyFreeAttackRound(game, dice))
    }

    if (game.phase === 'playing') {
      game.mode = 'exploring'
      game.combat = undefined
      if (game.roomIndex > 0) game.roomIndex -= 1
    }

    gmInterveneIfStuck(game, {
      player: actorName,
      action: 'flee',
      target: `room:${game.roomIndex}`,
    })

    if (game.phase === 'playing') {
      advanceTurn(game)
    }
    const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

    await deps.saveGame()

    if (completion.completed) {
      await deps.emitEnvironmentCompleted()
    }

    if (!success) lines.push('No XP awarded. The encounter remains dangerous.')
    return {
      content: toTextContent(`${lines.join('\n')}\n\nParty: ${deps.summarizeParty(game)}`),
      details: { gameId, success, roll, target },
    }
  }

  if (command === 'sneak') {
    if (game.currentPlayer !== agentName) {
      return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
    }
    if (game.mode === 'combat') {
      return { ok: false, error: 'Too late to sneak. Combat has already started.' }
    }

    const beforePhase = game.phase
    const actorName = agentName || 'unknown'
    const actor = game.party.find((p) => isCharacter(p, actorName))
    if (!actor) throw new Error('Create your character before sneaking')

    const encounterIndex = nextEncounterRoomIndex(game)
    if (encounterIndex == null) {
      return { ok: false, error: 'There is no encounter ahead to sneak past.' }
    }
    const encounterRoom = game.dungeon[encounterIndex]
    if (!encounterRoom || (encounterRoom.type !== 'combat' && encounterRoom.type !== 'boss')) {
      return { ok: false, error: 'There is no encounter ahead to sneak past.' }
    }

    const scoutBonus = actor.klass === 'Scout' ? 20 : 0
    const target = clampSkill(50 + scoutBonus)
    const roll = dice.d100()
    const success = roll <= target
    const lines: string[] = []

    if (success) {
      const skippedTo = encounterIndex + 1
      if (skippedTo >= game.dungeon.length) {
        game.phase = 'finished'
        game.mode = 'finished'
        game.combat = undefined
        lines.push(`Sneak succeeds (${roll} <= ${target}). You bypass the encounter and reach the dungeon exit.`)
      } else {
        game.roomIndex = skippedTo
        const landed = game.dungeon[game.roomIndex]
        if (landed && (landed.type === 'combat' || landed.type === 'boss')) {
          game.mode = 'combat'
          game.combat = { enemies: cloneEnemiesForCombat(landed.enemies) }
        } else {
          game.mode = 'exploring'
          game.combat = undefined
        }
        lines.push(`Sneak succeeds (${roll} <= ${target}). You bypass the encounter unseen.`)
        lines.push(`You move to: ${landed?.description ?? 'the next chamber'} (type: ${landed?.type ?? 'unknown'}).`)
      }
    } else {
      game.roomIndex = encounterIndex
      game.mode = 'combat'
      game.combat = { enemies: cloneEnemiesForCombat(encounterRoom.enemies) }
      lines.push(`Sneak fails (${roll} > ${target}). The enemies spot you and strike first!`)
      lines.push(...runEnemyFreeAttackRound(game, dice))
    }

    gmInterveneIfStuck(game, {
      player: actorName,
      action: 'sneak',
      target: `room:${encounterIndex}`,
    })

    if (game.phase === 'playing') {
      advanceTurn(game)
    }
    const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

    await deps.saveGame()

    if (completion.completed) {
      await deps.emitEnvironmentCompleted()
    }

    return {
      content: toTextContent(`${lines.join('\n')}\n\nParty: ${deps.summarizeParty(game)}`),
      details: { gameId, success, roll, target },
    }
  }

  if (command === 'intimidate') {
    if (game.currentPlayer !== agentName) {
      return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
    }
    if (game.mode !== 'combat') {
      return { ok: false, error: 'You can only intimidate during combat.' }
    }

    const beforePhase = game.phase
    const actorName = agentName || 'unknown'
    const actor = game.party.find((p) => isCharacter(p, actorName))
    if (!actor) throw new Error('Create your character before intimidating')

    const livingEnemies = listLivingEnemies(game)
    const eligible = findIntimidatableEnemies(livingEnemies)
    if (eligible.length === 0) {
      return { ok: false, error: 'No enemies are shaken and wounded enough to intimidate.' }
    }

    const roll = dice.d100()
    const target = 45
    const success = roll <= target
    const lines: string[] = []

    if (success) {
      let awarded = 0
      for (const enemy of eligible) {
        enemy.hp = 0
        ;(enemy as any).fled = true
        const base = XP_PER_ENEMY_KILL + (enemy.tactics?.kind === 'boss' ? XP_PER_BOSS_KILL : 0)
        awarded += Math.max(0, Math.floor(base * 0.5))
      }
      if (awarded > 0) {
        addXpEarned(game, actorName, awarded)
        game.log.push({ at: Date.now(), who: actorName, what: `gained ${awarded} XP (intimidate)` })
      }
      lines.push(`Intimidation succeeds (${roll} <= ${target}). ${eligible.length} enemy(s) flee in panic.`)
      if (awarded > 0) lines.push(`You gain ${awarded} XP (reduced for routed foes).`)
      if ((game.combat?.enemies ?? []).every((enemy) => enemy.hp <= 0)) {
        game.mode = 'exploring'
        game.combat = undefined
        lines.push('Combat ends.')
      }
    } else {
      for (const enemy of livingEnemies) {
        enemy.attack = clampSkill(enemy.attack + 10)
      }
      lines.push(`Intimidation fails (${roll} > ${target}). The enemies become enraged (+10 attack).`)
    }

    gmInterveneIfStuck(game, {
      player: actorName,
      action: 'intimidate',
      target: eligible.map((enemy) => enemy.name).join(','),
    })

    if (game.phase === 'playing') {
      advanceTurn(game)
    }
    const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

    await deps.saveGame()

    if (completion.completed) {
      await deps.emitEnvironmentCompleted()
    }

    return {
      content: toTextContent(`${lines.join('\n')}\n\nParty: ${deps.summarizeParty(game)}`),
      details: { gameId, success, roll, target, affected: eligible.map((enemy) => enemy.name) },
    }
  }

  return null
}
