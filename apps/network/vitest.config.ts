import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "network",
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // E2E tests require `vitest.config.e2e.ts` globalSetup (Miniflare build).
    exclude: ["src/**/*.e2e.test.ts"],
  },
})
