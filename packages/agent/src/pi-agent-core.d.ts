// Optional dependency: only required when using the default Pi agent factory.
// Keeping this as an ambient module declaration lets `tsc --noEmit` succeed
// without forcing consumers of `@atproto-agent/agent` to install it.
declare module '@mariozechner/pi-agent-core' {
  export const Agent: unknown
}

