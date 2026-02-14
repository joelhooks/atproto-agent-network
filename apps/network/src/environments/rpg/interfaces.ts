import type { PersistentCharacter } from '@atproto-agent/core'

import type {
  CampaignPartyMemberSeed,
  CampaignState,
  Character,
  Dice,
  Enemy,
  HubTownLocation,
  HubTownState,
  RpgGameState,
  StoryArc,
  WorldState,
} from '../../games/rpg-engine'
import type { EnvironmentContext, ToolCall } from '../types'

export type GamePhase = RpgGameState['phase']

export type GameStateRow = {
  id: string
  type: string
  hostAgent: string
  phase: GamePhase | string
  players: string[]
  winner: string | null
  game: RpgGameState
  createdAt: string
  updatedAt: string
}

export type GameCreateMeta = {
  hostAgent: string
  players: string[]
  type?: 'rpg'
  phase?: GamePhase
}

export type CampaignPatch = Partial<Pick<CampaignState, 'name' | 'premise' | 'worldState' | 'storyArcs' | 'adventureCount'>>

export type CreateCampaignOptions = {
  theme?: string
  party?: CampaignPartyMemberSeed[]
  worldState?: WorldState
  storyArcs?: StoryArc[]
}

export interface GameStateRepository {
  findActiveForAgent(agentName: string): Promise<GameStateRow | null>
  findWhereItsMyTurn(agentName: string): Promise<GameStateRow | null>
  findJoinable(exclude: string, limit?: number): Promise<GameStateRow[]>
  load(gameId: string): Promise<RpgGameState>
  save(gameId: string, game: RpgGameState): Promise<void>
  create(gameId: string, game: RpgGameState, meta: GameCreateMeta): Promise<void>
  anyActiveExist(): Promise<boolean>
  countFinishedToday(referenceDate?: Date): Promise<number>
}

export interface CampaignRepository {
  get(id: string): Promise<CampaignState | null>
  create(name: string, premise: string, options?: CreateCampaignOptions): Promise<CampaignState>
  update(id: string, patch: CampaignPatch): Promise<void>
  linkAdventure(envId: string, campaignId: string): Promise<number>
  findLatest(): Promise<{ id: string } | null>
}

export interface CharacterRepository {
  load(): Promise<PersistentCharacter | null>
  save(character: PersistentCharacter): Promise<void>
}

export interface CommandHandler {
  readonly name: string
  readonly validPhases: GamePhase[]
  readonly requiresTurn: boolean
  execute(input: CommandInput): Promise<CommandResult>
}

export interface CommandInput {
  game: RpgGameState
  gameId: string
  params: Record<string, unknown>
  agentName: string
  dice: Dice
  repos: {
    game: GameStateRepository
    campaign: CampaignRepository
    character: CharacterRepository
  }
  broadcast: (event: Record<string, unknown>) => Promise<void>
}

export interface CommandResult {
  content: Array<{ type: 'text'; text: string }>
  details?: Record<string, unknown>
  saved?: boolean
}

export type AttackResult = {
  ok: boolean
  hit?: boolean
  detail?: string
  [key: string]: unknown
}

export type FleeResult = {
  ok: boolean
  escaped?: boolean
  detail?: string
  [key: string]: unknown
}

export type NegotiateResult = {
  ok: boolean
  success?: boolean
  detail?: string
  [key: string]: unknown
}

export interface TurnManager {
  advance(game: RpgGameState): void
  normalize(game: RpgGameState): boolean
  computeInitiative(party: Character[]): Character[]
}

export interface CombatResolver {
  resolveAttack(attacker: Character, target: Enemy, dice: Dice): AttackResult
  resolveEnemyRound(game: RpgGameState, dice: Dice): string[]
  resolveFlee(game: RpgGameState, actor: Character, dice: Dice): FleeResult
  resolveNegotiate(game: RpgGameState, actor: Character, dice: Dice): NegotiateResult
}

export interface LootSystem {
  resolveTreasure(game: RpgGameState, actor: Character, dice: Dice): string
  maybeAwardDrop(game: RpgGameState, actor: Character, enemy: Enemy, dice: Dice): string | null
}

export interface XpSystem {
  awardKill(game: RpgGameState, who: string, enemy: Enemy): void
  awardRoomClear(game: RpgGameState): void
  addLogged(game: RpgGameState, who: string, amount: number, reason: string): void
}

export type HubTownVisitResult =
  | { ok: true; location: HubTownLocation }
  | { ok: false; error: string }

export type HubTownTradeResult =
  | { ok: true; itemId: string; gold: number }
  | { ok: false; error: string }

export type HubTownTransitionResult = {
  completed: boolean
  enteredHubTown: boolean
}

export type HubTownDowntimeResult = {
  hub: HubTownState
  shouldEmbark: boolean
  alreadyReady: boolean
}

export interface HubTownSystem {
  normalizeLocation(value: unknown): HubTownLocation | null
  ensureState(game: RpgGameState): HubTownState
  resetIdle(game: RpgGameState): void
  countIdleTurn(game: RpgGameState): number
  buildNarration(game: RpgGameState, input: { location: HubTownLocation; cue: string }): string
  visit(game: RpgGameState, input: { agentName: string; location: unknown }): HubTownVisitResult
  buy(game: RpgGameState, input: { agentName: string; itemId: unknown }): HubTownTradeResult
  sell(game: RpgGameState, input: { agentName: string; itemId: unknown }): HubTownTradeResult
  transitionCampaignCompletion(game: RpgGameState, beforePhase: RpgGameState['phase']): HubTownTransitionResult
  tickDowntime(game: RpgGameState): HubTownDowntimeResult
}

export interface ContextBuilder {
  build(ctx: EnvironmentContext, game: RpgGameState, gameId: string): Promise<string[]>
}

export interface AutoPlayStrategy {
  getActions(ctx: EnvironmentContext): Promise<ToolCall[]>
}

export interface GameEventEmitter {
  onEnvironmentCompleted(ctx: EnvironmentContext, gameId: string, game: RpgGameState): Promise<void>
  onTurnAdvanced(gameId: string, nextPlayer: string): Promise<void>
  onCombatStarted(gameId: string): Promise<void>
  onPhaseChanged(gameId: string, from: GamePhase, to: GamePhase): Promise<void>
}
