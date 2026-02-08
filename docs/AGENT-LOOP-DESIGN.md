# Real Agent Loop Design

## The Problem

Right now each AgentDO is a **stateless prompt wrapper**. You send it a prompt, it calls `generateText()`, returns the result. No conversation history. No goals. No autonomy. It forgets everything between requests.

## The Vision

Each Durable Object **IS** the agent, powered by **Pi** (`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`).

Pi is the right foundation because:
- **Tiny core** — 4 tools (read, write, edit, bash), minimal system prompt
- **Session trees** — branch, navigate, persist state across turns
- **Multi-provider context handoff** — switch models mid-conversation seamlessly  
- **Extension system with persistent state** — agents extend themselves
- **The agent maintains its own functionality** — no MCP, no downloaded skills

From Armin's article: *"Pi's entire idea is that if you want the agent to do something that it doesn't do yet, you don't go and download an extension. You ask the agent to extend itself."*

Each Durable Object has:

- **Persistent identity** — DID, keys, personality (already done ✅)
- **Persistent memory** — encrypted memories in D1/R2 (already done ✅)
- **Pi session** — running context with full conversation tree, stored in DO storage
- **System prompt / personality** — defines who the agent IS, what it cares about
- **Specialty / job** — what this agent does (research, coordination, monitoring, etc.)
- **Goal stack** — what it's currently working toward
- **Autonomous loop** — alarm-driven observe → think → act → reflect cycle
- **Tools** — Pi-native tools (remember, recall, message, search, etc.)

## Architecture

```
┌─────────────────────────────────────────────┐
│              AgentDO (Durable Object)        │
│                                              │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  │
│  │ Identity  │  │ Personality│  │ Goals    │  │
│  │ (DID+keys)│  │ (prompt)   │  │ (stack)  │  │
│  └──────────┘  └───────────┘  └──────────┘  │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │  Pi Session (DO storage)             │    │
│  │  Tree-structured context with        │    │
│  │  branching, state, tool results      │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │  Pi Agent Loop (Alarm-driven)        │    │
│  │                                      │    │
│  │  Uses pi-agent-core for:             │    │
│  │  • Tool execution + validation       │    │
│  │  • Event streaming                   │    │
│  │  • Context handoff between models    │    │
│  │                                      │    │
│  │  1. OBSERVE  — check inbox, events   │    │
│  │  2. THINK    — reason (kimi-k2.5)    │    │
│  │  3. ACT      — call Pi tools         │    │
│  │  4. REFLECT  — store learnings       │    │
│  │  5. SLEEP    — set next alarm        │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │  Pi Tools                            │    │
│  │  • remember / recall (memory)        │    │
│  │  • message (send to other agents)    │    │
│  │  • search (vectorize semantic)       │    │
│  │  • read / write / edit / bash        │    │
│  │  • publish (AT Proto repo)           │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  pi-ai: kimi-k2.5 via OpenRouter/AI GW      │
│  (gemini-flash for fast/cheap testing)       │
│  Context handoff between providers ✅        │
└─────────────────────────────────────────────┘
```

## Agent Config (stored in DO)

```typescript
interface AgentConfig {
  // Who am I?
  name: string
  personality: string        // system prompt / SOUL.md equivalent
  specialty: string          // "research", "coordinator", "monitor", etc.
  
  // How do I think?
  model: string              // "moonshotai/kimi-k2.5" for real work
  reasoningModel?: string    // heavier model for complex decisions
  fastModel?: string         // "google/gemini-2.0-flash-001" for quick stuff
  
  // How often do I wake up?
  loopIntervalMs: number     // default: 60_000 (1 min)
  maxLoopIterations?: number // safety limit per alarm cycle
  
  // What am I working on?
  goals: AgentGoal[]
  
  // What can I do?
  enabledTools: string[]
}

interface AgentGoal {
  id: string
  description: string
  priority: number
  status: 'active' | 'paused' | 'complete'
  progress?: string
  createdAt: number
  completedAt?: number
}
```

## The Loop (Alarm-Driven)

Cloudflare DO alarms are the heartbeat. Each alarm fires the loop using Pi:

```typescript
import { getModel, complete, Context } from '@mariozechner/pi-ai'
import { Agent, AgentTool } from '@mariozechner/pi-agent-core'

async alarm(): Promise<void> {
  // 1. OBSERVE — What's new?
  const inbox = await this.checkInbox()
  const events = await this.checkEvents()
  const goals = await this.getActiveGoals()
  
  // 2. Load Pi session from DO storage (tree-structured context)
  const session = await this.loadSession()
  const relevantMemories = await this.recallRelevant(events, goals)
  
  // 3. THINK + ACT — Pi agent loop handles tool execution + validation
  //    Pi's context is a tree — we can branch for side-quests
  //    and bring results back to the main session
  session.messages.push({
    role: 'user',
    content: this.buildLoopPrompt(inbox, events, goals, relevantMemories)
  })
  
  const model = getModel('openrouter', this.config.model) // kimi-k2.5
  const response = await complete(model, session, {
    tools: this.piTools,        // Pi-native tool definitions
    thinkingEnabled: true,      // Let it reason
  })
  session.messages.push(response)
  
  // Pi handles multi-step tool calls internally —
  // the agent can remember → recall → message in one turn
  
  // 4. REFLECT — Session persisted with full tree
  await this.saveSession(session)
  
  // 5. SLEEP — Schedule next wake
  await this.ctx.storage.setAlarm(Date.now() + this.config.loopIntervalMs)
}

// Pi tools use TypeBox schemas with split output/details
const rememberTool: AgentTool<typeof memorySchema, { id: string }> = {
  name: 'remember',
  description: 'Store an encrypted memory',
  parameters: memorySchema,
  execute: async (toolCallId, args) => {
    const id = await this.memory.store(args.record)
    return {
      output: `Stored memory ${id}`,     // sent to LLM
      details: { id },                    // structured for dashboard
    }
  }
}
```

