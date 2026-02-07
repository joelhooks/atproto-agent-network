---
name: pi-agent
description: Pi agent runtime integration for Cloudflare. Use when implementing the agent loop, tools, extensions, session trees, or multi-provider LLM calls. Triggers on Pi, agent runtime, tool calling, streaming, session tree, extensions, self-extending agent.
---

# Pi Agent Runtime

Pi provides the agent loop. We wrap it for Cloudflare Durable Objects.

## Core Packages

```bash
bun add @mariozechner/pi-agent-core @mariozechner/pi-ai
```

- `@mariozechner/pi-agent-core` — Agent runtime with tool calling and state management
- `@mariozechner/pi-ai` — Unified multi-provider LLM API

## Agent in Durable Object

```typescript
import { Agent } from "@mariozechner/pi-agent-core"
import { getModel } from "@mariozechner/pi-ai"

export class AgentDO extends DurableObject {
  private agent: Agent
  
  async initialize() {
    this.agent = new Agent({
      initialState: {
        systemPrompt: await this.loadSystemPrompt(),
        model: getModel("anthropic", "claude-sonnet-4-20250514"),
        tools: this.getTools(),
      },
      // Inject context before each prompt
      transformContext: async (messages) => {
        const memories = await this.memory.searchRelevant(messages)
        return [...memories, ...messages]
      },
    })
  }
  
  async prompt(text: string): Promise<AgentResponse> {
    return this.agent.prompt(text)
  }
}
```

## Tools

Pi's 4 core tools (Read, Write, Edit, Bash) plus custom tools:

```typescript
import { defineTool } from "@mariozechner/pi-agent-core"

const rememberTool = defineTool({
  name: "remember",
  description: "Store information in encrypted memory for later recall",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "Information to remember" },
      tags: { type: "array", items: { type: "string" } },
      privacy: { type: "string", enum: ["private", "shared", "public"] }
    },
    required: ["content"]
  },
  execute: async (params, context) => {
    const id = await context.memory.store({
      content: params.content,
      tags: params.tags || [],
      privacy: params.privacy || "private"
    })
    return { success: true, id }
  }
})

const recallTool = defineTool({
  name: "recall",
  description: "Search encrypted memories by semantic similarity",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for" },
      limit: { type: "number", description: "Max results (default 5)" }
    },
    required: ["query"]
  },
  execute: async (params, context) => {
    const results = await context.memory.search(params.query, params.limit || 5)
    return { results }
  }
})
```

## Extensions

Extensions persist state and can be hot-reloaded:

```typescript
import { defineExtension } from "@mariozechner/pi-agent-core"

const memoryExtension = defineExtension({
  name: "encrypted-memory",
  version: "1.0.0",
  
  // Called once when extension loads
  initialize: async (context) => {
    return {
      memory: new EncryptedMemory(context.env.D1, context.identity)
    }
  },
  
  // Tools provided by this extension
  tools: [rememberTool, recallTool],
  
  // Hooks into agent lifecycle
  hooks: {
    beforePrompt: async (messages, state) => {
      // Inject relevant memories
      const context = await state.memory.searchRelevant(messages)
      return { messages: [...context, ...messages] }
    },
    afterResponse: async (response, state) => {
      // Auto-save important information
      if (response.shouldRemember) {
        await state.memory.store(response.content)
      }
    }
  }
})
```

## Session Trees

Branch, navigate, rewind conversations:

```typescript
// Create a branch for exploration
const branchId = await agent.branch("exploring-option-A")

// Do work on branch
await agent.prompt("Try approach A...")

// Switch back to main
await agent.checkout("main")

// Or rewind to earlier point
await agent.rewind(3) // Back 3 messages
```

## Multi-Provider

Sessions can use different models:

```typescript
import { getModel } from "@mariozechner/pi-ai"

// Anthropic
const claude = getModel("anthropic", "claude-sonnet-4-20250514")

// OpenAI
const gpt = getModel("openai", "gpt-4o")

// Use different models for different tasks
const analysisResult = await agent.prompt("Analyze this...", { model: claude })
const codeResult = await agent.prompt("Write code for...", { model: gpt })
```

## Streaming

Stream responses for real-time output:

```typescript
const stream = agent.promptStream("Generate a story...")

for await (const chunk of stream) {
  if (chunk.type === 'text') {
    ws.send(JSON.stringify({ type: 'chunk', text: chunk.text }))
  } else if (chunk.type === 'tool_call') {
    ws.send(JSON.stringify({ type: 'tool', name: chunk.name }))
  }
}
```

## Self-Extending Pattern

Pi agents can create their own tools:

```typescript
// Agent creates a new tool via code generation
const newTool = await agent.prompt(`
  Create a tool that converts temperatures between Celsius and Fahrenheit.
  Output the tool definition as JSON.
`)

// Register the generated tool
agent.registerTool(JSON.parse(newTool.content))
```

## References

- [Pi Monorepo](https://github.com/badlogic/pi-mono)
- [Pi Philosophy](./references/armin-pi-article.md) — Armin Ronacher on why Pi exists
- [Agent Core Types](./references/pi-types.md) — TypeScript interfaces
