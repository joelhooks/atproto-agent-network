/**
 * Pi agent wrapper for Cloudflare Durable Objects.
 */

export interface PiAgentMessage {
  role: string
  content?: string
  timestamp?: number
  [key: string]: unknown
}

export type PiAgentTransformContext = (
  messages: PiAgentMessage[]
) => Promise<PiAgentMessage[]>

export interface PiAgentTool {
  name: string
  label?: string
  description?: string
  parameters?: unknown
  // Pi agent-core compatible execute signature:
  // execute(toolCallId, params, signal?, onUpdate?)
  execute?: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (partial: unknown) => void
  ) => unknown | Promise<unknown>
}

export interface PiAgentInit {
  initialState: {
    systemPrompt: string
    model: unknown
    fastModel?: unknown
    tools?: PiAgentTool[]
    messages?: PiAgentMessage[]
    sessionId?: string
    [key: string]: unknown
  }
  transformContext?: PiAgentTransformContext
}

export interface PiAgentLike {
  prompt: (input: string, options?: Record<string, unknown>) => Promise<unknown>
  promptStream?: (
    input: string,
    options?: Record<string, unknown>
  ) => AsyncIterable<unknown>
  // Optional Pi agent-core compatible state surface.
  state?: { messages?: PiAgentMessage[] }
  replaceMessages?: (messages: PiAgentMessage[]) => void
  /** Reset conversation to just the system prompt */
  resetConversation?: () => void
}

export type PiAgentFactory = (init: PiAgentInit) => PiAgentLike | Promise<PiAgentLike>

export interface PiAgentWrapperOptions {
  systemPrompt: string
  model: unknown
  fastModel?: unknown
  tools?: PiAgentTool[]
  transformContext?: PiAgentTransformContext
  agentFactory?: PiAgentFactory
  messages?: PiAgentMessage[]
  sessionId?: string
}

export class PiAgentWrapper {
  private agent: PiAgentLike | null = null
  private initializing: Promise<PiAgentLike> | null = null
  private readonly options: PiAgentWrapperOptions
  private messages: PiAgentMessage[]

  constructor(options: PiAgentWrapperOptions) {
    this.options = options
    this.messages = options.messages ? structuredClone(options.messages) : []
  }

  get isInitialized(): boolean {
    return this.agent !== null
  }

  /** Access the underlying PiAgentLike instance (for o11y, extensions, etc.) */
  get innerAgent(): PiAgentLike | null {
    return this.agent
  }

  async initialize(): Promise<PiAgentLike> {
    if (this.agent) {
      return this.agent
    }

    if (!this.initializing) {
      const initialState: PiAgentInit['initialState'] = {
        systemPrompt: this.options.systemPrompt,
        model: this.options.model,
        fastModel: this.options.fastModel,
      }

      if (this.options.tools) {
        initialState.tools = this.options.tools
      }
      if (this.options.messages) {
        initialState.messages = this.options.messages
      }
      if (this.options.sessionId) {
        initialState.sessionId = this.options.sessionId
      }

      const init: PiAgentInit = {
        initialState,
        transformContext: this.options.transformContext,
      }

      const factory = this.options.agentFactory ?? (await loadDefaultFactory())
      this.initializing = Promise.resolve(factory(init)).then((agent) => {
        if (!agent || typeof agent.prompt !== 'function') {
          throw new Error('Pi agent factory returned an invalid agent')
        }
        this.agent = agent
        this.messages = Array.isArray(agent.state?.messages)
          ? agent.state!.messages!
          : this.messages
        return agent
      })
    }

    return this.initializing
  }

  async prompt(input: string, options?: Record<string, unknown>): Promise<unknown> {
    const agent = await this.initialize()
    const result = await agent.prompt(input, options)

    // In real Pi agent-core, messages are typically tracked in agent.state.messages.
    // For lightweight test doubles (or custom factories) that don't expose state,
    // maintain a best-effort transcript so DO session persistence still works.
    const agentMessages = agent.state?.messages
    if (Array.isArray(agentMessages)) {
      this.messages = agentMessages
      return result
    }

    const now = Date.now()
    this.messages.push({ role: 'user', content: input, timestamp: now })

    const assistantContent = extractAssistantContent(result)
    if (assistantContent) {
      this.messages.push({ role: 'assistant', content: assistantContent, timestamp: now })
    }

    return result
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

  /** Reset conversation to just the system prompt — call before each alarm cycle */
  resetConversation(): void {
    this.messages = []
    this.agent?.resetConversation?.()
  }

  getAgent(): PiAgentLike | null {
    return this.agent
  }

  getMessages(): PiAgentMessage[] {
    const agentMessages = this.agent?.state?.messages
    if (Array.isArray(agentMessages)) {
      this.messages = agentMessages
      return agentMessages
    }
    return this.messages
  }

  replaceMessages(messages: PiAgentMessage[]): void {
    this.messages = messages

    if (this.agent?.replaceMessages) {
      this.agent.replaceMessages(messages)
      return
    }

    if (this.agent?.state && typeof this.agent.state === 'object') {
      this.agent.state.messages = messages
    }
  }
}

function extractAssistantContent(result: unknown): string | null {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const content = (result as { content?: unknown }).content
  return typeof content === 'string' && content.trim().length > 0 ? content : null
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
