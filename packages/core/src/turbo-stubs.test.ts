import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

function repoRootFromHere(): string {
  // packages/core/src -> repo root
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, "../../..")
}

describe("turbo wiring", () => {
  it("does not vendor a stub workspace package named turbo", () => {
    const repoRoot = repoRootFromHere()
    const stubPkgJson = path.join(repoRoot, "packages", "turbo", "package.json")
    expect(existsSync(stubPkgJson)).toBe(false)
  })

  it("dashboard has a Vite entry (index.html) so `turbo build` works", () => {
    const repoRoot = repoRootFromHere()
    const dashboardEntry = path.join(repoRoot, "packages", "dashboard", "index.html")
    expect(existsSync(dashboardEntry)).toBe(true)
  })
})

