# DM Skill — Dungeon Master Guide

Comprehensive Dungeon Master reference for Grimlock. Sourced from "The Monsters Know What They're Doing," "Game Angry," "Live to Tell the Tale," and the OSE Rules Tome.

> **Tool:** Use `consult_library(query)` to pull detailed tactics from the RPG library at any time during play.

---

## Encounter Design

### Core Principles

**Action Economy is King.** Every creature gets movement + action + (maybe) bonus action + reaction per turn. A single boss against a 4-player party means 4 turns vs 1 — the party will overwhelm it. Always add minions, environmental hazards, or legendary actions to balance the economy.

> From *The Monsters Know*: "Any creature that exists in the D&D game world will have evolved in accordance with this rule: It seeks to obtain the best possible result from whatever movement, actions, bonus actions, and reactions are available to it. If it can combine two of them for a superior outcome, it will."

**Monster Selection:**
- Match monsters to the dungeon's narrative — don't just pick by CR
- Consider the environment: aquatic monsters near water, burrowers in caves, flyers in open spaces
- Mix ranged and melee threats to force tactical decisions
- Include at least one monster with a special ability (spellcasting, grapple, fear) per major encounter

**Terrain Matters:**
- Difficult terrain slows melee rushers
- Elevation gives ranged attackers advantage
- Darkness benefits monsters with darkvision
- Narrow corridors negate flanking but also limit AoE
- Water, fire, pits — environmental hazards that act on initiative count 20

**Wound Thresholds** (from *Monsters Know*):
- **10% HP lost** → lightly wounded (no behavior change)
- **30% HP lost** → moderately wounded (may change tactics)
- **60% HP lost** → seriously wounded (most creatures flee)
- Exception: fanatics, undead, and constructs fight to the death

### Quick Reference
```
consult_library("how do [monster type] fight tactically")
consult_library("encounter design action economy")
consult_library("terrain hazards combat")
```

---

## Dungeon Pacing

### The 5-Room Dungeon Structure

A reliable framework for any dungeon, from a quick cave to a sprawling fortress:

1. **Entrance / Guardian** — Sets the tone. A combat encounter or obstacle that establishes the dungeon's danger level. Not the hardest fight — just enough to cost some resources and signal what's ahead.

2. **Puzzle / Roleplay** — A non-combat challenge. Could be a locked mechanism, an NPC negotiation, a riddle, or an environmental puzzle. Gives non-combat characters a chance to shine.

3. **Trick / Setback** — Something that complicates the plan. A trap that separates the party, a betrayal, a collapsing floor, or a resource drain (poison, curse, stolen gear). Raises tension.

4. **Climax / Boss** — The main event. The hardest encounter, combining combat with environmental elements. This should feel earned — everything before it builds to this moment.

5. **Reward / Revelation** — Treasure, information, or story advancement. The payoff. Can also set up the next adventure with a hook or cliffhanger.

### Tension Pacing

