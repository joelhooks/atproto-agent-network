# Real Agent Loop Design

## The Problem

Right now each AgentDO is a **stateless prompt wrapper**. You send it a prompt, it calls `generateText()`, returns the result. No conversation history. No goals. No autonomy. It forgets everything between requests.

## The Vision

Each Durable Object **IS** the agent. It has:

- **Persistent identity** — DID, keys, personality (already done ✅)
- **Persistent memory** — encrypted memories in D1/R2 (already done ✅)
- **Conversation history** — running context window stored in DO storage
- **System prompt / personality** — defines who the agent IS, what it cares about
- **Specialty / job** — what this agent does (research, coordination, monitoring, etc.)
- **Goal stack** — what it's currently working toward
- **Autonomous loop** — observe → think → act → reflect cycle
- **Tools** — remember, recall, message other agents, search, etc.

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
│  │  Conversation History (DO storage)   │    │
│  │  [{role, content, ts}, ...]          │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │  Agent Loop (Alarm-driven)           │    │
│  │                                      │    │
│  │  1. OBSERVE  — check inbox, events   │    │
│  │  2. THINK    — reason about state    │    │
│  │  3. ACT      — call tools, respond   │    │
│  │  4. REFLECT  — store learnings       │    │
│  │  5. SLEEP    — set next alarm        │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │  Tools                               │    │
│  │  • remember / recall (memory)        │    │
│  │  • message (send to other agents)    │    │
│  │  • search (vectorize semantic)       │    │
│  │  • observe (check external sources)  │    │
│  │  • publish (AT Proto repo)           │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  Model: kimi-k2.5 via OpenRouter/AI GW      │
│  (gemini-flash for fast/cheap testing)       │
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

Cloudflare DO alarms are the heartbeat. Each alarm fires the loop:

```typescript
async alarm(): Promise<void> {
  // 1. OBSERVE — What's new?
  const inbox = await this.checkInbox()
  const events = await this.checkEvents()
  const goals = await this.getActiveGoals()
  
  // 2. Build context
  const history = await this.getConversationHistory(50) // last 50 turns
  const relevantMemories = await this.recallRelevant(events, goals)
  
  // 3. THINK + ACT — Let the model decide
  const result = await generateText({
    model: getModel(this.config.model), // kimi-k2.5 for real agents
    system: this.buildSystemPrompt(),
    messages: [
      ...history,
      {
        role: 'user',
        content: this.buildLoopPrompt(inbox, events, goals, relevantMemories)
      }
    ],
    tools: this.getToolDefinitions(),
    maxSteps: 5,  // allow multi-step tool use
  })
  
  // 4. REFLECT — Store what happened
  await this.appendHistory({ role: 'assistant', content: result.text })
  if (result.toolCalls.length > 0) {
    await this.logActions(result.toolCalls)
  }
  
  // 5. SLEEP — Schedule next wake
  await this.ctx.storage.setAlarm(Date.now() + this.config.loopIntervalMs)
}
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

### Model Selection Per Task
```typescript
// Quick observation/routing → fast model
const fastResult = await generateText({ model: flash, ... })

// Deep reasoning/planning → reasoning model  
const deepResult = await generateText({ model: kimi, ... })
```

Agents can choose which model to use based on the task complexity.

## Implementation Plan

1. **AgentConfig in DO storage** — personality, goals, loop config
2. **Conversation history** — append-only log with window management
3. **Alarm-based loop** — observe/think/act/reflect cycle
4. **Tool definitions** — Vercel AI SDK `tool()` format with `maxSteps`
5. **Dashboard integration** — show agent thoughts, goals, actions in realtime
6. **Agent creation API** — POST /agents with config, spawns a DO that starts looping

## What Changes

| Current | New |
|---------|-----|
| Stateless `generateText()` | Persistent conversation + goals |
| No autonomy | Alarm-driven loop |
| Generic system prompt | Per-agent personality + specialty |
| Single model | Model selection per task type |
| No inter-agent comms | Message tool + inbox checking |
| Manual prompt only | Self-directed + responsive to messages |
