#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const binDir = path.dirname(fileURLToPath(import.meta.url))
const vitestMjs = path.resolve(binDir, "..", "vitest.mjs")

const result = spawnSync(process.execPath, [vitestMjs, ...process.argv.slice(2)], {
  stdio: "inherit",
})

process.exit(result.status ?? 1)

