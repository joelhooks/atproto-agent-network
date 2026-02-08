import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'deploy.sh'
)

describe('scripts/deploy.sh', () => {
  it('exists and is executable', () => {
    expect(existsSync(scriptPath)).toBe(true)

    const mode = statSync(scriptPath).mode
    expect(mode & 0o111).not.toBe(0)
  })

  it('documents provisioning commands for D1 and R2', () => {
    const contents = readFileSync(scriptPath, 'utf8')
    expect(contents).toContain('d1 create')
    expect(contents).toContain('r2 bucket create')
  })
})

