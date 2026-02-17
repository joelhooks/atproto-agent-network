import type { Character, Dice, Enemy, RpgGameState } from '../../../games/rpg-engine'
import { livingParty, markCharacterDeath, partyWipe, resolveSkillCheck } from '../../../games/rpg-engine'

import type { AttackResult, CombatResolver } from '../interfaces'

export type CombatAttackResult = AttackResult & {
  hit: boolean
  text: string
  damage: number
  killed: boolean
}

export type CombatSystem = Pick<CombatResolver, 'resolveEnemyRound'> & {
  resolveCombatAttack: (input: {
    game: RpgGameState
    attacker: Character
    attackerId: string
    enemy: Enemy
    dice: Dice
    now?: () => number
  }) => CombatAttackResult
}

function clampSkill(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(100, Math.floor(value)))
}

function deathLocale(game: RpgGameState): string {
  const locale = typeof game.theme?.name === 'string' ? game.theme.name.trim() : ''
  return locale || 'the dungeon'
}

function deathCauseFromAttacker(game: RpgGameState, attackerName: string): string {
  return `slain by ${attackerName} in ${deathLocale(game)}`
}

export function resolveCombatAttack(input: {
  game: RpgGameState
  attacker: Character
  attackerId: string
  enemy: Enemy
  dice: Dice
  now?: () => number
}): CombatAttackResult {
  const now = input.now ?? Date.now
  const { game, attacker, attackerId, enemy, dice } = input
  const attackRoll = resolveSkillCheck({ skill: attacker.skills.attack, dice })
  const dodgeRoll = resolveSkillCheck({ skill: enemy.dodge, dice })
  const attackMargin = attackRoll.success ? attacker.skills.attack - attackRoll.roll : Number.NEGATIVE_INFINITY
  const dodgeMargin = dodgeRoll.success ? enemy.dodge - dodgeRoll.roll : Number.NEGATIVE_INFINITY
  const hit = attackRoll.success && (!dodgeRoll.success || attackMargin > dodgeMargin)

  if (!hit) {
    const text = `The ${enemy.name} avoids your attack.`
    game.log ??= []
    game.log.push({ at: now(), who: attackerId, what: `attack: missed ${enemy.name}` })
    return { ok: true, hit: false, text, damage: 0, killed: false }
  }

  const hpBefore = enemy.hp
  const damage = dice.d(6) + Math.floor(attacker.stats.STR / 25)
  enemy.hp = Math.max(0, enemy.hp - damage)
  attacker.skills.attack = attackRoll.nextSkill

  const text = `You strike the ${enemy.name} for ${damage}. (${enemy.hp} HP left)`
  game.log ??= []
  game.log.push({ at: now(), who: attackerId, what: `attack: hit ${enemy.name} for ${damage} (${enemy.hp} HP left)` })

  return {
    ok: true,
    hit: true,
    text,
    damage,
    killed: hpBefore > 0 && enemy.hp === 0,
  }
}

// ── Tactical Target Selection ────────────────────────────────────────────────
// Monsters aren't stupid. They pick targets based on their tactics archetype.

function selectTarget(enemy: Enemy, targets: Character[], dice: Dice): Character {
  if (targets.length === 1) return targets[0]!
  const kind = enemy.tactics?.kind ?? 'unknown'

  switch (kind) {
    // Focus-fire the healer — kill the party's sustain first
    case 'goblin':
    case 'ambush':
    case 'pack': {
      const healer = targets.find(t => t.klass === 'Healer')
      if (healer) return healer
      const mage = targets.find(t => t.klass === 'Mage')
      if (mage) return mage
      // Fallback: weakest target (lowest HP)
      return targets.reduce((a, b) => a.hp < b.hp ? a : b)
    }

    // Ranged/spellcaster — target the squishiest (lowest dodge)
    case 'ranged':
    case 'spellcaster': {
      return targets.reduce((a, b) => a.skills.dodge < b.skills.dodge ? a : b)
    }

    // Berserker/orc — attack whoever hit them last, or the strongest
    case 'berserker':
    case 'orc': {
      // Proxy for "who hit me": target with highest attack skill (most dangerous)
      return targets.reduce((a, b) => a.skills.attack > b.skills.attack ? a : b)
    }

    // Boss — strategic: focus-fire the lowest HP target to get kills
    case 'boss': {
      // Prioritize near-death targets to score kills and break morale
      const nearDeath = targets.filter(t => t.hp <= t.maxHp * 0.3)
      if (nearDeath.length > 0) return nearDeath.reduce((a, b) => a.hp < b.hp ? a : b)
      // Otherwise target the healer
      const healer = targets.find(t => t.klass === 'Healer')
      if (healer) return healer
      return targets.reduce((a, b) => a.hp < b.hp ? a : b)
    }

    // Guardian — attack whoever is closest to the objective (highest level/most dangerous)
    case 'guardian': {
      return targets.reduce((a, b) => (a.level ?? 1) > (b.level ?? 1) ? a : b)
    }

    // Swarm/skeleton — mindless, random
    case 'swarm':
    case 'skeleton':
    case 'unknown':
    default:
      return targets[dice.d(targets.length) - 1]!
  }
}

export function runEnemyFreeAttackRound(game: RpgGameState, dice: Dice): string[] {
  const lines: string[] = []
  const livingEnemies = (game.combat?.enemies ?? []).filter((enemy) => (enemy?.hp ?? 0) > 0)
  for (const enemy of livingEnemies) {
    if (game.phase !== 'playing') break
    const targets = livingParty(game.party)
    if (targets.length === 0) break
    const target = selectTarget(enemy, targets, dice)

    const attackSkill = clampSkill(Number(enemy.attack))
    const attackRoll = resolveSkillCheck({ skill: attackSkill, dice })
    const dodgeRoll = resolveSkillCheck({ skill: target.skills.dodge, dice })
    const attackMargin = attackRoll.success ? attackSkill - attackRoll.roll : Number.NEGATIVE_INFINITY
    const dodgeMargin = dodgeRoll.success ? target.skills.dodge - dodgeRoll.roll : Number.NEGATIVE_INFINITY
    const hit = attackRoll.success && (!dodgeRoll.success || attackMargin > dodgeMargin)

    if (hit) {
      const damage = Math.max(1, dice.d(6))
      target.hp = Math.max(0, target.hp - damage)
      const tacticsHint = (enemy.tactics?.kind && enemy.tactics.kind !== 'unknown')
        ? ` [${enemy.tactics.kind} tactics]` : ''
      lines.push(`${enemy.name}${tacticsHint} strikes ${target.name} for ${damage}! (HP ${target.hp}/${target.maxHp})`)
      partyWipe(game)
      markCharacterDeath(game, target, deathCauseFromAttacker(game, enemy.name))
    } else {
      lines.push(`${enemy.name} swings at ${target.name} but misses.`)
    }
  }
  return lines
}

export const combatSystem: CombatSystem = {
  resolveCombatAttack,
  resolveEnemyRound: runEnemyFreeAttackRound,
}
