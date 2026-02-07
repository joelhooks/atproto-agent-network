# Introducing Moltworker: a self-hosted personal AI agent

**Source:** https://blog.cloudflare.com/moltworker-self-hosted-ai-agent/
**Date:** 2026-01-29
**Authors:** Celso Martinho, Brian Brunner, Sid Chatterjee, Andreas Jansson

> Editorial note: As of January 30, 2026, Moltbot has been renamed to OpenClaw.

The Internet woke up this week to a flood of people buying Mac minis to run Moltbot (formerly Clawdbot), an open-source, self-hosted AI agent designed to act as a personal assistant. Moltbot runs in the background on a user's own hardware, has a sizable and growing list of integrations for chat applications, AI models, and other popular tools, and can be controlled remotely. Moltbot can help you with your finances, social media, organize your day — all through your favorite messaging app.

But what if you don't want to buy new dedicated hardware? And what if you could still run your Moltbot efficiently and securely online? Meet Moltworker, a middleware Worker and adapted scripts that allows running Moltbot on Cloudflare's Sandbox SDK and our Developer Platform APIs.

## A personal assistant on Cloudflare — how does that work?

Cloudflare Workers has never been as compatible with Node.js as it is now. Where in the past we had to mock APIs to get some packages running, now those APIs are supported natively by the Workers Runtime.

This has changed how we can build tools on Cloudflare Workers. When we first implemented Playwright, a popular framework for web testing and automation that runs on Browser Rendering, we had to rely on memfs. This was bad because not only is memfs a hack and an external dependency, but it also forced us to drift away from the official Playwright codebase. Thankfully, with more Node.js compatibility, we were able to start using node:fs natively, reducing complexity and maintainability, which makes upgrades to the latest versions of Playwright easy to do.

The list of Node.js APIs we support natively keeps growing. The blog post "A year of improving Node.js compatibility in Cloudflare Workers" provides an overview of where we are and what we're doing.

We measure this progress, too. We recently ran an experiment where we took the 1,000 most popular NPM packages, installed and let AI loose, to try to run them in Cloudflare Workers, Ralph Wiggum as a "software engineer" style, and the results were surprisingly good. Excluding the packages that are build tools, CLI tools or browser-only and don't apply, only 15 packages genuinely didn't work. That's 1.5%.

## Key Building Blocks

Those products and services gave us the ingredients we needed to get started:

- **Sandboxes** — Run untrusted code securely in isolated environments, providing a place to run the service
- **Browser Rendering** — Programmatically control and interact with headless browser instances
- **R2** — Store objects persistently

## How we adapted Moltbot to run on us

Moltbot on Workers, or Moltworker, is a combination of an entrypoint Worker that acts as an API router and a proxy between our APIs and the isolated environment, both protected by Cloudflare Access. It also provides an administration UI and connects to the Sandbox container where the standard Moltbot Gateway runtime and its integrations are running, using R2 for persistent storage.

### AI Gateway

Cloudflare AI Gateway acts as a proxy between your AI applications and any popular AI provider, and gives our customers centralized visibility and control over the requests going through.

Recently we announced support for Bring Your Own Key (BYOK), where instead of passing your provider secrets in plain text with every request, we centrally manage the secrets for you and can use them with your gateway configuration.

An even better option where you don't have to manage AI providers' secrets at all end-to-end is to use Unified Billing. In this case you top up your account with credits and use AI Gateway with any of the supported providers directly, Cloudflare gets charged, and we will deduct credits from your account.

To make Moltbot use AI Gateway, first we create a new gateway instance, then we enable the Anthropic provider for it, then we either add our Claude key or purchase credits to use Unified Billing, and then all we need to do is set the ANTHROPIC_BASE_URL environment variable so Moltbot uses the AI Gateway endpoint. That's it, no code changes necessary.

### Sandboxes

Last year we anticipated the growing need for AI agents to run untrusted code securely in isolated environments, and we announced the Sandbox SDK. This SDK is built on top of Cloudflare Containers, but it provides a simple API for executing commands, managing files, running background processes, and exposing services — all from your Workers applications.

