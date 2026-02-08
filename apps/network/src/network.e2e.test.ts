import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { adminAuthHeaders, createNetworkE2EContext, type NetworkE2EContext } from "../../../scripts/e2e/miniflare"

describe("network worker (miniflare e2e)", () => {
  let ctx: NetworkE2EContext | undefined

  beforeAll(async () => {
    ctx = await createNetworkE2EContext()
  })

  afterAll(async () => {
    await ctx?.dispose()
  })

  it("serves the network well-known endpoint when authorized", async () => {
    const res = await ctx.fetch("/.well-known/agent-network.json", {
      headers: adminAuthHeaders(ctx.adminToken),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        version: "0.0.1",
      })
    )
  })

  it("stores and retrieves an encrypted memory record via AgentDO routing", async () => {
    const agentName = "alice"

    const identityRes = await ctx.fetch(`/agents/${agentName}/identity`, {
      headers: adminAuthHeaders(ctx.adminToken),
    })

    expect(identityRes.status).toBe(200)
    const identity = (await identityRes.json()) as {
      did: string
      publicKeys: { encryption: string; signing: string }
    }
    expect(identity.did).toMatch(/^did:cf:/)
    expect(identity.publicKeys.encryption).toMatch(/^z/)
    expect(identity.publicKeys.signing).toMatch(/^z/)

    const createdAt = new Date().toISOString()
    const record = {
      $type: "agent.memory.note" as const,
      summary: "E2E note",
      text: "hello from miniflare",
      createdAt,
    }

    const storeRes = await ctx.fetch(`/agents/${agentName}/memory`, {
      method: "POST",
      headers: {
        ...adminAuthHeaders(ctx.adminToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(record),
    })

    expect(storeRes.status).toBe(200)
    const storeBody = (await storeRes.json()) as { id: string }
    expect(storeBody.id).toContain("/agent.memory.note/")

    const getRes = await ctx.fetch(
      `/agents/${agentName}/memory?id=${encodeURIComponent(storeBody.id)}`,
      {
        headers: adminAuthHeaders(ctx.adminToken),
      }
    )

    expect(getRes.status).toBe(200)
    const getBody = (await getRes.json()) as { id: string; record: unknown }
    expect(getBody.id).toBe(storeBody.id)
    expect(getBody.record).toEqual(record)
  })
})