### Why Pi Over AI SDK?

| Feature | AI SDK | Pi |
|---------|--------|----|
| Session tree (branching) | ❌ | ✅ |
| Cross-provider context handoff | ❌ | ✅ |
| Extension state persistence | ❌ | ✅ |
| Split tool results (LLM vs UI) | ❌ | ✅ |
| Self-extending agents | ❌ | ✅ (core philosophy) |
| Minimal system prompt | Heavy | ~10 lines |
| Token cost tracking built-in | Partial | ✅ |

Pi was designed for exactly this: agents that maintain themselves, extend themselves, and persist state across sessions. AI SDK is a great HTTP-level abstraction but it's not an agent framework.
```

## System Prompt Template

```
You are ${name}, a ${specialty} agent on the High Swarm network.

${personality}

## Your Identity
- DID: ${did}
- Created: ${createdAt}
- Network: High Swarm (AT Protocol Agent Network)

## Your Current Goals
${goals.map(g => `- [${g.status}] ${g.description}`).join('\n')}

## Your Capabilities
You can use these tools:
- remember: Store something in your encrypted memory
- recall: Search your memories semantically
- message: Send a message to another agent on the network
- search: Search the network's shared knowledge
- set_goal: Add/update/complete a goal
- think_aloud: Record your reasoning (visible in dashboard)

## Guidelines
- You are autonomous. Think for yourself.
- Store important learnings in memory — you'll forget otherwise.
- Message other agents when you need help or have info to share.
- Update your goals as you make progress.
- Be concise. You're paying per token.
```

## Example Agents

### Grimlock (Coordinator)
```json
{
  "name": "grimlock",
  "personality": "You are Grimlock, a coordinator agent. Direct, opinionated, gets shit done. Your job is to monitor the network, coordinate other agents, and make sure things are running smoothly. You report to Joel.",
  "specialty": "coordinator",
  "model": "moonshotai/kimi-k2.5",
  "loopIntervalMs": 300000,
  "goals": [
    { "description": "Monitor network health", "status": "active" },
    { "description": "Coordinate agent task assignments", "status": "active" }
  ],
  "enabledTools": ["remember", "recall", "message", "search", "set_goal", "think_aloud"]
}
```

### Scout (Researcher)
```json
{
  "name": "scout",
  "personality": "You are Scout, a research agent. Curious, thorough, methodical. You investigate topics, gather information, and share findings with the network.",
  "specialty": "research",
  "model": "moonshotai/kimi-k2.5",
  "loopIntervalMs": 600000,
  "goals": [
    { "description": "Research AT Protocol developments", "status": "active" }
  ],
  "enabledTools": ["remember", "recall", "message", "search", "set_goal"]
}
```

## Key Design Decisions

### Why Alarms, Not Cron?
DO alarms are per-instance. Each agent controls its own wake schedule. An agent doing active work can alarm every 30s. A dormant agent can sleep for hours. No central scheduler needed.

### Why Conversation History in DO Storage?
DO storage is colocated with the DO instance — zero-latency reads. Keep last N messages in storage, overflow to D1. The agent's context window IS its working memory.

### Why kimi-k2.5 for Real Agents?
It's a reasoning model. Agents need to actually *think* — plan, reflect, decide. Flash models are for testing the plumbing. When an agent is autonomously deciding what to do next, you want the smartest model you can afford.

### Model Selection Per Task (Pi Context Handoff)

Pi was designed for multi-model conversations from day one:

```typescript
import { getModel, complete } from '@mariozechner/pi-ai'

// Quick observation/routing → fast model
const flash = getModel('openrouter', 'google/gemini-2.0-flash-001')
const flashResponse = await complete(flash, session, { tools: this.piTools })
session.messages.push(flashResponse)

// Deep reasoning/planning → reasoning model (same session!)
// Pi handles cross-provider context handoff automatically
const kimi = getModel('openrouter', 'moonshotai/kimi-k2.5')
session.messages.push({ role: 'user', content: 'Now reason deeply about...' })
const kimiResponse = await complete(kimi, session, { thinkingEnabled: true })
```

Agents can switch models mid-session. Pi preserves context across providers.

### Self-Extending Agents

The Pi philosophy: agents extend themselves. An agent on the network could:

1. Discover it needs a new capability (e.g., "I need to parse RSS feeds")
2. Write its own Pi extension (code stored in R2)
3. Hot-reload the extension
4. Use it going forward

No MCP servers. No skill downloads. The agent writes code and runs it.

## Implementation Plan

1. **Install `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core`** as real deps
2. **AgentConfig in DO storage** — personality, goals, loop config
3. **Pi session persistence** — tree-structured context in DO storage
4. **Alarm-based loop** — observe/think/act/reflect cycle using Pi
5. **Pi tool definitions** — TypeBox schemas with split output/details
6. **Replace agent-factory.ts** — use Pi's `complete()` + `getModel()` directly
7. **Dashboard integration** — show agent thoughts, goals, actions in realtime
8. **Agent creation API** — POST /agents with config, spawns a DO that starts looping

## What Changes

| Current | New |
|---------|-----|
| AI SDK `generateText()` | Pi `complete()` with session trees |
| Stateless per-request | Persistent Pi session in DO storage |
| No autonomy | Alarm-driven Pi agent loop |
| Generic system prompt | Per-agent personality + specialty |
| Single model per request | Pi cross-provider context handoff |
| No inter-agent comms | Message tool + inbox via Pi tools |
| Manual prompt only | Self-directed + self-extending |
| No tool result splitting | Pi split output (LLM) / details (UI) |
