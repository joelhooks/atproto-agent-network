# AI Gateway Architecture

## Decision (2026-02-07)

All AI inference in this project routes through a layered gateway stack for observability, caching, and model flexibility.

## Architecture

```
Agent Code (Vercel AI SDK)
    → Cloudflare AI Gateway (observability, caching, fallback)
        → OpenRouter (model routing — Kimi 2.5, Claude, Gemini, etc.)
        → Workers AI (edge embeddings, cheap inference)
        → OpenAI direct (specific models when needed)
```

## Why This Stack

| Layer | Purpose | Cost |
|-------|---------|------|
| **Vercel AI SDK** | Code-level abstraction. `generateText()` / `streamText()` / `embed()` — provider-agnostic | Free (npm package) |
| **Cloudflare AI Gateway** | Proxy layer we own. Logging, analytics, caching, rate limiting, model fallback | Free (included with CF account) |
| **OpenRouter** | Model marketplace. One API key → access to Kimi 2.5, Claude, Gemini, Llama, etc. | Pay-per-token (varies by model) |
| **Workers AI** | Edge inference on CF network. Great for embeddings (no roundtrip to external API) | Free tier generous, then pay-per-token |

## Key Models

| Use Case | Model | Provider |
|----------|-------|----------|
| Agent reasoning | Kimi 2.5 (primary), Claude fallback | OpenRouter |
| Embeddings | `@cf/bge-base-en-v1.5` or `@cf/baai/bge-large-en-v1.5` | Workers AI (edge) |
| Fallback reasoning | Claude Sonnet/Haiku | OpenRouter |
| Code generation | GPT-4o / Claude | OpenRouter |

## Configuration

### Environment Variables

```toml
# wrangler.toml [vars]
AI_GATEWAY_SLUG = "atproto-agent-network"
OPENROUTER_MODEL_DEFAULT = "moonshot/kimi-k2"

# wrangler.toml [secrets] (via `wrangler secret put`)
OPENROUTER_API_KEY = "sk-or-..."
```

### Cloudflare AI Gateway Setup

1. Dashboard → AI → AI Gateway → Create Gateway
2. Name: `atproto-agent-network`
3. Base URL pattern: `https://gateway.ai.cloudflare.com/v1/{account_id}/atproto-agent-network`

### Request Routing (in code)

```typescript
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

// OpenRouter through CF AI Gateway
const openrouter = createOpenRouter({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/atproto-agent-network/openrouter`,
});

const result = await generateText({
  model: openrouter("moonshot/kimi-k2"),
  prompt: "...",
});

// Workers AI for embeddings (native binding, no gateway needed)
const embeddings = await env.AI.run("@cf/baai/bge-large-en-v1.5", {
  text: ["memory content to embed"],
});
```

## What NOT To Do

- ❌ Don't use Vercel AI Gateway (extra proxy hop, you're on CF)
- ❌ Don't call Kimi API directly (no observability, no fallback)
- ❌ Don't use OpenAI for embeddings (Workers AI is free on edge)
- ❌ Don't hardcode API keys (use wrangler secrets)

## Fallback Chain

```
Primary: moonshot/kimi-k2 (via OpenRouter)
    ↓ (on error/timeout)
Fallback 1: anthropic/claude-sonnet-4 (via OpenRouter)
    ↓ (on error/timeout)
Fallback 2: @cf/meta/llama-3.1-8b-instruct (Workers AI, always available)
```

CF AI Gateway handles this fallback automatically when configured.

## Accounts Required

1. **Cloudflare** — Already have (project lives here)
2. **OpenRouter** — Sign up at openrouter.ai, add credits, get API key
3. **Workers AI** — Included with CF account, just enable in dashboard
