import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "@atproto-agent/cli",
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})

