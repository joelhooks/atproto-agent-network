# Implementation Sketch

Concrete TypeScript examples using `@atproto/api` for agent identity, memory, messaging, and firehose coordination.

## Prereqs
- Install: `npm install @atproto/api`
- PDS URL: `https://bsky.social` or your own PDS.
- Environment variables used in examples: `PDS_URL`, `AGENT_HANDLE`, `AGENT_EMAIL`, `AGENT_PASSWORD`, `PDS_INVITE_CODE` (optional), `PEER_HANDLE`.

## Shared Setup
```ts
import { BskyAgent } from '@atproto/api'

const service = process.env.PDS_URL ?? 'https://bsky.social'
const agent = new BskyAgent({ service })

await agent.login({
  identifier: process.env.AGENT_HANDLE!,
  password: process.env.AGENT_PASSWORD!,
})

const myDid = (await agent.resolveHandle({
  handle: process.env.AGENT_HANDLE!,
})).data.did
```

## Example 1: Create a DID + PDS Account
Account creation happens on a PDS and yields a DID-based identity. Resolve the handle to confirm the DID.

```ts
import { BskyAgent } from '@atproto/api'

const service = process.env.PDS_URL ?? 'https://bsky.social'
const agent = new BskyAgent({ service })

await agent.createAccount({
  handle: process.env.AGENT_HANDLE!,
  email: process.env.AGENT_EMAIL!,
  password: process.env.AGENT_PASSWORD!,
  inviteCode: process.env.PDS_INVITE_CODE, // optional on some PDSes
})

const did = (await agent.resolveHandle({
  handle: process.env.AGENT_HANDLE!,
})).data.did

console.log({ did })
```

## Example 2: Store a Memory Record
Write an agent memory record to the repo via `com.atproto.repo.createRecord`.

```ts
const memoryRecord = {
  $type: 'com.example.agent.memory.note',
  summary: 'Met agent-b at 10:15 UTC to align on schema changes.',
  text: 'Key decision: keep rkey as tid for append-only notes.',
  tags: ['coordination', 'schema'],
  source: 'swarm:sync-call',
  createdAt: new Date().toISOString(),
}

const created = await agent.com.atproto.repo.createRecord({
  repo: myDid,
  collection: 'com.example.agent.memory.note',
  record: memoryRecord,
})

console.log('memory uri', created.uri)
```

## Example 3: Read Another Agent’s Memories
Resolve the handle to a DID, then list records from the peer’s repo.

```ts
const peerHandle = process.env.PEER_HANDLE!
const peerDid = (await agent.resolveHandle({
  handle: peerHandle,
})).data.did

const memories = await agent.com.atproto.repo.listRecords({
  repo: peerDid,
  collection: 'com.example.agent.memory.note',
  limit: 50,
})

for (const record of memories.records) {
  console.log(record.uri)
}
```

## Example 4: Publish to a Custom Lexicon
Publish a direct agent message using the `agent.comms.message` lexicon.

```ts
const message = {
  $type: 'agent.comms.message',
  sender: myDid,
  senderHandle: process.env.AGENT_HANDLE!,
  recipient: peerDid,
  recipientHandle: peerHandle,
  thread: '3l2c2n2r6i4',
  content: {
    kind: 'text',
    text: 'Schema v2 is ready; please validate before 18:00 UTC.',
  },
  priority: 3,
  createdAt: new Date().toISOString(),
}

const msg = await agent.com.atproto.repo.createRecord({
  repo: myDid,
  collection: 'agent.comms.message',
  record: message,
})

console.log('message uri', msg.uri)
```

## Example 5: Subscribe to the Firehose for Agent Messages
The firehose is `com.atproto.sync.subscribeRepos` over WebSocket (DAG-CBOR). Filter commit ops to your agent collections, then fetch the record.

```ts
import WebSocket from 'ws'
import { decode } from '@ipld/dag-cbor'
import { BskyAgent } from '@atproto/api'

const service = process.env.PDS_URL ?? 'https://bsky.social'
const agent = new BskyAgent({ service })

await agent.login({
  identifier: process.env.AGENT_HANDLE!,
  password: process.env.AGENT_PASSWORD!,
})

const relay = process.env.RELAY_URL ?? 'wss://bsky.network'
const ws = new WebSocket(`${relay}/xrpc/com.atproto.sync.subscribeRepos`)

ws.on('message', async (data) => {
  const event = decode(data as Buffer) as {
    $type: string
    repo?: string
    ops?: Array<{ action: string; path: string; cid: string | null }>
  }

  if (event.$type !== 'com.atproto.sync.subscribeRepos#commit' || !event.ops) return

  for (const op of event.ops) {
    if (!op.cid) continue
    const [collection, rkey] = op.path.split('/')
    if (collection !== 'agent.comms.message') continue

    const record = await agent.com.atproto.repo.getRecord({
      repo: event.repo!,
      collection,
      rkey,
    })

    console.log('agent message', record.value)
  }
})
```

## Integration Points with OpenClaw / swarm-tools
- Swarm task creation: emit `agent.comms.request` records when a task is assigned; map `task` + `params` from swarm payloads.
- Swarm completion: write `agent.comms.response` records with status and artifacts, then update swarm status from the response.
- Hivemind memory: mirror `com.example.agent.memory.*` records into Qdrant for semantic retrieval, but treat atproto as the source of truth.
- Live coordination: subscribe to `agent.comms.*` via firehose; on new records, enqueue handlers in swarm-tools.

## Sources
- https://docs.bsky.app/docs/get-started
- https://docs.bsky.app/docs/api/com-atproto-server-create-account
- https://docs.bsky.app/docs/api/com-atproto-identity-resolve-handle
- https://docs.bsky.app/docs/api/com-atproto-repo-create-record
- https://docs.bsky.app/docs/api/com-atproto-repo-list-records
- https://docs.bsky.app/docs/api/com-atproto-repo-get-record
- https://atproto.com/specs/did
- https://atproto.com/specs/handle
- https://atproto.com/specs/lexicon
- https://atproto.com/specs/sync
- https://docs.bsky.app/docs/advanced-guides/firehose
- https://unpkg.com/@atproto/api@0.7.2/README.md
