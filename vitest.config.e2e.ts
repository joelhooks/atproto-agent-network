import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "e2e",
    globals: true,
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: ["scripts/e2e/globalSetup.ts"],
    include: [
      "apps/*/src/**/*.e2e.test.ts",
      "packages/*/src/**/*.e2e.test.ts",
    ],
  },
})
