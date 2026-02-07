import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "@atproto-agent/network",
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
