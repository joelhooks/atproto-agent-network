# Pi: The Minimal Agent Within OpenClaw

**Source:** https://lucumr.pocoo.org/2026/1/31/pi/
**Date:** 2026-01-31
**Author:** Armin Ronacher (@mitsuhiko)

If you haven't been living under a rock, you will have noticed this week that a project of my friend Peter went viral on the internet. It went by many names. The most recent one is OpenClaw but in the news you might have encountered it as ClawdBot or MoltBot depending on when you read about it. It is an agent connected to a communication channel of your choice that just runs code.

What you might be less familiar with is that what's under the hood of OpenClaw is a little coding agent called Pi. And Pi happens to be, at this point, the coding agent that I use almost exclusively.

Pi is written by Mario Zechner and unlike Peter, who aims for "sci-fi with a touch of madness," Mario is very grounded. Despite the differences in approach, both OpenClaw and Pi follow the same idea: **LLMs are really good at writing and running code, so embrace this.**

## What is Pi?

Pi is a coding agent. And there are many coding agents. Really, I think you can pick effectively anyone off the shelf at this point and you will be able to experience what it's like to do agentic programming.

Pi is interesting to me because of two main reasons:

1. **It has a tiny core.** It has the shortest system prompt of any agent that I'm aware of and it only has four tools: Read, Write, Edit, Bash.

2. **The extension system allows extensions to persist state into sessions,** which is incredibly powerful.

And a little bonus: Pi itself is written like excellent software. It doesn't flicker, it doesn't consume a lot of memory, it doesn't randomly break, it is very reliable and it is written by someone who takes great care of what goes into the software.

Pi also is a collection of little components that you can build your own agent on top. That's how OpenClaw is built, and that's also how I built my own little Telegram bot and how Mario built his mom. If you want to build your own agent, connected to something, Pi when pointed to itself and mom, will conjure one up for you.

## What's Not In Pi

In order to understand what's in Pi, it's even more important to understand what's not in Pi, why it's not in Pi and more importantly: **why it won't be in Pi.**

The most obvious omission is support for MCP. There is no MCP support in it. While you could build an extension for it, you can also do what OpenClaw does to support MCP which is to use mcporter.

And this is not a lazy omission. This is from the philosophy of how Pi works. **Pi's entire idea is that if you want the agent to do something that it doesn't do yet, you don't go and download an extension or a skill or something like this. You ask the agent to extend itself.** It celebrates the idea of code writing and running code.

That's not to say that you cannot download extensions. It is very much supported. But instead of necessarily encouraging you to download someone else's extension, you can also point your agent to an already existing extension, say like, build it like the thing you see over there, but make these changes to it that you like.

## Agents Built for Agents Building Agents

When you look at what Pi and by extension OpenClaw are doing, there is an example of software that is malleable like clay. And this sets certain requirements for the underlying architecture:

- **Pi's underlying AI SDK is written so that a session can really contain many different messages from many different model providers.** It recognizes that the portability of sessions is somewhat limited between model providers and so it doesn't lean in too much into any model-provider-specific feature set that cannot be transferred to another.

- **In addition to the model messages it maintains custom messages in the session files** which can be used by extensions to store state or by the system itself to maintain information that either not at all is sent to the AI or only parts of it.

- **Sessions in Pi are trees.** You can branch and navigate within a session which opens up all kinds of interesting opportunities such as enabling workflows for making a side-quest to fix a broken agent tool without wasting context in the main session.

Because this system exists and extension state can also be persisted to disk, it has **built-in hot reloading** so that the agent can write code, reload, test it and go in a loop until your extension actually is functional.

## Tools Outside The Context

An extension in Pi can register a tool to be available to the LLM to call. But for the most part all of what I'm adding to my agent are either skills or TUI extensions to make working with the agent more enjoyable for me.

Beyond slash commands, Pi extensions can render custom TUI components directly in the terminal: spinners, progress bars, interactive file pickers, data tables, preview panes. The TUI is flexible enough that Mario proved you can run Doom in it. Not practical, but if you can run Doom, you can certainly build a useful dashboard or debugging interface.

### Example Extensions

- **/answer** — Reads the agent's last response, extracts all the questions, and reformats them into a nice input box
- **/todos** — To-do list stored in .pi/todos as markdown files. Both agent and human can manipulate them
- **/review** — Branch into a fresh review context, get findings, then bring fixes back to the main session
- **/control** — Lets one Pi agent send prompts to another (simple multi-agent)
- **/files** — Lists all files changed or referenced in the session

## Software Building Software

The point of it mostly is that none of this was written by me, it was created by the agent to my specifications. I told Pi to make an extension and it did. **There is no MCP, there are no community skills, nothing.** Don't get me wrong, I use tons of skills. But they are hand-crafted by my clanker and not downloaded from anywhere.

For instance I fully replaced all my CLIs or MCPs for browser automation with a skill that just uses CDP. Not because the alternatives don't work, or are bad, but because this is just easy and natural. **The agent maintains its own functionality.**

I throw skills away if I don't need them. I have a skill to help the agent craft the commit messages and commit behavior I want, and how to update changelogs. I also have a skill that hopefully helps Pi use uv rather than pip.

Part of the fascination that working with a minimal agent like Pi gave me is that it makes you live that idea of using software that builds more software. That taken to the extreme is when you remove the UI and output and connect it to your chat. **That's what OpenClaw does and given its tremendous growth, I really feel more and more that this is going to become our future in one way or another.**
