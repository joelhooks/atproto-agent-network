import { describe, expect, it, vi } from 'vitest'

import { PiAgentWrapper } from './agent'

describe('PiAgentWrapper', () => {
  it('initializes with the expected Pi agent configuration', async () => {
    const agent = { prompt: vi.fn() }
    const agentFactory = vi.fn().mockResolvedValue(agent)
    const tools = [{ name: 'remember' }]
    const transformContext = vi.fn(async (messages: Array<{ role: string }>) => messages)

    const wrapper = new PiAgentWrapper({
      systemPrompt: 'system',
      model: { provider: 'test' },
      tools,
      transformContext,
      agentFactory,
    })

    await wrapper.initialize()

    expect(agentFactory).toHaveBeenCalledTimes(1)
    const init = agentFactory.mock.calls[0][0]

    expect(init.initialState).toEqual({
      systemPrompt: 'system',
      model: { provider: 'test' },
      tools,
    })
    expect(init.transformContext).toBe(transformContext)
  })

  it('forwards prompt calls to the underlying agent', async () => {
    const prompt = vi.fn().mockResolvedValue({ content: 'ok' })
    const agentFactory = vi.fn().mockResolvedValue({ prompt })

    const wrapper = new PiAgentWrapper({
      systemPrompt: 'system',
      model: 'model',
      agentFactory,
    })

    const response = await wrapper.prompt('hello', { model: 'fast' })

    expect(prompt).toHaveBeenCalledWith('hello', { model: 'fast' })
    expect(response).toEqual({ content: 'ok' })
  })

  it('throws when promptStream is not supported by the agent', async () => {
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const wrapper = new PiAgentWrapper({
      systemPrompt: 'system',
      model: 'model',
      agentFactory,
    })

    await expect(wrapper.promptStream('stream')).rejects.toThrow('promptStream')
  })

  it('initializes only once across concurrent prompts', async () => {
    const prompt = vi.fn().mockResolvedValue('ok')
    const agentFactory = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return { prompt }
    })

    const wrapper = new PiAgentWrapper({
      systemPrompt: 'system',
      model: 'model',
      agentFactory,
    })

    await Promise.all([
      wrapper.prompt('first'),
      wrapper.prompt('second'),
    ])

    expect(agentFactory).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(2)
  })
})
