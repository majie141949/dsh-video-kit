import { PLUGIN_ID, ROUTE_PREFIX } from './shared/constants'
import { Kit } from './host/kit'
import { createHandler } from './host/server'
import { createTools } from './host/tools'

export const name = PLUGIN_ID

export const inject = ['tools', 'webServer', 'systemPrompt', 'agentPresets']

export async function apply(ctx: any): Promise<void> {
  const kit = new Kit()
  await kit.init()

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createHandler(kit) })
    return () => dispose()
  }, `${PLUGIN_ID}: routes`)

  ctx.systemPrompt.section({
    name: `${PLUGIN_ID}:agent-video-generation`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
    text: '视频生成必须统一调用 video_generate，由视频插件提交模型请求并持久化提示词、模型与全部请求参数。prompt 必须是用户原始消息全文，逐字保留台词、标点、引号、空白和换行；禁止先用大模型改写、优化、翻译或总结，禁止拆分画面与语音或提取 voice_text。视频 API 服务统一负责后续解析。参数确认后应选择最初视频请求的 userMessageId，不能把确认回复或改写描述当作原文。工具返回 candidateMessages 时选择对应原始消息，无法确定时询问用户。重试同样使用原始用户消息。不得绕过该工具通过终端、代码、HTTP 或其他工具直接生成视频，也不得把这种结果当作插件任务。参数缺失时先询问用户并等待确认；任务完成后再依据 video_status 的真实状态回复。',
  })

  for (const tool of createTools(kit)) ctx.tools.register(tool)

  const disposeChat = await ctx.agentPresets.register({
    id: 'chat',
    name: '聊天模式',
    description: '日常对话；需要时搜索网页。',
    order: 0,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '你是一个友善、准确的对话助手。根据用户的问题自然回答；需要最新信息时可以搜索网页并引用来源。', complete: true, includeRuntimeContext: false } },
      { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { search: true, fetch: false, searchTimeoutMs: 60000 } },
      { id: 'tool-presentation', name: '@deepseek-ai/dsh-agent-tool-presentation', config: { mode: 'native' } },
      { id: 'chat-policy', name: 'dsh-video-kit/chat-policy' },
    ],
  })
  ctx.effect(() => () => disposeChat(), `${PLUGIN_ID}: chat preset`)
}
