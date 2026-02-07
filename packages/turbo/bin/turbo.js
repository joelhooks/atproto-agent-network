#!/usr/bin/env node

const args = process.argv.slice(2)

const hasFlag = (flag) => args.includes(flag)
const command = args.find((arg) => !arg.startsWith('-'))

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

console.log(`turbo (stub): ${command} (no-op)`)
process.exit(0)
