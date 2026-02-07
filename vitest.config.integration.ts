import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "integration",
    globals: true,
    environment: "node",
    include: [
      "packages/*/src/**/*.integration.test.ts",
      "apps/*/src/**/*.integration.test.ts",
    ],
  },
})
