// Optional dependency: only required when using the default Pi agent factory.
// This ambient module declaration keeps `tsc --noEmit` happy while the
// Cloudflare worker imports `@atproto-agent/agent` source directly.
declare module '@mariozechner/pi-agent-core' {
  export const Agent: unknown
}

