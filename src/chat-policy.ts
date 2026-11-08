export const name = 'video-kit-chat-policy'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx: any): void {
  ctx.on('system-prompt/assemble', async (_assembly: unknown, _context: unknown, next: () => Promise<any>) => {
    const assembly = await next()
    return { ...assembly, tools: assembly.tools.filter((tool: { name: string }) => tool.name === 'web_search') }
  })
  ctx.tools.guard((execution: { name: string }) => execution.name === 'web_search' ? undefined : '聊天模式只允许网页搜索。')
}
