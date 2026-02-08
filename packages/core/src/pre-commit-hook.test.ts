import { existsSync, readFileSync } from "node:fs"
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
})

