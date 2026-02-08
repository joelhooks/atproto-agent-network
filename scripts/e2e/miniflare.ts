import { Miniflare } from "miniflare"
import { readFile } from "node:fs/promises"
import path from "node:path"

function splitSqlStatements(sql: string): string[] {
  // Miniflare's D1 exec parser is strict: strip `--` comments and exec
  // statements one-by-one.
  return sql
    .replace(/^\uFEFF/, "")
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

export interface NetworkE2EContext {
  mf: Miniflare
  adminToken: string
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  dispose: () => Promise<void>
}

export function adminAuthHeaders(adminToken: string): HeadersInit {
  return { Authorization: `Bearer ${adminToken}` }
}

export async function createNetworkE2EContext(options: {
  adminToken?: string
} = {}): Promise<NetworkE2EContext> {
  const scriptPath = process.env.E2E_NETWORK_WORKER_PATH
  if (!scriptPath) {
    throw new Error("E2E_NETWORK_WORKER_PATH not set (did scripts/e2e/globalSetup.ts run?)")
  }

  const adminToken = options.adminToken ?? "e2e-admin-token"
  const baseUrl = "http://localhost"

  const mf = new Miniflare({
    scriptPath,
    modules: true,
    compatibilityDate: "2024-01-01",
    bindings: {
      ADMIN_TOKEN: adminToken,
      CORS_ORIGIN: "*",
    },
    durableObjects: {
      AGENTS: "AgentDO",
      RELAY: "RelayDO",
    },
    d1Databases: {
      DB: "DB",
    },
    r2Buckets: {
      BLOBS: "BLOBS",
    },
  })

  const schemaPath = path.join(process.cwd(), "apps", "network", "schema.sql")
  const schemaSql = await readFile(schemaPath, "utf8")
  const db = await mf.getD1Database("DB")
  for (const statement of splitSqlStatements(schemaSql)) {
    await db.exec(statement)
  }

  return {
    mf,
    adminToken,
    fetch: (pathname, init) => mf.dispatchFetch(`${baseUrl}${pathname}`, init),
    dispose: () => mf.dispose(),
  }
}
