#!/usr/bin/env bun

type CliDeps = {
  fetch: typeof fetch
  stdout: (line: string) => void
  stderr: (line: string) => void
  env: Record<string, string | undefined>
}

const DEFAULT_API = 'https://agent-network.joelhooks.workers.dev'

function buildHeaders(token: string | undefined): HeadersInit {
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

async function fetchJson(
  path: string,
  deps: CliDeps,
  token: string | undefined,
  method: 'GET' | 'PUT' = 'GET',
  body?: unknown
): Promise<unknown> {
  const response = await deps.fetch(`${path}`, {
    method,
    headers: {
      ...buildHeaders(token),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ''}`)
  }

  return response.json().catch(() => ({}))
}

function printHelp(stdout: (line: string) => void) {
  stdout('anet commands:')
  stdout('  sandbox         List sandbox leases (active + audit trail)')
  stdout('  sandbox costs   Show sandbox cost breakdown by agent')
}

function formatHours(hours: unknown): string {
  const numeric = typeof hours === 'number' ? hours : Number(hours)
  if (!Number.isFinite(numeric)) return '0.0000'
  return numeric.toFixed(4)
}

function formatCost(cost: unknown): string {
  const numeric = typeof cost === 'number' ? cost : Number(cost)
  if (!Number.isFinite(numeric)) return '0.0000'
  return numeric.toFixed(4)
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const command = argv[0]
  if (!command) {
    printHelp(deps.stdout)
    return 0
  }

  const apiBase = deps.env.ANET_API ?? deps.env.AGENT_NETWORK_API ?? DEFAULT_API
  const token = deps.env.ANET_TOKEN ?? deps.env.ADMIN_TOKEN

  try {
    if (command === 'sandbox') {
      const sub = argv[1]
      if (sub === 'costs') {
        const payload = (await fetchJson(`${apiBase}/admin/sandbox/costs`, deps, token)) as {
          agents?: Array<{ name: string; activeHours: number; estimatedCost: number }>
          total?: { hours: number; cost: number }
        }
        const agents = Array.isArray(payload.agents) ? payload.agents : []
        deps.stdout('agent\tactiveHours\testimatedCost')
        for (const agent of agents) {
          deps.stdout(`${agent.name}\t${formatHours(agent.activeHours)}\t${formatCost(agent.estimatedCost)}`)
        }
        const total = payload.total ?? { hours: 0, cost: 0 }
        deps.stdout(`total\t${formatHours(total.hours)}\t${formatCost(total.cost)}`)
        return 0
      }

      const payload = (await fetchJson(`${apiBase}/admin/sandbox/leases`, deps, token)) as {
        leases?: Array<{
          id: string
          agentName: string
          environmentType: string
          status: string
          uptimeHours?: number
        }>
      }
      const leases = Array.isArray(payload.leases) ? payload.leases : []
      deps.stdout('id\tagent\tenvironment\tstatus\tuptimeHours')
      for (const lease of leases) {
        deps.stdout(
          `${lease.id}\t${lease.agentName ?? ''}\t${lease.environmentType ?? ''}\t${lease.status ?? ''}\t${formatHours(
            lease.uptimeHours
          )}`
        )
      }
      return 0
    }

    printHelp(deps.stdout)
    return 0
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

const runtime = globalThis as typeof globalThis & {
  process?: {
    argv?: string[]
    env?: Record<string, string | undefined>
    exit?: (code: number) => never
  }
}

const argv1 = runtime.process?.argv?.[1] ?? ''
const shouldRunCli =
  argv1.endsWith('/anet') ||
  argv1.endsWith('/zap') ||
  /[/\\]dist[/\\]index\.(cjs|mjs|js)$/.test(argv1)

if (shouldRunCli && runtime.process?.argv && runtime.process.exit) {
  const code = await runCli(runtime.process.argv.slice(2), {
    fetch,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    env: runtime.process.env ?? {},
  })
  runtime.process.exit(code)
}
