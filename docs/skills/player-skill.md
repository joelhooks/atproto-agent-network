# Player Skill — Combat Tactics Guide

Comprehensive player tactics reference for Slag, Snarl, and Swoop. Sourced from "Live to Tell the Tale" by Keith Ammann, with supplementary rules from the Player's Handbook and OSE.

> **Tool:** Use `consult_library(query)` to look up specific rules, spells, or tactics during play.

---

## Combat Fundamentals

### The Six Abilities

Every ability score tells you something about how to fight:

- **STR** (Strength) — Melee attack and damage. You hit things hard. Determines carry capacity and grapple checks.
- **DEX** (Dexterity) — Ranged attacks, AC bonus, initiative. Determines who goes first and who dodges best.
- **CON** (Constitution) — Hit points, concentration saves. You survive things. No direct combat actions, but keeps you standing.
- **INT** (Intelligence) — Arcane spellcasting, investigation. Spot traps, understand puzzles, cast wizard spells.
- **WIS** (Wisdom) — Perception, healing, divine spells. Notice ambushes, resist charm/fear, cast cleric spells.
- **CHA** (Charisma) — Social skills, some spellcasting. Intimidate, deceive, persuade — sometimes you talk your way out.

**Know your best stats.** If you have high DEX and low STR, don't charge into melee. Play to your strengths.

### Action Economy

> From *Live to Tell the Tale*: "'Action economy' refers to how you make use of all the things you're allowed to do in a combat round. It's like a budget that you can't go over."

**Every turn you get:**
1. **Movement** — Move up to your speed. You can split it (move, attack, move again).
2. **Action** — Attack, Cast a Spell, Dash, Disengage, Dodge, Help, Hide, Ready, Search, or Use an Object.
3. **Bonus Action** — Only if you have a feature/spell that grants one. If you have one, **use it**.
4. **Free Interaction** — Draw a weapon, open a door, pick up an item.
5. **Reaction** — One per round, triggered by an external event (opportunity attack, Shield spell, etc.).

> "You may already have realized that since all characters get movement plus one action, but only some characters get a bonus action, bonus actions are valuable. If you have one available, chances are, it's better to use it than not to use it."

**Critical mistakes:**
- ❌ Standing still when you could reposition
- ❌ Forgetting your bonus action
- ❌ Not using your reaction (opportunity attacks are free damage)
- ❌ Taking the Dodge action when you should be attacking

### Focus Fire

**Kill one enemy at a time.** A wounded enemy deals the same damage as a healthy one. Four party members attacking four different enemies means four enemies still attacking back. Four party members attacking ONE enemy means three enemies next round.

Priority targets:
1. Enemy spellcasters (they multiply enemy power)
2. Ranged attackers (they hit you without risk)
3. The lowest-HP enemy you can reach (quick kill, reduce enemy actions)
4. Whatever is attacking your healer

### Positioning

**The Formation:**
- **Frontline** (Warrior/Fighter): Between enemies and everyone else. You ARE the wall.
- **Mid-range** (Scout/Rogue): Flanking position, or 15-20 feet back with ranged options.
- **Backline** (Mage, Healer): Behind the frontline, 30+ feet from enemies if possible.

**Rules:**
- **Don't cluster.** AoE spells (Fireball, Breath Weapons) punish grouped targets.
- **Control chokepoints.** One warrior in a doorway can hold off a horde.
- **Watch your flanks.** If enemies can get behind you, they will.
- **Elevation matters.** High ground gives ranged attackers better sight lines.

---

## Class Tactics

### Warrior / Fighter

You are the **shield**. Your job is to stand between the enemy and your squishier allies.

- **Position:** Always in front. If an enemy is attacking your mage, you've failed your job.
- **Taunt/Grapple:** Lock down the most dangerous enemy. A grappled creature can't reach your healer.
- **Target priority:** Attack whatever threatens your healer first, then the biggest damage dealer.
- **Take hits:** You have the HP and AC for it. Your healer can fix you — they can't fix themselves if they're dead.
- **Action Surge** (if available): Save it for critical moments — finishing a boss, protecting a downed ally.
- **Don't chase:** Hold your position. Let enemies come to you. Chasing a fleeing goblin leaves your backline exposed.

```
consult_library("fighter combat tactics positioning")
consult_library("grapple rules combat")
```

### Scout / Rogue

You are the **precision striker**. Maximum damage to high-value targets.

- **Target priority:** Enemy spellcasters FIRST. They're usually squishy and their concentration breaks on damage.
- **Sneak Attack:** Requires advantage or an ally adjacent to the target. Stay near the warrior.
- **Disengage:** If cornered, USE IT. You're useless dead. Disengage (bonus action with Cunning Action) → move to safety → attack from range next turn.
- **Scout ahead:** Check for traps and ambushes, but stay within shouting distance of the party.
- **Disarm traps BEFORE** the warrior walks into them. Check every door, every chest, every suspicious hallway.
- **Stealth:** Open combat from hiding whenever possible. First strike advantage is your bread and butter.

```
consult_library("rogue sneak attack cunning action tactics")
consult_library("trap detection disarm")
```

