import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

function repoRootFromHere(): string {
  // packages/core/src -> repo root
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, "../../..")
}

function hasUncommentedCommand(contents: string, command: string): boolean {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    if (trimmed === command || trimmed.startsWith(`${command} `)) return true
  }
  return false
}

describe("git hooks", () => {
  it("pre-commit runs lint, typecheck, and test", () => {
    const repoRoot = repoRootFromHere()
    const hookPath = path.join(repoRoot, ".husky", "pre-commit")
    expect(existsSync(hookPath)).toBe(true)

    const contents = readFileSync(hookPath, "utf8")
    expect(hasUncommentedCommand(contents, "pnpm lint")).toBe(true)
    expect(hasUncommentedCommand(contents, "pnpm typecheck")).toBe(true)
    expect(hasUncommentedCommand(contents, "pnpm test")).toBe(true)
  })

  it("root test script runs the Vitest wrapper without silent fallback", () => {
    const repoRoot = repoRootFromHere()
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
    const testScript = packageJson.scripts?.test

    expect(testScript).toBe("node ./scripts/vitest.mjs run --passWithNoTests")
    expect(testScript).not.toContain("command -v vitest")
    expect(testScript).not.toContain("echo PASS")
  })

  it("Vitest wrapper reports missing dependencies instead of passing", () => {
    const repoRoot = repoRootFromHere()
    const tempRepo = mkdtempSync(path.join(tmpdir(), "atproto-agent-network-vitest-"))

    try {
      const scriptsDir = path.join(tempRepo, "scripts")
      const wrapperPath = path.join(scriptsDir, "vitest.mjs")
      mkdirSync(scriptsDir, { recursive: true })
      copyFileSync(path.join(repoRoot, "scripts", "vitest.mjs"), wrapperPath)

      const result = spawnSync(
        process.execPath,
        [wrapperPath, "run", "--passWithNoTests"],
        { encoding: "utf8" },
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain("Vitest is not installed")
      expect(result.stderr).toContain("pnpm install --frozen-lockfile")
      expect(result.stdout).not.toContain("PASS")
    } finally {
      rmSync(tempRepo, { recursive: true, force: true })
    }
  })
})
