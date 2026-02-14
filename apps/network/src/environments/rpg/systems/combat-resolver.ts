import type {
  Character,
  Dice,
  Enemy,
  RpgGameState,
} from '../../../games/rpg-engine'
import {
  livingParty,
  markCharacterDeath,
  partyWipe,
  resolveSkillCheck,
} from '../../../games/rpg-engine'

export type CombatAttackResult = {
  hit: boolean
  text: string
  damage: number
  killed: boolean
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
    return { hit: false, text, damage: 0, killed: false }
  }

  const hpBefore = enemy.hp
  const damage = dice.d(6) + Math.floor(attacker.stats.STR / 25)
  enemy.hp = Math.max(0, enemy.hp - damage)
  attacker.skills.attack = attackRoll.nextSkill

  const text = `You strike the ${enemy.name} for ${damage}. (${enemy.hp} HP left)`
  game.log ??= []
  game.log.push({ at: now(), who: attackerId, what: `attack: hit ${enemy.name} for ${damage} (${enemy.hp} HP left)` })

  return {
    hit: true,
    text,
    damage,
    killed: hpBefore > 0 && enemy.hp === 0,
  }
}

export function runEnemyFreeAttackRound(game: RpgGameState, dice: Dice): string[] {
  const lines: string[] = []
  const livingEnemies = (game.combat?.enemies ?? []).filter((enemy) => (enemy?.hp ?? 0) > 0)
  for (const enemy of livingEnemies) {
    if (game.phase !== 'playing') break
    const targets = livingParty(game.party)
    if (targets.length === 0) break
    const target = targets[dice.d(targets.length) - 1]!

    const attackSkill = clampSkill(Number(enemy.attack))
    const attackRoll = resolveSkillCheck({ skill: attackSkill, dice })
    const dodgeRoll = resolveSkillCheck({ skill: target.skills.dodge, dice })
    const attackMargin = attackRoll.success ? attackSkill - attackRoll.roll : Number.NEGATIVE_INFINITY
    const dodgeMargin = dodgeRoll.success ? target.skills.dodge - dodgeRoll.roll : Number.NEGATIVE_INFINITY
    const hit = attackRoll.success && (!dodgeRoll.success || attackMargin > dodgeMargin)

    if (hit) {
      const damage = Math.max(1, dice.d(6))
      target.hp = Math.max(0, target.hp - damage)
      lines.push(`${enemy.name} strikes ${target.name} for ${damage}! (HP ${target.hp}/${target.maxHp})`)
      partyWipe(game)
      markCharacterDeath(game, target, deathCauseFromAttacker(game, enemy.name))
    } else {
      lines.push(`${enemy.name} swings at ${target.name} but misses.`)
    }
  }
  return lines
}
