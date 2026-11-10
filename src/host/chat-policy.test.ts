import { describe, expect, it } from 'vitest'
import { apply } from '../chat-policy'

describe('聊天模式工具隔离', () => {
  it('只向模型提供网页搜索，并拒绝执行其他工具', async () => {
    let restriction: unknown
    let guard: (execution: { name: string }) => string | undefined
    apply({
      tools: {
        restrict: (filter: unknown) => { restriction = filter },
        guard: (handler: typeof guard) => { guard = handler },
      },
    })

    expect(restriction).toEqual({ allow: [] })
    expect(guard({ name: 'web_search' })).toBeUndefined()
    for (const name of ['web_fetch', 'video_generate', 'ops_discover_tools', 'run_code']) {
      expect(guard({ name })).toBe('聊天模式只允许网页搜索。')
    }
  })
})