Alternate encounter types to prevent fatigue:
- **Combat → Exploration → Puzzle → Combat** (don't stack 3 fights in a row)
- After a hard fight, give a breather room (treasure, safe zone, NPC interaction)
- Before the climax, increase tension: sounds getting louder, signs of the boss, environmental decay
- **Escalation**: each room should feel harder or more dangerous than the last

### Rest Management
- Short rests between major encounters (1 hour in-game)
- Long rests only in truly safe locations — dungeons are hostile; wandering monsters interrupt rest
- Use time pressure to prevent rest-spamming: "the ritual completes at dawn," "the prisoners are being moved tonight"

---

## Monster Tactics Reference

> Source: *The Monsters Know What They're Doing* by Keith Ammann

### Humanoids

**Goblins** — Sneaky ambushers. High Dexterity, Nimble Escape (Disengage or Hide as bonus action).
> "A typical goblin combat turn goes Shortbow (action), move, Hide (bonus action). Because they attack from hiding, they roll with advantage. Regardless of whether they hit or miss, the attack gives their position away, so they change it immediately."
- Attack from darkness (darkvision advantage)
- Stay 40-80 feet from targets
- Use alarms and traps in their lairs
- Try to goad PCs into splitting up
- Flee at 1-2 HP, get desperate at 3-4 HP

**Orcs** — Brute-force chargers. Aggressive trait (bonus action to move full speed toward hostile creature).
> "Orcs are brutes. They charge, they fight hand-to-hand, and they retreat only with the greatest reluctance when seriously wounded. Being fanatical valuers of physical courage, orcs — unlike most creatures — are willing to fight to the death."
- First contact at 30-60 feet, then Aggressive charge + greataxe attack
- Brief parley possible (Intimidation skill) but hostile by default
- Slugfest once engaged — no clever tactics, just relentless aggression
- May respond to Intimidation checks (DC 20) if outmatched

**Kobolds** — Weak individually, dangerous in packs. Pack Tactics (advantage when ally is adjacent).
- Always attack in groups — never send one kobold alone
- Use traps extensively in their warrens
- Avoid bright sunlight (Sunlight Sensitivity)
- Flee when pack tactics stop working (allies drop)
- Winged kobolds sustain ranged harassment longer

**Bandits / Thugs** — Pragmatic fighters with self-preservation.
- Target vulnerable-looking party members first
- Demand surrender or tolls before fighting
- Flee when the fight turns against them
- Use terrain and numbers advantage

### Undead

**Skeletons** — Mindless soldiers, follow orders literally.
- No self-preservation, no morale checks
- Attack the nearest target unless commanded otherwise
- Vulnerable to bludgeoning damage
- Can be redirected by whoever controls them

**Zombies** — Relentless, slow, durable (Undead Fortitude).
- Always lose initiative (no roll)
- Absorb hits — they exist to waste the party's actions
- Undead Fortitude means they may not drop when they should
- Block corridors and doorways effectively

**Wights / Wraiths** — Intelligent undead with drain abilities.
- Life Drain targets low-CON characters
- Wraiths pass through walls — use hit-and-run through solid objects
- Create spawn from kills — escalating threat
- Intelligent enough to target healers and spellcasters

### Beasts

**Wolves** — Pack Tactics, knock prone on hit (STR save).
- Always in packs — isolated wolf flees
- Knock prone → pack gets advantage on prone target
- Territorial — may not pursue beyond their range
- Alpha wolf targets the most threatening PC

**Bears** — Multiattack (claw/claw/bite), territorial.
- Charge and maul — straightforward aggression
- Fight to defend cubs or territory, otherwise avoid conflict
- High HP makes them damage sponges

**Giant Spiders** — Web, stealth, ambush from above.
- Web to restrain, then bite poisoned targets
- Attack from ceilings and dark corners
- Flee if seriously wounded (they're patient predators)

### Aberrations

**Mind Flayers** — Genius-level intelligence, Mind Blast (stun cone), Extract Brain.
- Open with Mind Blast to stun as many PCs as possible
- Target stunned PCs for brain extraction (instant kill)
- Prioritize spellcasters (biggest threat to their concentration)
- Use thralls as meat shields
- Plane Shift to escape if seriously threatened

**Beholders** — Paranoid, genius tacticians. Anti-Magic Cone + eye rays.
- Anti-Magic Cone shuts down one direction — face it toward casters
- Eye rays target different PCs to divide attention
- Central eye + eye rays = different arcs of coverage
- Lair full of traps, vertical spaces, anti-intruder measures
- Never fight fair — ambush from prepared positions

### Constructs

**Golems / Animated Objects** — Follow orders literally, immune to most magic.
- No tactics — they execute their instructions mechanically
- Immune to many spells (check specific immunities)
- Won't pursue beyond their guard area unless ordered
- Target the nearest intruder unless given specific orders

### Dragons

> "Adult dragons are where things get most interesting, because they're considered legendary creatures."

**Lair Actions** (initiative count 20):
- **Movement restrictors**: grasping tides, ceiling collapse, roots, tremors, ice walls
- **Direct damage**: swarming insects, arc lightning, thorny brush, magma, ice shards
- **Debilitators**: darkness, sandstorms, enchanting fog, volcanic gas, freezing fog

**Legendary Actions** (3/round, between other turns):
- Tail Attack (1 action) — 15-foot reach, hit adjacent PCs
- Wing Attack (2 actions) — hits all within 10 feet, knocks prone, repositions the dragon

**General Dragon Tactics:**
- Breath weapon on grouped PCs — always the priority when available
- Fly and strafe — don't let melee PCs lock you down
- Use lair actions to restrict movement, then breath weapon the clump
- Target the weakest party member to break morale
- Young dragons engage 2 melee opponents max, not 3
- Wyrmlings Dodge and reposition when outnumbered
- Pin targets down with lair actions → nail them with breath or Wing Attack
- Aim debilitating lair actions at PCs with the richest action economy (bonus actions, Extra Attack)

### Fiends

**Demons** — Chaotic berserkers, driven by destruction.
- No self-preservation — charge in and destroy
- Target the closest living thing
- Use summoning abilities to flood the battlefield
- Resistant to many damage types — force the party to adapt

**Devils** — Lawful, strategic manipulators.
- Use deception and negotiation before combat
- Target party cohesion — charm one PC, turn them against the group
- Retreat strategically to prepared positions
- Call in reinforcements with military precision

### Elementals

- Exploit their element: fire elementals ignite, water elementals drown, earth elementals grapple
- Resistant or immune to physical damage (check specific)
- Often tied to a location or summoner — won't pursue beyond range
- Use terrain that matches their element for advantage

---

## Random Tables

The OSE Rules Tome contains extensive encounter and treasure tables. Use `consult_library` to pull them:

### Dungeon Encounters
```
consult_library("dungeon encounter table level 1-3")
consult_library("dungeon encounter table level 4-5")
consult_library("dungeon encounter table level 6-7")
```

Example from OSE (Level 1):
> d20 results include: Acolyte (1d8), Bandit (1d8), Beetle Fire (1d8), Dwarf (1d6), Goblin (2d4), Kobold (4d4), Orc (2d4), Skeleton (3d4), Wolf (2d6)...

### Wilderness Encounters
```
consult_library("wilderness encounter table forest")
consult_library("wilderness encounter table desert")
consult_library("wilderness encounter table mountain")
```

### Treasure Generation
```
consult_library("treasure generation table")
consult_library("treasure type hoard")
consult_library("magic item table")
```

### Dungeon Design
```
consult_library("designing a dungeon setting structure")
consult_library("dungeon room contents table")
consult_library("trap ideas dungeon")
```

---

## Narration Tips

### Engage All Senses
Don't just describe what the party sees. Layer in:
- **Sound**: dripping water, distant growling, the scrape of claws on stone
- **Smell**: rotting flesh, damp earth, sulfur, old incense
- **Touch/Temperature**: cold draft from below, sticky webs across the doorframe, heat radiating from the walls
- **Taste**: metallic tang in the air (blood), dust settling on lips

### Describe Consequences Vividly
- ❌ "The orc takes 12 damage"
- ✅ "Your axe catches the orc across the ribs — it snarls, dark blood streaming down its side, but it doesn't slow down"

### NPC Personality
- Give each NPC one distinctive trait (voice, mannerism, motivation)
- Monsters aren't silent — goblins cackle and taunt, orcs roar challenges, undead moan
- Let monsters react to being wounded — show fear, rage, or desperation

### Build Tension
- Foreshadow danger: scratches on walls, abandoned equipment, warning signs
- Use pacing: slow exploration → sudden combat → quiet aftermath
- Countdown timers: "You hear the chanting getting louder. You have maybe three rooms before whatever they're summoning arrives."
- Show the consequences of failure in the environment: dead adventurers, collapsed rooms, corrupted areas
