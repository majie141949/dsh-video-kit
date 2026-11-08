import { TOOL_NAMES, type VideoJob } from '../shared/constants'
import type { Kit } from './kit'

const textBlock = (text: string) => [{ type: 'text' as const, text }]

const jobSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    prompt: { type: 'string' },
    status: { type: 'string' },
    progress: { type: 'number' },
    stage: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    source: { type: 'string' },
    negativePrompt: { type: 'string' },
    durationSec: { type: 'number' },
    aspect: { type: 'string' },
    resolution: { type: 'string' },
    requestedWidth: { type: 'number' },
    requestedHeight: { type: 'number' },
    fps: { type: 'number' },
    steps: { type: 'number' },
    seed: { type: 'number' },
    frames: { type: 'number' },
    fileName: { type: 'string' },
    error: { type: 'string' },
  },
}

function jobView(job: VideoJob) {
  return {
    ...job,
    fileUrl: job.fileName ? `/api/video-kit/file/${job.fileName}` : undefined,
  }
}

function generateTool(kit: Kit) {
  return {
    name: TOOL_NAMES.generate,
    description:
      'Generate a short video from the exact original user message, without rewriting, summarizing, translating, extracting dialogue, or trimming any characters. Submits the job to the configured video provider '
      + '(a local model server on the LAN or a cloud HTTP API) and returns immediately with a job id. '
      + 'Before generation, require the user to specify or explicitly accept defaults for aspect ratio, duration, and resolution. '
      + 'If any are missing, call this tool without filling them in; it returns needsParameters and must not create a task. Ask the user to confirm the listed video settings, then call again with the confirmed values. '
      + 'Mention that FPS defaults to 24, steps to 20, and seed to automatic unless the user wants to change them. '
      + 'Use video_status to poll progress and video_list to browse recent jobs. '
      + 'This is the only supported Agent video generation path: do not generate videos through another tool or API, because those requests cannot be linked to persistent video history. '
      + 'When the user asks for a video, call this instead of describing how to make one.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Copy the complete original user message verbatim, including dialogue, punctuation, quotes, whitespace and line breaks. Never optimize it. The local video API handles interpretation.' },
        userMessageId: { type: 'string', description: 'Optional original human message ID. Use this to select the original generation request after a parameter-confirmation turn. The host reads its text directly; model-written prompt cannot override it. If validation returns candidateMessages, select the relevant original message ID.' },
        provider: { type: 'string', description: 'Optional provider name from the plugin settings. Defaults to the configured default provider.' },
        durationSec: { type: 'number', description: 'User-confirmed clip length in seconds, 1-30.' },
        aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'User-confirmed aspect ratio.' },
        resolution: { type: 'string', enum: ['480P', '720P', '1080P'], description: 'User-confirmed output resolution tier.' },
        width: { type: 'number', description: 'Explicit output width, when specified.' },
        height: { type: 'number', description: 'Explicit output height, when specified.' },
        negativePrompt: { type: 'string', description: 'What to avoid in the video.' },
        steps: { type: 'number', description: 'Sampling steps. Defaults to the server default (20).' },
        seed: { type: 'number', description: 'Random seed; -1 for random.' },
        frames: { type: 'number', description: 'Frame count when using frame-based duration.' },
        fps: { type: 'number', description: 'Frame rate, default 24.' },
        initImage: { type: 'string', description: 'Base64 first-frame image for image-to-video.' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, needsParameters: { type: 'array', items: { type: 'string' } }, promptMessage: { type: 'string' }, job: jobSchema, error: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args: unknown, value: unknown) => textBlock(JSON.stringify(value)),
    },
    async execute(args: any, exec?: any) {
      try {
        const events = exec?.agent?.session?.snapshotEvents?.() ?? []
        const messages = events.filter((event: any) => event.type === 'user/message' && event.data.source?.kind === 'user')
          .map((event: any) => ({ id: event.data.id, prompt: event.data.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('') }))
        const original = messages.findLast((message: any) => args?.userMessageId ? message.id === args.userMessageId : message.prompt === args?.prompt)
        if (!original) return {
          ok: false,
          needsParameters: ['userMessageId'],
          error: '无法核对用户原文，本次未提交。请选择原始视频请求的 userMessageId，或逐字传入该条用户消息作为 prompt；不得改写、总结或提取台词。若无法确定原始消息，请用户补充。',
          candidateMessages: messages.slice(-5),
        }
        const needsParameters = [
          args?.aspect == null ? 'aspect' : undefined,
          args?.durationSec == null ? 'durationSec' : undefined,
          args?.resolution == null ? 'resolution' : undefined,
        ].filter(Boolean)
        if (needsParameters.length) {
          const labels: Record<string, string> = {
            aspect: '画面比例（横屏 16:9、竖屏 9:16、方形 1:1）',
            durationSec: '输出时长（1–30 秒）',
            resolution: '分辨率（480P、720P、1080P）',
          }
          return {
            ok: true,
            needsParameters,
            promptMessage: `开始生成前请询问用户补充${needsParameters.map((key: string) => labels[key]).join('、')}，或明确接受建议默认值（16:9、5 秒、480P）。帧率默认 24 FPS、步数默认 20、随机种子自动。请等待用户回复后再生成；本次没有创建任务。`,
          }
        }
        const job = await kit.generate({
          source: 'agent',
          prompt: original.prompt,
          provider: args?.provider ? String(args.provider) : undefined,
          durationSec: args?.durationSec,
          aspect: args?.aspect,
          resolution: args?.resolution,
          width: args?.width,
          height: args?.height,
          negativePrompt: args?.negativePrompt,
          steps: args?.steps,
          seed: args?.seed,
          frames: args?.frames,
          fps: args?.fps,
          initImage: args?.initImage,
        })
        return { ok: true, job: jobView(job), hint: '任务已提交，用 video_status 查询进度' }
      }
      catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function statusTool(kit: Kit) {
  return {
    name: TOOL_NAMES.status,
    description: 'Check one video generation job by id, including status, progress, stage and error.',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Job id returned by video_generate or video_list.' } },
      required: ['jobId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, job: jobSchema, error: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args: unknown, value: unknown) => textBlock(JSON.stringify(value)),
    },
    async execute(args: any) {
      const job = kit.get(String(args?.jobId ?? ''))
      if (!job) return { ok: false, error: '任务不存在' }
      return { ok: true, job: jobView(job) }
    },
  }
}

function listTool(kit: Kit) {
  return {
    name: TOOL_NAMES.list,
    description: 'List recent video generation jobs, newest first.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many jobs to return, default 10, max 50.' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, jobs: { type: 'array', items: jobSchema } },
        required: ['ok'],
      },
      render: (_args: unknown, value: unknown) => textBlock(JSON.stringify(value)),
    },
    async execute(args: any) {
      const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10))
      return { ok: true, jobs: kit.list().slice(0, limit).map(jobView) }
    },
  }
}

function cancelTool(kit: Kit) {
  return {
    name: TOOL_NAMES.cancel,
    description: 'Cancel a running video generation job.',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Job id to cancel.' } },
      required: ['jobId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, error: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args: unknown, value: unknown) => textBlock(JSON.stringify(value)),
    },
    async execute(args: any) {
      const id = String(args?.jobId ?? '')
      if (!kit.get(id)) return { ok: false, error: '任务不存在' }
      return { ok: kit.cancel(id) }
    },
  }
}

export function createTools(kit: Kit) {
  return [generateTool(kit), statusTool(kit), listTool(kit), cancelTool(kit)]
}
