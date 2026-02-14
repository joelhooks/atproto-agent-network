import {
  SPELLS,
  attack,
  gmInterveneIfStuck,
  resolveAbility,
  resolveSkillCheck,
  resolveSpell,
  type Character,
  type Dice,
  type Enemy,
  type RpgGameState,
} from '../../../games/rpg-engine'
import { runEnemyFreeAttackRound, resolveCombatAttack } from '../systems/combat-resolver'
import { ensureCharacterLootState, makeShopHealingPotion, maybeAwardEnemyDrop } from '../systems/loot-system'
import { advanceTurn } from '../systems/turn-manager'
import { awardKillXp } from '../systems/xp-system'
import { resetHubTownIdle, transitionCampaignCompletionToHubTown } from '../systems/hub-town'

import type { EncounterDispositionInput } from './exploration-commands'

type CommandFailure = { ok: false; error: string }
type CommandSuccess = {
  content: Array<{ type: 'text'; text: string }>
  details?: Record<string, unknown>
}

export type CombatCommandResult = CommandFailure | CommandSuccess

export type CombatCommandDeps = {
  saveGame: () => Promise<void>
  summarizeParty: (game: RpgGameState) => string
  emitEnvironmentCompleted: () => Promise<void>
  applyEncounterDispositionToCampaign: (input: EncounterDispositionInput) => Promise<void>
}

