import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

function parseWranglerVars(toml: string): Record<string, string> {
  const lines = toml.split(/\r?\n/)
  const vars: Record<string, string> = {}

  const start = lines.findIndex((l) => l.trim() === '[vars]')
  if (start === -1) return vars

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('[')) break

    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/)
    if (!match) continue

    const key = match[1]!
    let raw = match[2]!.trim()

    // Strip trailing comments.
    const hashIdx = raw.indexOf('#')
    if (hashIdx >= 0) raw = raw.slice(0, hashIdx).trim()

    // Handle TOML basic strings and bare numbers.
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1)
    vars[key] = raw
  }

  return vars
}

function embeddingDimensionsForModel(model: string): number | null {
  // Keep this map in sync with any embedding model changes.
  const dims: Record<string, number> = {
    '@cf/baai/bge-base-en-v1.5': 768,
    '@cf/baai/bge-large-en-v1.5': 1024,
  }
  return dims[model] ?? null
}

describe('Vectorize embedding dimensions', () => {
  it('embedding model dimensions match VECTORIZE_DIMENSIONS in wrangler.toml', () => {
    const wranglerPath = fileURLToPath(new URL('../wrangler.toml', import.meta.url))
    const toml = readFileSync(wranglerPath, 'utf8')
    const vars = parseWranglerVars(toml)

    expect(vars.EMBEDDING_MODEL).toBeTruthy()
    expect(vars.VECTORIZE_DIMENSIONS).toBeTruthy()

    const dims = Number(vars.VECTORIZE_DIMENSIONS)
    expect(Number.isFinite(dims)).toBe(true)

    const modelDims = embeddingDimensionsForModel(vars.EMBEDDING_MODEL)
    expect(modelDims).toBe(dims)
  })
})
