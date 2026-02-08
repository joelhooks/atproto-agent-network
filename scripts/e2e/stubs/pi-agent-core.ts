// Stub for optional Pi dependency when bundling Workers for Miniflare E2E.
//
// The production runtime supplies a real agentFactory and/or bundles the
// dependency. For E2E we only need the module to exist so Miniflare can resolve
// the dynamic import.

export class Agent {
  constructor() {
    throw new Error(
      "Pi agent core is not available in the E2E bundle. Provide PI_AGENT_FACTORY in env if needed."
    )
  }
}

