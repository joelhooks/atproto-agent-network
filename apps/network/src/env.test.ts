import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function getIndexTsPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'index.ts')
}

function getExportedInterface(
  source: ts.SourceFile,
  name: string
): ts.InterfaceDeclaration | null {
  let found: ts.InterfaceDeclaration | null = null
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      found = node
    }
  })
  return found
}

function getInterfacePropertyMap(
  source: ts.SourceFile,
  iface: ts.InterfaceDeclaration
): Map<string, ts.PropertySignature> {
  const map = new Map<string, ts.PropertySignature>()
  for (const member of iface.members) {
    if (!ts.isPropertySignature(member)) continue
    if (!member.name) continue
    const name = member.name.getText(source)
    map.set(name, member)
  }
  return map
}

describe('Env interface', () => {
  it('declares all production bindings and secrets in apps/network/src/index.ts', () => {
    const indexPath = getIndexTsPath()
    const sourceText = readFileSync(indexPath, 'utf8')
    const source = ts.createSourceFile(indexPath, sourceText, ts.ScriptTarget.ESNext, true)

    const envIface = getExportedInterface(source, 'Env')
    expect(envIface).not.toBeNull()
    if (!envIface) return

    const props = getInterfacePropertyMap(source, envIface)

    const required: Array<[string, string]> = [
      ['AGENTS', 'DurableObjectNamespace'],
      ['RELAY', 'DurableObjectNamespace'],
      ['DB', 'D1Database'],
      ['BLOBS', 'R2Bucket'],
      ['VECTORIZE', 'VectorizeIndex'],
      ['MESSAGE_QUEUE', 'Queue'],
      ['AI', 'Ai'],
      ['CF_ACCOUNT_ID', 'string'],
      ['AI_GATEWAY_SLUG', 'string'],
      ['OPENROUTER_API_KEY', 'string'],
      ['OPENROUTER_MODEL_DEFAULT', 'string'],
      ['ADMIN_TOKEN', 'string'],
    ]

    for (const [name, typeText] of required) {
      const prop = props.get(name)
      expect(prop, `${name} should exist`).toBeDefined()
      if (!prop) continue

      expect(prop.questionToken, `${name} should be required`).toBeUndefined()
      expect(prop.type?.getText(source), `${name} should have type ${typeText}`).toBe(typeText)
    }

    const cors = props.get('CORS_ORIGIN')
    expect(cors, 'CORS_ORIGIN should exist').toBeDefined()
    expect(cors?.questionToken, 'CORS_ORIGIN should be optional').toBeDefined()
    expect(cors?.type?.getText(source), 'CORS_ORIGIN should have type string').toBe('string')
  })
})
