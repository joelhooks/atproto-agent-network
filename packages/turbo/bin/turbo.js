#!/usr/bin/env node

const path = require("node:path")
const { spawnSync } = require("node:child_process")

const args = process.argv.slice(2)

const hasFlag = (flag) => args.includes(flag)
const command = args.find((arg) => !arg.startsWith('-'))

const repoRoot = path.resolve(__dirname, "..", "..", "..")

const collectFilters = (argv) => {
  const filters = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--filter") {
      const value = argv[i + 1]
      if (value) {
        filters.push(value)
        i += 1
      }
      continue
    }
    if (arg.startsWith("--filter=")) {
      const value = arg.slice("--filter=".length)
      if (value) {
        filters.push(value)
      }
    }
  }
  return filters
}

if (hasFlag('--help') || hasFlag('-h') || !command) {
  console.log('turbo (stub)')
  console.log('This repository uses a local stub for offline installs.')
  console.log('Supported: `turbo <command> --dry-run`, `--version`')
  process.exit(0)
}

if (hasFlag('--version') || hasFlag('-v')) {
  console.log('0.0.0-stub')
  process.exit(0)
}

if (hasFlag('--dry-run')) {
  console.log(`turbo (stub): ${command} --dry-run ok`)
  process.exit(0)
}

if (command === "test") {
  const filters = collectFilters(args)
  const pnpmArgs = ["-r", "-C", repoRoot]
  for (const filter of filters) {
    pnpmArgs.push("--filter", filter)
  }
  pnpmArgs.push("test")
  const result = spawnSync("pnpm", pnpmArgs, { stdio: "inherit" })
  process.exit(result.status ?? 1)
}

console.log(`turbo (stub): ${command} (no-op)`)
process.exit(0)
