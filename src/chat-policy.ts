export const name = 'video-kit-chat-policy'
export const inject = ['tools']

export function apply(ctx: any): void {
  ctx.tools.restrict({ allow: [] })
  ctx.tools.guard((execution: { name: string }) => execution.name === 'web_search' ? undefined : '聊天模式只允许网页搜索。')
}
