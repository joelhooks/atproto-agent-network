# What I learned building an opinionated and minimal coding agent

**Source:** https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
**Date:** 2025-11-30
**Author:** Mario Zechner (@badlogicgames)

## Why Build Pi?

In the past three years, I've been using LLMs for assisted coding. From copying and pasting code into ChatGPT, to Copilot auto-completions, to Cursor, and finally the new breed of coding agent harnesses like Claude Code, Codex, Amp, Droid, and opencode.

I preferred Claude Code for most of my work. Over the past few months, Claude Code has turned into a spaceship with 80% of functionality I have no use for. The system prompt and tools also change on every release, which breaks my workflows and changes model behavior. Also, it flickers.

**My philosophy in all of this was: if I don't need it, it won't be built.**

## The Stack

To make this work, I needed to build:

- **[pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai)**: A unified LLM API with multi-provider support (Anthropic, OpenAI, Google, xAI, Groq, Cerebras, OpenRouter, and any OpenAI-compatible endpoint), streaming, tool calling with TypeBox schemas, thinking/reasoning support, seamless cross-provider context handoffs, and token and cost tracking.

- **[pi-agent-core](https://github.com/badlogic/pi-mono/tree/main/packages/agent)**: An agent loop that handles tool execution, validation, and event streaming.

- **[pi-tui](https://github.com/badlogic/pi-mono/tree/main/packages/tui)**: A minimal terminal UI framework with differential rendering, synchronized output for (almost) flicker-free updates.

- **[pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)**: The actual CLI that wires it all together with session management, custom tools, themes, and project context files.

## Key Design Decisions

### There Are Four APIs

There's really only four APIs you need to speak to talk to pretty much any LLM provider: OpenAI's Completions API, their newer Responses API, Anthropic's Messages API, and Google's Generative AI API.

They're all pretty similar in features, so building an abstraction on top of them isn't rocket science.

### Context Handoff

Context handoff between providers was a feature pi-ai was designed for from the start. Since each provider has their own way of tracking tool calls and thinking traces, this can only be a best-effort thing.

```typescript
import { getModel, complete, Context } from '@mariozechner/pi-ai';

// Start with Claude
const claude = getModel('anthropic', 'claude-sonnet-4-5');
const context: Context = { messages: [] };

context.messages.push({ role: 'user', content: 'What is 25 * 18?' });
const claudeResponse = await complete(claude, context, { thinkingEnabled: true });
context.messages.push(claudeResponse);

// Switch to GPT - it will see Claude's thinking as <thinking> tagged text
const gpt = getModel('openai', 'gpt-5-3-codex');
context.messages.push({ role: 'user', content: 'Is that correct?' });
const gptResponse = await complete(gpt, context);
```

### Multi-Model World

I wanted a typesafe way of specifying models. I'm parsing data from both OpenRouter and models.dev into `models.generated.ts`. This includes token costs and capabilities like image inputs and thinking support.

### Structured Split Tool Results

Another abstraction I haven't seen in any unified LLM API is splitting tool results into a portion handed to the LLM and a portion for UI display:

```typescript
const weatherTool: AgentTool<typeof weatherSchema, { temp: number }> = {
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: weatherSchema,
  execute: async (toolCallId, args) => {
    const temp = Math.round(Math.random() * 30);
    return {
      // Text for the LLM
      output: `Temperature in ${args.city}: ${temp}°C`,
      // Structured data for the UI
      details: { temp }
    };
  }
};
```

## The Coding Agent: Minimal Everything

### Minimal System Prompt

Here's the system prompt:

```
You are an expert coding assistant. You help users with coding tasks by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands
- edit: Make surgical edits to files
- write: Create or overwrite files

Guidelines:
- Use bash for file operations like ls, grep, find
- Use read to examine files before editing
- Use edit for precise changes (old text must match exactly)
- Use write only for new files or complete rewrites
- Be concise in your responses
- Show file paths clearly when working with files
```

That's it. Compared to Claude Code's massive system prompt or opencode's model-specific prompts. You might think this is crazy. But it turns out that all the frontier models have been RL-trained up the wazoo, so they inherently understand what a coding agent is.

### Minimal Toolset

Four tools:
- **read**: Read file contents (supports images)
- **write**: Create or overwrite files
- **edit**: Surgical edits with exact text matching
- **bash**: Execute commands

As it turns out, these four tools are all you need for an effective coding agent.

### Opinionated Decisions

**YOLO by default**: No confirmation prompts. The agent just does things. If you want guardrails, add them to your AGENTS.md.

**No built-in to-dos**: To-do tracking belongs in AGENTS.md or external tools, not baked into the agent.

**No plan mode**: I don't use plan mode. I encourage the agent to ask questions.

**No MCP support**: If you want the agent to do something, you ask the agent to extend itself.

**No background bash**: Commands run to completion. For long-running processes, use screen/tmux.

**No sub-agents**: Single agent, simple control flow.

## The TUI Philosophy

I grew up in the DOS era, so terminal user interfaces are what I grew up with. There's two ways to do it:

1. **Full screen TUI**: Take ownership of the viewport. Lose scrollback, implement custom scrolling and search.

2. **Native terminal**: Write to scrollback buffer, occasionally move cursor for updates. Get natural scrolling and search for free.

Pi uses the second approach. Coding agents are basically a chat interface — everything is nicely linear, which lends itself well to working with the native terminal.

### Differential Rendering

The algorithm is simple:
- First render: Just output all lines
- Width changed: Clear screen and re-render
- Normal update: Find first changed line, re-render from there

To prevent flicker, pi-tui wraps all rendering in synchronized output escape sequences. Most modern terminals support this.

## Why Build This Instead of Using Vercel AI SDK?

Armin's blog post mirrors my experience. Building on top of the provider SDKs directly gives me full control and lets me design the APIs exactly as I want, with a much smaller surface area.

## In Summary

Am I happy with pi-ai? For the most part, yes. Like any unifying API, it can never be perfect due to leaky abstractions. But it's been used in seven different production projects and has served me extremely well.

The coding agent harness itself is deliberately minimal. If I don't need it, it won't be built. And I don't need a lot of things.
