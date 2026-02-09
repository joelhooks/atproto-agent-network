import { registerEnvironment } from './registry'
import { catanEnvironment } from './catan'
import { rpgEnvironment } from './rpg'

let registered = false

export function registerBuiltInEnvironments(): void {
  if (registered) return
  registerEnvironment(catanEnvironment)
  registerEnvironment(rpgEnvironment)
  registered = true
}

// Register on import so the agent runtime sees built-ins by default.
registerBuiltInEnvironments()
