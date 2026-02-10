import { registerEnvironment } from './registry'
import { catanEnvironment } from './catan'
import { rpgEnvironment } from './rpg'
import { ralphEnvironment } from './ralph'
import { observeEnvironment } from './observe'

let registered = false

export function registerBuiltInEnvironments(): void {
  if (registered) return
  registerEnvironment(catanEnvironment)
  registerEnvironment(rpgEnvironment)
  registerEnvironment(ralphEnvironment)
  registerEnvironment(observeEnvironment)
  registered = true
}

// Register on import so the agent runtime sees built-ins by default.
registerBuiltInEnvironments()
