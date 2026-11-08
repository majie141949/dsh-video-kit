import { describe, expect, it } from 'vitest'
import { apply } from '../chat-policy'

describe('聊天模式工具隔离', () => {
  it('只向模型提供网页搜索，并拒绝执行其他工具', async () => {
    let assemble: any
    let guard: any
    apply({
      on: (event: string, handler: unknown) => {
        expect(event).toBe('system-prompt/assemble')
        assemble = handler
      },
      tools: { guard: (handler: unknown) => { guard = handler } },
    })

    const original = {
      sections: [{ name: 'persona', content: '日常对话' }],
      tools: ['web_search', 'web_fetch', 'video_generate', 'ops_discover_tools', 'run_code'].map(name => ({ name })),
    }
    const result = await assemble(original, {}, async () => original)

    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(['web_search'])
    expect(result.sections).toEqual(original.sections)
    expect(original.tools).toHaveLength(5)
    expect(guard({ name: 'web_search' })).toBeUndefined()
    for (const name of ['web_fetch', 'video_generate', 'ops_discover_tools', 'run_code']) {
      expect(guard({ name })).toBe('聊天模式只允许网页搜索。')
    }
  })
})
