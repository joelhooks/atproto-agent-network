export type Faction = { id: string; name: string; disposition: number; description: string }
export type PlotPoint = { id: string; description: string; resolved: boolean; adventureId?: string }
export type StoryArc = { id: string; name: string; status: 'seeded'|'active'|'climax'|'resolved'|'failed'; plotPoints: PlotPoint[] }
export type WorldState = { factions: Faction[]; locations: Array<{id: string; name: string; description: string}>; events: string[] }
export type CampaignState = { id: string; name: string; premise: string; worldState: WorldState; storyArcs: StoryArc[]; adventureCount: number }

export async function createCampaign(db: D1Database, name: string, premise: string): Promise<CampaignState> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const campaign: CampaignState = {
    id,
    name,
    premise,
    worldState: { factions: [], locations: [], events: [] },
    storyArcs: [],
    adventureCount: 0,
  }

  await db
    .prepare('INSERT INTO campaigns (id, name, premise, world_state, story_arcs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(
      id,
      name,
      premise,
      JSON.stringify(campaign.worldState),
      JSON.stringify(campaign.storyArcs),
      now,
      now
    )
    .run()

  return campaign
}

export async function getCampaign(db: D1Database, id: string): Promise<CampaignState | null> {
  const row = await db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first()
  if (!row) return null

  return {
    id: row.id as string,
    name: row.name as string,
    premise: row.premise as string,
    worldState: JSON.parse(row.world_state as string),
    storyArcs: JSON.parse(row.story_arcs as string),
    adventureCount: 0,
  }
}

export async function updateCampaign(
  db: D1Database,
  id: string,
  patch: Partial<Pick<CampaignState, 'premise'|'worldState'|'storyArcs'>>
): Promise<void> {
  const sets: string[] = []
  const vals: any[] = []

  if (patch.premise !== undefined) {
    sets.push('premise = ?')
    vals.push(patch.premise)
  }
  if (patch.worldState !== undefined) {
    sets.push('world_state = ?')
    vals.push(JSON.stringify(patch.worldState))
  }
  if (patch.storyArcs !== undefined) {
    sets.push('story_arcs = ?')
    vals.push(JSON.stringify(patch.storyArcs))
  }

  sets.push('updated_at = ?')
  vals.push(new Date().toISOString())
  vals.push(id)

  await db.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run()
}
