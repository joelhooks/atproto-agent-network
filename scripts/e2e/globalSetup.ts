import { build } from "esbuild"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"

const repoRoot = process.cwd()

const OUTDIR = path.join(repoRoot, "dist", "e2e")
const NETWORK_WORKER_ENTRY = path.join(repoRoot, "apps", "network", "src", "index.ts")
const NETWORK_WORKER_OUTFILE = path.join(OUTDIR, "network-worker.mjs")
const PI_AGENT_CORE_STUB = path.join(repoRoot, "scripts", "e2e", "stubs", "pi-agent-core.ts")

export default async function globalSetup(): Promise<void> {
  // Keep the output deterministic and avoid stale chunks after rebuilds.
  await rm(OUTDIR, { recursive: true, force: true })
  await mkdir(OUTDIR, { recursive: true })

  await build({
    entryPoints: {
      "network-worker": NETWORK_WORKER_ENTRY,
    },
    outdir: OUTDIR,
    bundle: true,
    format: "esm",
    splitting: true,
    platform: "neutral",
    target: "es2022",
    sourcemap: "inline",
    outExtension: {
      ".js": ".mjs",
    },
    logLevel: "silent",
    plugins: [
      {
        name: "e2e-stubs",
        setup: (build) => {
          build.onResolve(
            { filter: /^@mariozechner\/pi-agent-core$/ },
            () => ({
              path: PI_AGENT_CORE_STUB,
            })
          )
        },
      },
    ],
    // Cloudflare runtime built-ins that must remain unresolved.
    external: ["cloudflare:workers"],
  })

  process.env.E2E_NETWORK_WORKER_PATH = NETWORK_WORKER_OUTFILE
}
