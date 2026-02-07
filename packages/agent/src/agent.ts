/**
 * Pi agent wrapper for Cloudflare Durable Objects.
 */

export interface PiAgentMessage {
  role: string
  content?: string
  [key: string]: unknown
}

export type PiAgentTransformContext = (
  messages: PiAgentMessage[]
) => Promise<PiAgentMessage[]>

export interface PiAgentTool {
  name: string
  description?: string
  parameters?: unknown
  execute?: (...args: unknown[]) => unknown | Promise<unknown>
}

export interface PiAgentInit {
  initialState: {
    systemPrompt: string
    model: unknown
    tools?: PiAgentTool[]
  }
  transformContext?: PiAgentTransformContext
}

export interface PiAgentLike {
  prompt: (input: string, options?: Record<string, unknown>) => Promise<unknown>
  promptStream?: (
    input: string,
    options?: Record<string, unknown>
  ) => AsyncIterable<unknown>
}

export type PiAgentFactory = (init: PiAgentInit) => PiAgentLike | Promise<PiAgentLike>

export interface PiAgentWrapperOptions {
  systemPrompt: string
  model: unknown
  tools?: PiAgentTool[]
  transformContext?: PiAgentTransformContext
  agentFactory?: PiAgentFactory
}

export class PiAgentWrapper {
  private agent: PiAgentLike | null = null
  private initializing: Promise<PiAgentLike> | null = null
  private readonly options: PiAgentWrapperOptions

  constructor(options: PiAgentWrapperOptions) {
    this.options = options
  }

  get isInitialized(): boolean {
    return this.agent !== null
  }

  async initialize(): Promise<PiAgentLike> {
    if (this.agent) {
      return this.agent
    }

    if (!this.initializing) {
      const init: PiAgentInit = {
        initialState: {
          systemPrompt: this.options.systemPrompt,
          model: this.options.model,
          tools: this.options.tools,
        },
        transformContext: this.options.transformContext,
      }

      const factory = this.options.agentFactory ?? (await loadDefaultFactory())
      this.initializing = Promise.resolve(factory(init)).then((agent) => {
        if (!agent || typeof agent.prompt !== 'function') {
          throw new Error('Pi agent factory returned an invalid agent')
        }
        this.agent = agent
        return agent
      })
    }

    return this.initializing
  }

  async prompt(input: string, options?: Record<string, unknown>): Promise<unknown> {
    const agent = await this.initialize()
    return agent.prompt(input, options)
  }

  async promptStream(
    input: string,
    options?: Record<string, unknown>
  ): Promise<AsyncIterable<unknown>> {
    const agent = await this.initialize()
    if (!agent.promptStream) {
      throw new Error('Pi agent does not support promptStream')
    }
    return agent.promptStream(input, options)
  }

  getAgent(): PiAgentLike | null {
    return this.agent
  }
}

async function loadDefaultFactory(): Promise<PiAgentFactory> {
  try {
    const module = await import('@mariozechner/pi-agent-core')
    const Agent = module.Agent as new (init: PiAgentInit) => PiAgentLike

    if (!Agent) {
      throw new Error('Pi agent core did not export Agent')
    }

    return (init) => new Agent(init)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Pi agent core is not available (${message}). ` +
        'Install @mariozechner/pi-agent-core or provide agentFactory.'
    )
  }
}
