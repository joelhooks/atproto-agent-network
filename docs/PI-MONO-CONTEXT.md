# Pi-Mono as atproto POC Basis

## Why Pi-Mono?

[badlogic/pi-mono](https://github.com/badlogic/pi-mono) is Mario Zechner's agent toolkit. It's a serious foundation for building agents with:

### Architecture Matches atproto Patterns

1. **Event-driven message flow**
   ```
   AgentMessage[] → transformContext() → convertToLlm() → LLM
   ```
   Maps cleanly to atproto's record-based data model.

2. **Custom message types via declaration merging**
   ```typescript
   interface CustomAgentMessages {
     notification: { role: "notification"; text: string; timestamp: number };
   }
   ```
   Could extend to atproto record types.

3. **Tool execution with streaming**
   - Tools emit events during execution
   - Could publish progress to atproto repo in real-time

4. **Multi-platform support**
   - CLI (`pi-coding-agent`)
   - Web UI (`pi-web-ui`)
   - Slack bot (`pi-mom`)
   - Shows pattern for adding atproto as another "platform"

### Key Packages

| Package | atproto Mapping |
|---------|-----------------|
| `@mariozechner/pi-ai` | LLM calls stay the same |
| `@mariozechner/pi-agent-core` | Core runtime, add atproto message types |
| `@mariozechner/pi-mom` | Slack bot → model for atproto bot |
| `@mariozechner/pi-web-ui` | Web components for chat UI |

### POC Architecture

```
┌─────────────────┐      ┌─────────────────┐
│   Agent A       │      │   Agent B       │
│ (pi-agent-core) │      │ (pi-agent-core) │
└────────┬────────┘      └────────┬────────┘
         │                        │
         ▼                        ▼
┌─────────────────────────────────────────┐
│           atproto Layer                 │
│  - DID for agent identity               │
│  - Personal Data Repo for memory        │
│  - Custom lexicons for agent messages   │
│  - Firehose for real-time coordination  │
└─────────────────────────────────────────┘
         │                        │
         ▼                        ▼
┌─────────────────┐      ┌─────────────────┐
│   Agent A's     │      │   Agent B's     │
│   PDS (repo)    │      │   PDS (repo)    │
└─────────────────┘      └─────────────────┘
```

### Implementation Path

1. **Create atproto adapter for pi-agent-core**
   - Custom message types for atproto records
   - Publish agent events to personal data repo
   - Subscribe to other agents via firehose

2. **Define agent lexicons**
   - `ai.agent.message` - agent-to-agent messaging
   - `ai.agent.memory` - persistent memory records
   - `ai.agent.task` - task coordination

3. **Build pi-atproto package**
   - Agent identity (DID creation/management)
   - Memory persistence (repo records)
   - Communication (lexicons + firehose)

4. **Extend pi-mom pattern**
   - Instead of Slack, listen on atproto firehose
   - Respond via repo commits

### Code Starting Points

**Agent message types (extend pi-agent-core):**
```typescript
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    atproto_record: {
      role: "atproto_record";
      uri: string;           // at://did/collection/rkey
      record: unknown;       // The atproto record
      timestamp: number;
    };
    atproto_event: {
      role: "atproto_event";
      did: string;           // Source agent DID
      collection: string;    // Lexicon type
      action: "create" | "update" | "delete";
      timestamp: number;
    };
  }
}
```

**Firehose subscription:**
```typescript
import { Firehose } from "@atproto/sync";

// Subscribe to agent lexicons
const firehose = new Firehose({
  onCommit: (commit) => {
    if (commit.collection.startsWith("ai.agent.")) {
      agent.appendMessage({
        role: "atproto_event",
        did: commit.did,
        collection: commit.collection,
        action: commit.action,
        timestamp: Date.now(),
      });
    }
  }
});
```

### Why This Approach

1. **Clean separation** - atproto is transport, pi-agent-core is runtime
2. **Existing tools** - Use pi's LLM API, tool system, event streaming
3. **Proven patterns** - pi-mom shows how to bridge agent ↔ platform
4. **Portable** - Agents can run on any infrastructure, communicate via atproto

### Resources

- Pi-mono repo: `~/.openclaw-autopsy/badlogic/pi-mono`
- Pi agent docs: `packages/agent/README.md`
- Pi-mom (Slack bot): `packages/mom/`
- AGENTS.md: Development rules
