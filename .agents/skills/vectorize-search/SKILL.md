---
name: vectorize-search
description: Vectorize semantic search patterns for agent memory. Use when implementing embedding generation, semantic search, memory retrieval, or working with the Vectorize API. Triggers on Vectorize, embeddings, semantic search, vector database, similarity search.
---

# Vectorize Semantic Search

Vectorize provides semantic search over encrypted memories. Index the plaintext (before encryption), store embeddings with record IDs.

## Security Model

```
┌─────────────────────────────────────────────────────────────────┐
│                      SEARCH FLOW                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. STORE                                                        │
│     Content → Embed (plaintext) → Store vector + record ID       │
│     Content → Encrypt → Store ciphertext in D1                   │
│                                                                  │
│  2. SEARCH                                                       │
│     Query → Embed → Vectorize search → Record IDs                │
│     Record IDs → Fetch from D1 → Decrypt → Return plaintext      │
│                                                                  │
│  ⚠️  Vectorize stores embeddings, NOT content                    │
│  ⚠️  Embeddings can leak semantic information                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Index Configuration

```toml
# wrangler.toml
[[vectorize]]
binding = "VECTORIZE"
index_name = "agent-memory"
```

Create index via CLI:

```bash
wrangler vectorize create agent-memory \
  --dimensions=768 \
  --metric=cosine
```

Dimension depends on embedding model:
- `@cf/baai/bge-base-en-v1.5`: 768
- `@cf/baai/bge-large-en-v1.5`: 1024
- OpenAI `text-embedding-3-small`: 1536

## Generate Embeddings

Using Cloudflare AI:

```typescript
async function embed(
  ai: Ai,
  text: string
): Promise<number[]> {
  const result = await ai.run('@cf/baai/bge-base-en-v1.5', {
    text: [text]
  })
  return result.data[0]
}

async function embedBatch(
  ai: Ai,
  texts: string[]
): Promise<number[][]> {
  const result = await ai.run('@cf/baai/bge-base-en-v1.5', {
    text: texts
  })
  return result.data
}
```

## Index Memory

```typescript
async function indexMemory(
  vectorize: VectorizeIndex,
  ai: Ai,
  record: {
    id: string
    did: string
    collection: string
    content: MemoryContent  // Plaintext before encryption
  }
): Promise<void> {
  // Create searchable text from content
  const text = extractSearchableText(record.content)
  
  // Generate embedding
  const embedding = await embed(ai, text)
  
  // Upsert to Vectorize
  await vectorize.upsert([{
    id: record.id,
    values: embedding,
    metadata: {
      did: record.did,
      collection: record.collection,
      tags: record.content.tags?.join(','),
      createdAt: record.content.createdAt
    }
  }])
}

function extractSearchableText(content: MemoryContent): string {
  const parts: string[] = []
  
  if (content.summary) parts.push(content.summary)
  if (content.text) parts.push(content.text)
  if (content.tags) parts.push(content.tags.join(' '))
  
  return parts.join('\n')
}
```

## Semantic Search

```typescript
interface SearchOptions {
  did?: string           // Filter by agent
  collection?: string    // Filter by collection
  limit?: number         // Max results (default 10)
  minScore?: number      // Minimum similarity (default 0.5)
}

async function searchMemory(
  vectorize: VectorizeIndex,
  ai: Ai,
  query: string,
  options: SearchOptions = {}
): Promise<VectorizeMatch[]> {
  // Embed query
  const queryEmbedding = await embed(ai, query)
  
  // Build filter
  const filter: VectorizeFilter = {}
  if (options.did) filter.did = options.did
  if (options.collection) filter.collection = options.collection
  
  // Search
  const results = await vectorize.query(queryEmbedding, {
    topK: options.limit || 10,
    filter,
    returnMetadata: true
  })
  
  // Filter by score
  const minScore = options.minScore ?? 0.5
  return results.matches.filter(m => m.score >= minScore)
}
```

## Full Search Flow

```typescript
async function recallMemories(
  env: Env,
  identity: AgentIdentity,
  query: string,
  options: SearchOptions = {}
): Promise<DecryptedMemory[]> {
  // 1. Semantic search to get record IDs
  const matches = await searchMemory(
    env.VECTORIZE,
    env.AI,
    query,
    { ...options, did: identity.did }
  )
  
  if (matches.length === 0) return []
  
  // 2. Fetch encrypted records from D1
  const ids = matches.map(m => m.id)
  const placeholders = ids.map(() => '?').join(',')
  const rows = await env.DB.prepare(
    `SELECT * FROM records WHERE id IN (${placeholders})`
  ).bind(...ids).all()
  
  // 3. Decrypt each record
  const memories: DecryptedMemory[] = []
  for (const row of rows.results) {
    const record = rowToRecord(row)
    const content = await decryptRecord(record, identity)
    
    const match = matches.find(m => m.id === row.id)
    memories.push({
      id: row.id as string,
      content,
      score: match?.score || 0,
      metadata: match?.metadata
    })
  }
  
  // 4. Sort by score (highest first)
  return memories.sort((a, b) => b.score - a.score)
}
```

## Batch Indexing

```typescript
async function batchIndex(
  vectorize: VectorizeIndex,
  ai: Ai,
  records: Array<{ id: string; text: string; metadata: Record<string, string> }>
): Promise<void> {
  // Batch embed (max 100 at a time)
  const batchSize = 100
  
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize)
    const texts = batch.map(r => r.text)
    
    const embeddings = await embedBatch(ai, texts)
    
    const vectors = batch.map((r, j) => ({
      id: r.id,
      values: embeddings[j],
      metadata: r.metadata
    }))
    
    await vectorize.upsert(vectors)
  }
}
```

## Delete from Index

```typescript
async function deleteFromIndex(
  vectorize: VectorizeIndex,
  ids: string[]
): Promise<void> {
  await vectorize.deleteByIds(ids)
}
```

## Metadata Filtering

Vectorize supports filtering on metadata:

```typescript
// Filter by multiple conditions
const results = await vectorize.query(embedding, {
  topK: 10,
  filter: {
    did: 'did:cf:abc123',
    collection: 'agent.memory.note'
  }
})

// Note: Metadata values must be strings
// Store tags as comma-separated: "tag1,tag2,tag3"
```

## Wrangler Configuration

```toml
[[vectorize]]
binding = "VECTORIZE"
index_name = "agent-memory"

[ai]
binding = "AI"
```

## References

- [Vectorize Documentation](https://developers.cloudflare.com/vectorize/)
- [Workers AI Embeddings](https://developers.cloudflare.com/workers-ai/models/text-embeddings/)
- [Vectorize Query API](https://developers.cloudflare.com/vectorize/platform/client-api/)
