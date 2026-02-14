import { attack, createDice, gmInterveneIfStuck, type Character, type Dice, type RpgGameState } from '../../../games/rpg-engine'
import { resolveCombatAttack, runEnemyFreeAttackRound } from '../systems/combat-resolver'
import { maybeAwardEnemyDrop } from '../systems/loot-system'
import { advanceTurn } from '../systems/turn-manager'
import { awardKillXp } from '../systems/xp-system'

function isCharacter(character: Character, identity: string): boolean {
  return character.agent === identity || character.name === identity
}

function summarizeParty(game: RpgGameState): string {
  return game.party
    .map((member) => {
      const agentTag = member.agent ? ` [${member.agent}]` : ''
      return `${member.name}(${member.klass})${agentTag} HP ${member.hp}/${member.maxHp} MP ${member.mp}/${member.maxMp}`
    })
    .join(' | ')
}

export function handleAttack(
  game: RpgGameState,
  agentName: string,
  params: any
): { message: string; game: RpgGameState } {
  const actingAgent = agentName.trim() || 'unknown'
  const dice: Dice = typeof params?.dice?.d === 'function' && typeof params?.dice?.d100 === 'function'
    ? params.dice
    : createDice()

  if (game.mode === 'combat' && game.combat?.enemies?.length) {
    const enemy = game.combat.enemies.find((candidate) => candidate.hp > 0)
    if (!enemy) {
      game.mode = 'exploring'
      game.combat = undefined
    } else {
      const attacker = game.party.find((member) => isCharacter(member, actingAgent))
      if (!attacker) throw new Error('Create your character before attacking')

      const attackResult = resolveCombatAttack({
        game,
        attacker,
        attackerId: actingAgent,
        enemy,
        dice,
      })
      const lines: string[] = [attackResult.text]

      if (attackResult.killed) {
        awardKillXp(game, actingAgent, enemy)
        const dropLine = maybeAwardEnemyDrop(game, attacker, enemy, dice)
        if (dropLine) {
          lines.push(`Loot: ${dropLine}`)
        }
      }
      lines.push(...runEnemyFreeAttackRound(game, dice))
      let text = lines.filter(Boolean).join('\n')

      if (game.phase === 'playing' && game.combat?.enemies?.every((candidate) => candidate.hp <= 0)) {
        game.mode = 'exploring'
        game.combat = undefined
        text += '\nCombat ends.'
      }

      gmInterveneIfStuck(game, {
        player: actingAgent,
        action: 'attack',
        target: `enemy:${enemy.name}`,
      })

      advanceTurn(game)

      return { message: `${text}\n\nParty: ${summarizeParty(game)}`, game }
    }
  }

  const defender = typeof params.defender === 'string' ? params.defender.trim() : ''
  if (!defender) throw new Error('defender required when not in combat')

  const result = attack(game, { attacker: actingAgent, defender, dice })

  gmInterveneIfStuck(game, {
    player: actingAgent,
    action: 'attack',
    target: `party:${defender}`,
  })

  advanceTurn(game)

  return {
    message: `${result.detail}.\nParty: ${summarizeParty(game)}`,
    game,
  }
}
