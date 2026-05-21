import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const vitestPath = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs")

if (!existsSync(vitestPath)) {
  console.error(
    "Vitest is not installed. Run pnpm install --frozen-lockfile before running pnpm test.",
  )
  process.exit(1)
}

const args = process.argv.slice(2)
const forwarded = []
const projects = []

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === "--filter") {
    const value = args[i + 1]
    if (value) {
      projects.push(value)
      i += 1
      continue
    }
  }

  if (arg.startsWith("--filter=")) {
    const value = arg.slice("--filter=".length)
    if (value) {
      projects.push(value)
    }
    continue
  }

  forwarded.push(arg)
}

const hasProjectArg = forwarded.some((arg) => arg === "--project" || arg.startsWith("--project="))
if (!hasProjectArg) {
  for (const project of projects) {
    forwarded.push("--project", project)
  }
}

const result = spawnSync(process.execPath, [vitestPath, ...forwarded], {
  stdio: "inherit",
})

if (result.error) {
  console.error(`Failed to start Vitest: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
