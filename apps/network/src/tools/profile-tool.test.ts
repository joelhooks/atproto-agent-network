import { describe, expect, it, vi } from 'vitest'
import { createProfileTool } from './profile-tool'

describe('createProfileTool', () => {
  it('writes profile with truncated fields and updatedAt', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const tool = createProfileTool(write)

    expect(tool.name).toBe('update_profile')

    const result = await tool.execute!({ status: 'playing RPG', currentFocus: 'Room 3', mood: 'excited' })

    expect(write).toHaveBeenCalledOnce()
    const written = write.mock.calls[0][0]
    expect(written.status).toBe('playing RPG')
    expect(written.currentFocus).toBe('Room 3')
    expect(written.mood).toBe('excited')
    expect(typeof written.updatedAt).toBe('number')
    expect(result).toEqual({ ok: true, profile: written })
  })

  it('truncates long fields', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const tool = createProfileTool(write)

    await tool.execute!({ status: 'x'.repeat(200), mood: 'y'.repeat(100) })

    const written = write.mock.calls[0][0]
    expect(written.status.length).toBe(100)
    expect(written.mood.length).toBe(50)
  })

  it('handles toolCallId + params calling convention', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const tool = createProfileTool(write)

    await tool.execute!('tc_123', { status: 'idle' })

    const written = write.mock.calls[0][0]
    expect(written.status).toBe('idle')
  })

  it('skips non-string fields', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const tool = createProfileTool(write)

    await tool.execute!({ status: 123, currentFocus: null, mood: undefined })

    const written = write.mock.calls[0][0]
    expect(written.status).toBeUndefined()
    expect(written.currentFocus).toBeUndefined()
    expect(written.mood).toBeUndefined()
    expect(typeof written.updatedAt).toBe('number')
  })
})