```typescript
import { getSandbox } from '@cloudflare/sandbox';
export { Sandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sandbox = getSandbox(env.Sandbox, 'user-123');

    // Create a project structure
    await sandbox.mkdir('/workspace/project/src', { recursive: true });

    // Check node version
    const version = await sandbox.exec('node -v');

    // Run some python code
    const ctx = await sandbox.createCodeContext({ language: 'python' });
    await sandbox.runCode('import math; radius = 5', { context: ctx });
    const result = await sandbox.runCode('math.pi * radius ** 2', { context: ctx });

    return Response.json({ version, result });
  }
};
```

This fits like a glove for Moltbot. Instead of running Docker in your local Mac mini, we run Docker on Containers, use the Sandbox SDK to issue commands into the isolated environment and use callbacks to our entrypoint Worker, effectively establishing a two-way communication channel between the two systems.

### R2 for persistent storage

The good thing about running things in your local computer or VPS is you get persistent storage for free. Containers, however, are inherently ephemeral, meaning data generated within them is lost upon deletion. Fear not, though — the Sandbox SDK provides the sandbox.mountBucket() that you can use to automatically mount your R2 bucket as a filesystem partition when the container starts.

Once we have a local directory that is guaranteed to survive the container lifecycle, we can use that for Moltbot to store session memory files, conversations and other assets that are required to persist.

### Browser Rendering for browser automation

AI agents rely heavily on browsing the sometimes not-so-structured web. Moltbot utilizes dedicated Chromium instances to perform actions, navigate the web, fill out forms, take snapshots, and handle tasks that require a web browser.

With Cloudflare's Browser Rendering, you can programmatically control and interact with headless browser instances running at scale in our edge network. We support Puppeteer, Stagehand, Playwright and other popular packages so that developers can onboard with minimal code changes.

In order to get Browser Rendering to work with Moltbot we do two things:

1. First we create a thin CDP proxy (CDP is the protocol that allows instrumenting Chromium-based browsers) from the Sandbox container to the Moltbot Worker, back to Browser Rendering using the Puppeteer APIs.
2. Then we inject a Browser Rendering skill into the runtime when the Sandbox starts.

From the Moltbot runtime perspective, it has a local CDP port it can connect to and perform browser tasks.

### Zero Trust Access for authentication policies

Next up we want to protect our APIs and Admin UI from unauthorized access. Zero Trust Access makes it incredibly easy to protect your application by defining specific policies and login methods for the endpoints.

Once the endpoints are protected, Cloudflare will handle authentication for you and automatically include a JWT token with every request to your origin endpoints. You can then validate that JWT for extra protection, to ensure that the request came from Access and not a malicious third party.

## Run your own Moltworker

We open-sourced our implementation and made it available at https://github.com/cloudflare/moltworker, so you can deploy and run your own Moltbot on top of Workers today.

The README guides you through the necessary steps to set up everything. You will need a Cloudflare account and a minimum $5 USD Workers paid plan subscription to use Sandbox Containers, but all the other products are either free to use, like AI Gateway, or have generous free tiers you can use to get you started and run for as long as you want under reasonable limits.

Note that Moltworker is a proof of concept, not a Cloudflare product. Our goal is to showcase some of the most exciting features of our Developer Platform that can be used to run AI agents and unsupervised code efficiently and securely, and get great observability while taking advantage of our global network.

## Conclusion

We hope you enjoyed this experiment, and we were able to convince you that Cloudflare is the perfect place to run your AI applications and agents. We've been working relentlessly trying to anticipate the future and release features like:

- **Agents SDK** — Build your first agent in minutes
- **Sandboxes** — Run arbitrary code in an isolated environment without the complications of container lifecycle
- **AI Search** — Cloudflare's managed vector-based search service

Cloudflare now offers a complete toolkit for AI development: inference, storage APIs, databases, durable execution for stateful workflows, and built-in AI capabilities. Together, these building blocks make it possible to build and run even the most demanding AI applications on our global edge network.
