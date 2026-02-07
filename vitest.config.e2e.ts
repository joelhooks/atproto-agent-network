import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "e2e",
    globals: true,
    environment: "node",
    include: [
      "apps/*/src/**/*.e2e.test.ts",
      "packages/*/src/**/*.e2e.test.ts",
    ],
  },
})