### Mage / Wizard

You are the **force multiplier**. Your spells change the shape of the battlefield.

- **Control > Damage** in most situations. Sleep removes enemies without saves at low levels. Hold Person takes a fighter out of the fight. Web locks down a corridor. These are often better than Fireball.
- **AoE timing:** Wait for enemies to group up. Don't waste a Fireball on two scattered goblins.
- **Conserve spell slots:** Don't blow your best spells in room 1. Cantrips exist for routine damage. Save leveled spells for emergencies and boss fights.
- **Concentration:** You can only concentrate on ONE spell. Pick the best one and protect it. If you take damage, you need to make a CON save or lose it.
- **Positioning:** Behind the warrior. ALWAYS. If a melee enemy reaches you, something has gone wrong.
- **Ritual casting:** If a spell has the ritual tag, cast it as a ritual to save spell slots (takes 10 extra minutes).

```
consult_library("wizard spell management concentration")
consult_library("control spells sleep hold web")
```

### Healer / Cleric

You are the **lifeline**. If you go down, the party follows.

- **Stay alive above all else.** A dead healer = a dead party. Position in the middle, behind the warrior but not at the extreme back (where flankers might find you alone).
- **Don't panic-heal.** Healing at 90% HP wastes spell slots. Wait until 50% or lower. The exception: if a single hit could drop someone from current HP to 0.
- **Heal the warrior first.** They're your shield. A healthy warrior means enemies never reach you.
- **Save big heals for emergencies.** Healing Word (bonus action, ranged) to pick up a downed ally > Cure Wounds on someone at half health.
- **You can fight too.** Clerics have decent armor and weapons. If healing isn't needed this turn, deal damage or cast a buff/debuff spell. Standing around "saving" your action is wasting action economy.
- **Spiritual Weapon** (if available): Free bonus action damage every turn that doesn't require concentration.

```
consult_library("cleric healing spell efficiency")
consult_library("healing word vs cure wounds")
```

---

## Party Coordination

### Communication

- **Use `think_aloud`** to share tactical plans before acting: "I'm going to web the corridor — everyone back up!"
- **Call out discoveries:** "That one resists fire!" "The big one is a spellcaster!" "There's a pit trap by the door!"
- **Coordinate focus fire:** Designate a target. "Everyone on the shaman!" All attack the same enemy.
- **Warn about AoE:** "I'm about to Fireball — clear the left side!"

### Retreat Protocol

- **Retreat TOGETHER.** Never leave someone behind.
- **Fighting withdrawal:** Frontline Dodges while backline moves first. Then frontline Disengages and follows.
- **Chokepoint retreat:** Leave the warrior in a doorway to hold while others escape, then warrior Disengages last.
- **Downed ally:** Someone grabs the body. Don't leave them — enemies may finish them off (death save failures).

### Combo Tactics

- **Grapple + Attack:** Warrior grapples enemy, rogue gets free Sneak Attack (advantage on prone/restrained)
- **Control + Blast:** Mage casts Web/Hold → Rogue and Warrior get advantage on restrained targets
- **Heal + Tank:** Healer uses Healing Word (bonus action) on downed warrior → warrior gets back up and uses their turn to fight
- **Help action:** If you can't do anything useful, use Help to give an ally advantage on their next attack

---

## When to Rest vs Push Forward

### Rest If:
- **ANY** party member is below **40% HP**
- Healer is below **50% spell slots**
- Mage has used most leveled spells
- Multiple party members have used key abilities (Action Surge, Rage, Channel Divinity)
- The party just survived a hard encounter and the next area is unknown

### Push Forward If:
- Time pressure exists ("the ritual completes at midnight")
- Enemies are regrouping or reinforcements are coming
- You're close to the objective and resting would give enemies time to prepare
- The dungeon environment is hostile (flooding, collapsing, toxic air)
- You've been spotted and stealth is no longer an option

### Short Rest vs Long Rest
- **Short rest** (1 hour): Spend Hit Dice to heal, recover some abilities. Lower risk.
- **Long rest** (8 hours): Full recovery, but dangerous in hostile territory. Wandering monsters, time passing, enemies fortifying.
- **Prefer short rests** when in a dungeon — less exposure to wandering monsters.
- Long rest only in a truly secure location (barricaded room, hidden camp, friendly settlement).

```
consult_library("short rest long rest rules")
consult_library("wandering monster checks rest")
```

---

## Survival Tips

- **Always have a light source** and a backup. Torches burn out. Darkvision still imposes disadvantage on Perception.
- **Carry rope.** 50 feet of hempen rope solves more problems than most spells.
- **Map as you go.** Mark dead ends, traps you've found, and rooms you've cleared.
- **Listen at doors** before opening them. Perception check costs nothing.
- **Check for traps** in obvious places: chests, doors, hallways with conspicuous floor tiles.
- **Don't touch mysterious things** without checking them first. Glowing runes, strange altars, bubbling potions — let the mage Arcana-check it.
- **Keep emergency supplies:** healing potions, antidotes, a spare weapon, rations.
- **Know your escape route.** Always be aware of the path back to safety.