export type CombatCommandInput = {
  command: string
  game: RpgGameState
  gameId: string
  params: Record<string, unknown>
  agentName: string
  dice: Dice
  deps: CombatCommandDeps
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

function applyResurrectionWeakness(target: Character): void {
  target.skills.attack = clampSkill(target.skills.attack - 10)
  target.skills.dodge = clampSkill(target.skills.dodge - 10)
  target.skills.cast_spell = clampSkill(target.skills.cast_spell - 10)
  target.skills.use_skill = clampSkill(target.skills.use_skill - 10)
  target.resurrectionWeakness = 10
}

export async function executeCombatCommand(input: CombatCommandInput): Promise<CombatCommandResult | null> {
  const { command, game, gameId, params, agentName, dice, deps } = input

  if (command === 'attack') {
    if (game.currentPlayer !== agentName) {
      return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
    }

    const beforePhase = game.phase

    if (game.mode === 'combat' && game.combat?.enemies?.length) {
      const enemy = game.combat.enemies.find((e) => e.hp > 0)
      if (!enemy) {
        game.mode = 'exploring'
        game.combat = undefined
      } else {
        const attackerName = agentName || 'unknown'
        const attacker = game.party.find((p) => isCharacter(p, attackerName))
        if (!attacker) throw new Error('Create your character before attacking')

        const attackResult = resolveCombatAttack({
          game,
          attacker,
          attackerId: attackerName,
          enemy,
          dice,
        })
        const lines: string[] = [attackResult.text]

        if (attackResult.killed) {
          awardKillXp(game, attackerName, enemy)

          await deps.applyEncounterDispositionToCampaign({
            game,
            enemies: [enemy],
            resolution: 'kill',
            reason: `${attackerName} killed a ${enemy.name} during an encounter.`,
          })

          const dropLine = maybeAwardEnemyDrop(game, attacker, enemy, dice)
          if (dropLine) {
            lines.push(`Loot: ${dropLine}`)
          }
        }
        lines.push(...runEnemyFreeAttackRound(game, dice))
        let text = lines.filter(Boolean).join('\n')

        if (game.phase === 'playing' && game.combat?.enemies?.every((e) => e.hp <= 0)) {
          game.mode = 'exploring'
          game.combat = undefined
          text += '\nCombat ends.'
        }

        gmInterveneIfStuck(game, {
          player: agentName || 'unknown',
          action: 'attack',
          target: `enemy:${enemy.name}`,
        })

        advanceTurn(game)
        const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

        await deps.saveGame()

        if (completion.completed) {
          await deps.emitEnvironmentCompleted()
        }

        return { content: toTextContent(`${text}\n\nParty: ${deps.summarizeParty(game)}`), details: { gameId } }
      }
    }

    const defender = typeof params.defender === 'string' ? params.defender.trim() : ''
    if (!defender) throw new Error('defender required when not in combat')

    const result = attack(game, { attacker: agentName || 'unknown', defender, dice })

    gmInterveneIfStuck(game, {
      player: agentName || 'unknown',
      action: 'attack',
      target: `party:${defender}`,
    })

    advanceTurn(game)
    const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

    await deps.saveGame()

    if (completion.completed) {
      await deps.emitEnvironmentCompleted()
    }

    return {
      content: toTextContent(`${result.detail}.\nParty: ${deps.summarizeParty(game)}`),
      details: { gameId, hit: result.hit },
    }
  }

  if (command === 'rest') {
    const actor = game.party.find((p) => isCharacter(p, agentName || 'unknown'))
    if (!actor) throw new Error('Create your character before resting')

    if (game.phase === 'hub_town') {
      for (const member of game.party) {
        if ((member.hp ?? 0) <= 0) continue
        member.hp = member.maxHp
        member.mp = member.maxMp
      }
      resetHubTownIdle(game)
      advanceTurn(game)

      await deps.saveGame()

      return {
        content: toTextContent(`You rest at town and fully recover. Party: ${deps.summarizeParty(game)}`),
        details: { gameId, phase: game.phase },
      }
    }

    if ((actor.hp ?? 0) <= 0) {
      return { ok: false, error: 'You are dead. You cannot rest until revived.' }
    }
    ensureCharacterLootState(actor)

    const shopAction = typeof params.shop === 'string' ? params.shop.trim().toLowerCase() : ''
    const room = game.dungeon[game.roomIndex]
    if (shopAction) {
      if (room?.type !== 'rest') {
        return { ok: false, error: 'Shop actions are only available in rest rooms.' }
      }

      if (shopAction === 'buy_potion') {
        const cost = 15
        if (actor.gold < cost) return { ok: false, error: `Not enough gold (need ${cost}, have ${actor.gold}).` }
        const potion = makeShopHealingPotion(dice)
        actor.gold -= cost
        actor.inventory.push(potion)
        game.log.push({
          at: Date.now(),
          who: characterId(actor),
          what: `shop: bought ${potion.name} for ${cost} gold`,
        })

        await deps.saveGame()

        return {
          content: toTextContent(`Bought ${potion.name} for ${cost} gold. (${actor.gold} gold remaining)`),
          details: { gameId, item: potion.name, gold: actor.gold },
        }
      }

      if (shopAction === 'identify') {
        const cost = 10
        if (actor.gold < cost) return { ok: false, error: `Not enough gold (need ${cost}, have ${actor.gold}).` }
        actor.gold -= cost
        const lines = actor.inventory.length > 0
          ? actor.inventory.map((item) => {
              const fx = item.effects.length > 0
                ? item.effects.map((effect) => `${effect.bonus >= 0 ? '+' : ''}${effect.bonus} ${effect.stat}`).join(', ')
                : 'no passive bonus'
              return `- ${item.name}: ${fx}`
            })
          : ['- You carry no items to identify.']
        game.log.push({
          at: Date.now(),
          who: characterId(actor),
          what: `shop: identified inventory for ${cost} gold`,
        })

        await deps.saveGame()

        return {
          content: toTextContent(`Identified inventory for ${cost} gold.\n${lines.join('\n')}\nGold: ${actor.gold}`),
          details: { gameId, gold: actor.gold },
        }
      }

      return { ok: false, error: "Unknown shop action. Use 'buy_potion' or 'identify'." }
    }

    actor.hp = Math.min(actor.maxHp, actor.hp + 2)
    actor.mp = Math.min(actor.maxMp, actor.mp + 1)

    await deps.saveGame()

    return {
      content: toTextContent(`You rest. HP ${actor.hp}/${actor.maxHp} MP ${actor.mp}/${actor.maxMp}`),
      details: { gameId },
    }
  }

  if (command === 'use_skill') {
    const actor = game.party.find((p) => isCharacter(p, agentName || 'unknown'))
    if (!actor) throw new Error('Create your character before using skills')

    const abilityName = typeof params.skill === 'string' ? params.skill.trim().toLowerCase() : ''
    if (!abilityName) return { ok: false, error: 'skill required: power_strike, shield_bash, aimed_shot, stealth, heal_touch, protect' }

    const livingEnemies = (game.combat?.enemies ?? []).filter(e => e.hp > 0)
    const hpBeforeByEnemy = new Map(livingEnemies.map((enemy) => [enemy, enemy.hp] as const))
    const result = resolveAbility(actor, abilityName, livingEnemies, game.party, dice)

    if (result.abilityDef.mpCost > 0) {
      if (actor.mp < result.abilityDef.mpCost) return { ok: false, error: `Not enough MP (need ${result.abilityDef.mpCost}, have ${actor.mp})` }
      if (result.success) actor.mp -= result.abilityDef.mpCost
    }

    for (const enemy of livingEnemies) {
      if ((hpBeforeByEnemy.get(enemy) ?? 0) > 0 && enemy.hp <= 0) {
        awardKillXp(game, agentName || 'unknown', enemy)
        maybeAwardEnemyDrop(game, actor, enemy, dice)
      }
    }

    if (game.phase === 'playing' && game.combat?.enemies?.every((e) => e.hp <= 0)) {
      game.mode = 'exploring'
      game.combat = undefined
    }

    gmInterveneIfStuck(game, {
      player: agentName || 'unknown',
      action: 'use_skill',
      target: `ability:${abilityName}`,
    })

    advanceTurn(game)

    await deps.saveGame()

    game.log.push({ at: Date.now(), who: agentName, what: `use_skill ${abilityName}: ${result.narrative.slice(0, 120)}` })

    return {
      content: toTextContent(result.narrative),
      details: { gameId, ability: abilityName, success: result.success, damage: result.damage, healed: result.healed },
    }
  }

  if (command === 'use_item') {
    const actor = game.party.find((p) => isCharacter(p, agentName || 'unknown'))
    if (!actor) throw new Error('Create your character before using items')
    ensureCharacterLootState(actor)

    const query = typeof params.item === 'string' ? params.item.trim().toLowerCase() : ''
    const idx = actor.inventory.findIndex((item) => {
      if (!item || item.slot !== 'consumable' || !item.consumable) return false
      if (!query) return true
      return item.name.toLowerCase().includes(query)
    })

    if (idx < 0) {
      return { ok: false, error: query ? `No consumable matching "${query}" in inventory.` : 'No consumables in inventory.' }
    }

    const item = actor.inventory[idx]!
    const consumable = item.consumable
    if (!consumable) return { ok: false, error: `${item.name} cannot be consumed.` }

    actor.inventory.splice(idx, 1)
    let line = `You use ${item.name}.`
    if (consumable.type === 'heal') {
      const before = actor.hp
      actor.hp = Math.min(actor.maxHp, actor.hp + Math.max(0, consumable.amount))
      line = `You use ${item.name} and recover ${actor.hp - before} HP. (${actor.hp}/${actor.maxHp})`
    } else if (consumable.type === 'mp') {
      const before = actor.mp
      actor.mp = Math.min(actor.maxMp, actor.mp + Math.max(0, consumable.amount))
      line = `You use ${item.name} and recover ${actor.mp - before} MP. (${actor.mp}/${actor.maxMp})`
    } else if (consumable.type === 'buff') {
      const bonus = Math.max(0, consumable.amount)
      actor.skills.attack = clampSkill(actor.skills.attack + bonus)
      line = `You invoke ${item.name}. Attack +${bonus} for this adventure.`
    }

    game.log.push({
      at: Date.now(),
      who: characterId(actor),
      what: `use_item ${item.name}`,
    })

    if (game.phase === 'playing') {
      advanceTurn(game)
    }

    await deps.saveGame()

    return {
      content: toTextContent(line),
      details: { gameId, item: item.name, slot: item.slot },
    }
  }

  if (command === 'resurrect') {
    if (game.currentPlayer !== agentName) {
      return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
    }
    if (game.mode !== 'combat' && game.mode !== 'exploring') {
      return { ok: false, error: 'You can only resurrect during active exploration or combat.' }
    }

    const beforePhase = game.phase
    const actorName = agentName || 'unknown'
    const actor = game.party.find((p) => isCharacter(p, actorName))
    if (!actor) throw new Error('Create your character before resurrecting')
    if (actor.klass !== 'Healer') return { ok: false, error: 'Only a Healer can perform resurrection.' }
    if ((actor.hp ?? 0) <= 0) return { ok: false, error: 'You are dead. You cannot resurrect yourself.' }
    if (actor.mp < 4) return { ok: false, error: `Not enough MP for resurrection (need 4, have ${actor.mp}).` }

    const targetIdentity = typeof params.target === 'string' ? params.target.trim() : ''
    if (!targetIdentity) return { ok: false, error: 'target required for resurrect.' }
    const target = game.party.find((p) => isCharacter(p, targetIdentity))
    if (!target) return { ok: false, error: `Unknown target: ${targetIdentity}` }
    if (isCharacter(target, actorName)) return { ok: false, error: 'You cannot resurrect yourself.' }
    if ((target.hp ?? 0) > 0) return { ok: false, error: `${target.name} is not dead.` }
    if (target.diedThisAdventure !== true) {
      return { ok: false, error: `${target.name} did not die this adventure and cannot be resurrected.` }
    }
    if (target.resurrectionFailedThisAdventure === true) {
      return { ok: false, error: `${target.name} has already resisted resurrection; no retry this adventure.` }
    }

    actor.mp -= 4
    const skillTarget = clampSkill(actor.skills.cast_spell - 20)
    const check = resolveSkillCheck({ skill: skillTarget, dice })
    const lines: string[] = []
    let xpLoss = 0

    if (check.success) {
      actor.skills.cast_spell = check.nextSkill
      const targetId = characterId(target)
      const currentAdventureXp = Math.max(0, Math.floor(game.xpEarned?.[targetId] ?? 0))
      const reducedXp = Math.max(0, Math.floor(currentAdventureXp * 0.5))
      xpLoss = currentAdventureXp - reducedXp
      if (game.xpEarned && Object.prototype.hasOwnProperty.call(game.xpEarned, targetId)) {
        game.xpEarned[targetId] = reducedXp
      }

      target.hp = 1
      target.deathCause = undefined
      target.deathNarrated = false
      target.resurrectionFailedThisAdventure = false
      applyResurrectionWeakness(target)

      lines.push(`${target.name} returns to life at 1 HP.`)
      lines.push('Returning from death is exhausting: -10 to all skills for this adventure.')
      if (xpLoss > 0) lines.push(`${target.name} loses ${xpLoss} XP from this adventure.`)
      game.log.push({
        at: Date.now(),
        who: actorName,
        what: `resurrection: ${target.name} revived at 1 HP (-10 skills${xpLoss > 0 ? `, -${xpLoss} XP` : ''})`,
      })
    } else {
      target.resurrectionFailedThisAdventure = true
      lines.push(`Resurrection fails (${check.roll} > ${skillTarget}).`)
      lines.push('MP is spent. The soul slips away, and no retry is possible this adventure.')
      game.log.push({
        at: Date.now(),
        who: actorName,
        what: `resurrection failed on ${target.name} (roll ${check.roll} > ${skillTarget}); no retry this adventure`,
      })
    }

    gmInterveneIfStuck(game, {
      player: actorName,
      action: 'resurrect',
      target: target.name,
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
      details: { gameId, success: check.success, roll: check.roll, target: skillTarget, xpLoss },
    }
  }

  if (command === 'cast_spell') {
    const actor = game.party.find((p) => isCharacter(p, agentName || 'unknown'))
    if (!actor) throw new Error('Create your character before casting')

    const spell = typeof params.spell === 'string' ? params.spell.trim().toLowerCase() : ''
    if (!spell) return { ok: false, error: 'spell required: fireball, ice_lance, lightning, heal, shield, smite' }

    const spellDef = SPELLS[spell]
    if (!spellDef) return { ok: false, error: `Unknown spell: ${spell}. Available: ${Object.keys(SPELLS).join(', ')}` }
    if (actor.mp < spellDef.mpCost) return { ok: false, error: `Not enough MP for ${spellDef.name} (need ${spellDef.mpCost}, have ${actor.mp})` }

    const livingEnemies = (game.combat?.enemies ?? []).filter(e => e.hp > 0)
    const hpBeforeByEnemy = new Map(livingEnemies.map((enemy) => [enemy, enemy.hp] as const))
    const result = resolveSpell(actor, spell, livingEnemies, game.party, dice)

    if (result.success) {
      actor.mp -= spellDef.mpCost

      for (const enemy of livingEnemies) {
        if ((hpBeforeByEnemy.get(enemy) ?? 0) > 0 && enemy.hp <= 0) {
          awardKillXp(game, agentName || 'unknown', enemy)
          maybeAwardEnemyDrop(game, actor, enemy, dice)
        }
      }
    }

    if (game.phase === 'playing' && game.combat?.enemies?.every((e) => e.hp <= 0)) {
      game.mode = 'exploring'
      game.combat = undefined
    }

    gmInterveneIfStuck(game, {
      player: agentName || 'unknown',
      action: 'cast_spell',
      target: `spell:${spell}`,
    })

    advanceTurn(game)

    await deps.saveGame()

    game.log.push({ at: Date.now(), who: agentName, what: `cast_spell ${spell}: ${result.narrative.slice(0, 120)}` })

    await deps.saveGame()

    return {
      content: toTextContent(result.narrative),
      details: { gameId, spell, success: result.success, damage: result.damage, healed: result.healed },
    }
  }

  return null
}
