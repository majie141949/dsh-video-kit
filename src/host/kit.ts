import { createWriteStream } from 'node:fs'
import { readdir, stat, realpath, unlink, rename as renameFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CONFIG_FILE, IGNORED_IMPORTS_FILE, JOBS_FILE, THUMB_DIR, VIDEO_DIR, ensureDirs, readJson, writeJsonAtomic } from './storage'
import { DEFAULT_CONFIG, type JobStatus, type JobSource, type KitConfig, type ProviderConfig, type VideoJob } from '../shared/constants'

const POLL_TIMEOUT_MS = 45 * 60 * 1000
const DEFAULT_POLL_MS = 2000

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function probe(file: string): Promise<Record<string, any> | undefined> {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size,bit_rate,format_name:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file], { stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.on('error', () => resolve(undefined))
    child.on('close', code => {
      if (code !== 0) return resolve(undefined)
      try { resolve(JSON.parse(output)) }
      catch { resolve(undefined) }
    })
  })
}

function rate(value: string | undefined): number | undefined {
  if (!value) return undefined
  const [a, b] = value.split('/').map(Number)
  const result = b ? a / b : a
  return Number.isFinite(result) ? result : undefined
}

function thumbnail(source: string, target: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn('ffmpeg', ['-loglevel', 'error', '-ss', '1', '-i', source, '-frames:v', '1', '-q:v', '4', '-y', target], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

const TERMINAL_OK = new Set(['succeeded', 'success', 'completed', 'complete', 'done', 'finished'])
const TERMINAL_FAIL = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled'])

function normalizeStatus(raw: unknown): 'pending' | 'running' | 'succeeded' | 'failed' {
  const value = String(raw ?? '').toLowerCase()
  if (TERMINAL_OK.has(value)) return 'succeeded'
  if (TERMINAL_FAIL.has(value)) return 'failed'
  if (value === 'queued' || value === 'pending' || value === 'waiting') return 'pending'
  return 'running'
}

function normalizeProgress(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value > 0 && value <= 1 ? value * 100 : value))
}

function isCancelled(job: VideoJob): boolean {
  return job.status === 'cancelled'
}

function isSucceeded(job: VideoJob): boolean {
  return job.status === 'succeeded'
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '')
}

function withId(template: string, id: string): string {
  return template.includes('{id}') ? template.replaceAll('{id}', id) : `${trimBase(template)}/${id}`
}

const SIZES: Record<string, [number, number]> = {
  '16:9': [854, 480],
  '9:16': [480, 854],
  '1:1': [640, 640],
}

function sizeFor(aspect: string, resolution?: string): [number, number] {
  const [width, height] = SIZES[aspect] ?? SIZES['16:9']
  if (resolution === '720P') return aspect === '9:16' ? [720, 1280] : aspect === '1:1' ? [960, 960] : [1280, 720]
  if (resolution === '1080P') return aspect === '9:16' ? [1080, 1920] : aspect === '1:1' ? [1440, 1440] : [1920, 1080]
  return [width, height]
}

function authHeaders(config: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {}
  if (config.apiKey) headers[(config.apiKeyHeader || 'x-api-key').toLowerCase()] = config.apiKey
  if (config.token) headers.authorization = `Bearer ${config.token}`
  return headers
}

interface GenerateInput {
  source?: JobSource
  prompt: string
  provider?: string
  model?: string
  negativePrompt?: string
  durationSec?: number
  aspect?: string
  resolution?: string
  width?: number
  height?: number
  frames?: number
  fps?: number
  steps?: number
  seed?: number
  initImage?: string
}

export class Kit {
  jobs = new Map<string, VideoJob>()
  config: KitConfig = structuredClone(DEFAULT_CONFIG)
  private writes: Promise<void> = Promise.resolve()
  private ignoredImports = new Set<string>()
  private controllers = new Map<string, AbortController>()
  private importCandidates = new Map<string, { size: number, modifiedAt: number, firstSeenAt: number }>()
  private lastImportScanAt = 0

  async init(): Promise<void> {
    await ensureDirs()
    const [jobs, config] = await Promise.all([
      readJson<VideoJob[]>(JOBS_FILE, []),
      readJson<KitConfig>(CONFIG_FILE, DEFAULT_CONFIG),
    ])
    this.ignoredImports = new Set(await readJson<string[]>(IGNORED_IMPORTS_FILE, []))
    this.config = this.mergeConfig(config)
    for (const job of Array.isArray(jobs) ? jobs : []) {
      if (!job?.id) continue
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'failed'
        job.error = '宿主已重启，任务中断'
        job.completedAt = Date.now()
        job.generationElapsedMs = job.startedAt ? job.completedAt - job.startedAt : undefined
        job.updatedAt = Date.now()
      }
      this.jobs.set(job.id, job)
      if (job.fileName && basename(job.fileName) === job.fileName) {
        const file = join(VIDEO_DIR, job.fileName)
        void stat(file).then(async info => {
          job.filePath = file
          job.fileSize = info.size
          job.fileMissing = false
          if (job.actualDurationSec === undefined || job.actualWidth === undefined || job.actualHeight === undefined || job.codec === undefined) await this.updateMedia(job, file)
          const thumb = join(THUMB_DIR, `${job.id}.jpg`)
          if (!await stat(thumb).catch(() => undefined) && await thumbnail(file, thumb)) job.thumbnailPath = thumb
          this.save()
        }).catch(() => { job.fileMissing = true; this.save() })
      }
    }
    await this.importFiles()
    await this.save()
  }

  private mergeConfig(config: Partial<KitConfig> | undefined): KitConfig {
    const providers = Object.fromEntries(Object.entries(config?.providers ?? {}).filter(([, provider]) => provider.kind === 'http'))
    const defaultProvider = config?.defaultProvider && providers[config.defaultProvider] ? config.defaultProvider : Object.keys(providers)[0] || ''
    return { defaultProvider, providers }
  }

  async updateConfig(patch: Partial<KitConfig>): Promise<KitConfig> {
    const config = this.mergeConfig({ ...this.config, ...patch })
    await writeJsonAtomic(CONFIG_FILE, config)
    this.config = config
    return config
  }

  list(): VideoJob[] {
    return [...this.jobs.values()].filter(job => job.provider !== 'mock').sort((a, b) => b.createdAt - a.createdAt)
  }

  async listModels(name?: string): Promise<unknown[]> {
    const providerName = name || this.config.defaultProvider
    const provider = this.config.providers[providerName]
    if (!provider || provider.kind !== 'http' || !provider.baseUrl) return []
    const payload = await this.requestJson(`${trimBase(provider.baseUrl)}${provider.modelsPath || '/v1/models'}`, {
      method: 'GET',
      headers: authHeaders(provider),
    })
    const raw = Array.isArray(payload) ? payload : payload.models ?? payload.data ?? payload.items ?? []
    const list = Array.isArray(raw) ? raw : Object.keys(raw ?? {})
    return list.map((item: any) => (typeof item === 'string' ? { id: item } : item))
  }

  get(id: string): VideoJob | undefined {
    return this.jobs.get(id)
  }

  async importFiles(force = false): Promise<boolean> {
    const now = Date.now()
    if (!force && now - this.lastImportScanAt < 3000) return false
    this.lastImportScanAt = now
    let changed = false
    const seen = new Set<string>()
    const known = new Set((await Promise.all([...this.jobs.values()].map(async job => job.fileName ? realpath(join(VIDEO_DIR, job.fileName)).catch(() => join(VIDEO_DIR, job.fileName as string)) : undefined))).filter(Boolean))
    for (const name of await readdir(VIDEO_DIR)) {
      if (!/\.(mp4|mov|webm|m4v)$/i.test(name)) continue
      const file = join(VIDEO_DIR, name)
      const canonical = await realpath(file).catch(() => file)
      if (this.ignoredImports.has(canonical)) continue
      if (known.has(canonical)) continue
      const info = await stat(file)
      if (!info.isFile() || info.size <= 0) continue
      seen.add(canonical)
      const candidate = this.importCandidates.get(canonical)
      if (!candidate || candidate.size !== info.size || candidate.modifiedAt !== info.mtimeMs) {
        this.importCandidates.set(canonical, { size: info.size, modifiedAt: info.mtimeMs, firstSeenAt: now })
        continue
      }
      if (now - candidate.firstSeenAt < 1000) continue
      const id = randomUUID()
      if (this.jobs.has(id)) continue
      changed = true
      this.jobs.set(id, {
        id, prompt: '', provider: '', source: 'imported', status: 'succeeded', progress: 100,
        stage: '已导入', durationSec: 0, aspect: '', fileName: name,
        filePath: file, fileSize: info.size, fileCreatedAt: info.birthtimeMs,
        createdAt: info.birthtimeMs || info.mtimeMs, updatedAt: info.mtimeMs,
      })
      known.add(canonical)
      const job = this.jobs.get(id) as VideoJob
      void this.updateMedia(job, file).then(async () => {
        const thumb = join(THUMB_DIR, `${id}.jpg`)
        if (await thumbnail(file, thumb)) job.thumbnailPath = thumb
        this.save()
      })
    }
    for (const path of this.importCandidates.keys()) if (!seen.has(path)) this.importCandidates.delete(path)
    return changed
  }

  save(): Promise<void> {
    const snapshot = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
    this.writes = this.writes.then(() => writeJsonAtomic(JOBS_FILE, snapshot)).catch((error) => {
      console.warn('[video-kit] 保存任务失败:', error)
    })
    return this.writes
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return false
    this.controllers.get(id)?.abort()
    job.status = 'cancelled'
    job.stage = '已取消'
    job.completedAt = Date.now()
    job.generationElapsedMs = job.startedAt ? job.completedAt - job.startedAt : undefined
    job.updatedAt = Date.now()
    this.save()
    return true
  }

  async rename(id: string, displayName: string): Promise<VideoJob | undefined> {
    const job = this.jobs.get(id)
    if (!job) return undefined
    job.displayName = displayName.trim() || undefined
    job.updatedAt = Date.now()
    this.save()
    return job
  }

  async favorite(id: string, favorite: boolean): Promise<VideoJob | undefined> {
    const job = this.jobs.get(id)
    if (!job) return undefined
    job.favorite = favorite
    job.updatedAt = Date.now()
    await this.save()
    return job
  }

  async delete(id: string): Promise<boolean> {
    const job = this.jobs.get(id)
    if (!job || ['queued', 'running'].includes(job.status)) return false
    if (job.fileName) {
      if (basename(job.fileName) !== job.fileName) throw new Error('无效的视频文件名')
      await unlink(join(VIDEO_DIR, job.fileName)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    }
    this.jobs.delete(id)
    await unlink(join(THUMB_DIR, `${job.id}.jpg`)).catch(() => undefined)
    await this.save()
    return true
  }

  private async updateMedia(job: VideoJob, file: string): Promise<void> {
    const info = await stat(file).catch(() => undefined)
    if (!info) return
    const metadata = await probe(file)
    const video = metadata?.streams?.find((stream: any) => stream.codec_type === 'video')
    job.filePath = file
    job.fileMissing = false
    job.fileSize = info.size
    job.fileCreatedAt = info.birthtimeMs
    job.actualDurationSec = Number(metadata?.format?.duration) || undefined
    job.actualWidth = Number(video?.width) || undefined
    job.actualHeight = Number(video?.height) || undefined
    job.actualFps = rate(video?.r_frame_rate)
    job.codec = video?.codec_name
    job.bitrate = Number(metadata?.format?.bit_rate) || undefined
    job.container = metadata?.format?.format_name
    await this.save()
  }

  async generate(input: GenerateInput): Promise<VideoJob> {
    const prompt = input.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt 必须是非空的用户原文')
    const providerName = input.provider || this.config.defaultProvider
    const provider = this.config.providers[providerName]
    if (!provider) throw new Error(`未配置的视频服务: ${providerName}`)
    if (!provider.baseUrl) throw new Error(`视频服务 ${providerName} 缺少 baseUrl`)

    const now = Date.now()
    const aspect = input.aspect || '16:9'
    const resolution = input.resolution || '480P'
    const [width, height] = sizeFor(aspect, resolution)
    const job: VideoJob = {
      id: randomUUID(),
      prompt,
      promptVerbatim: true,
      provider: providerName,
      source: input.source || 'panel',
      model: provider.model,
      negativePrompt: input.negativePrompt,
      status: 'queued',
      progress: 0,
      stage: '排队中',
      durationSec: Math.max(1, Math.min(30, Number(input.durationSec) || 5)),
      aspect,
      resolution,
      requestedWidth: Number(input.width) || width,
      requestedHeight: Number(input.height) || height,
      frames: input.frames,
      fps: input.fps != null && Number.isFinite(Number(input.fps)) ? Number(input.fps) : 24,
      steps: input.steps != null && Number.isFinite(Number(input.steps)) ? Number(input.steps) : 20,
      seed: input.seed != null && Number.isFinite(Number(input.seed)) ? Number(input.seed) : -1,
      initImage: input.initImage,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    }
    this.jobs.set(job.id, job)
    await this.save()
    void this.run(job, provider)
    return job
  }

  private async run(job: VideoJob, provider: ProviderConfig): Promise<void> {
    job.status = 'running'
    job.stage = '启动中'
    job.updatedAt = Date.now()
    this.save()
    try {
      await this.runHttp(job, provider)
    }
    catch (error) {
      if (isCancelled(job)) return
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.stage = '失败'
    }
    finally {
      job.updatedAt = Date.now()
      job.completedAt = job.status === 'running' ? undefined : job.updatedAt
      job.generationElapsedMs = job.completedAt && job.startedAt ? job.completedAt - job.startedAt : undefined
      this.controllers.delete(job.id)
      if (isSucceeded(job)) job.progress = 100
      this.save()
    }
  }

  private async runHttp(job: VideoJob, provider: ProviderConfig): Promise<void> {
    const base = trimBase(provider.baseUrl as string)
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    const headers = { 'content-type': 'application/json', ...authHeaders(provider) }

    const requestBody = JSON.stringify({
      model: job.model || undefined,
      prompt: job.prompt,
      voice_text: '',
      negative_prompt: job.negativePrompt || undefined,
      width: job.requestedWidth,
      height: job.requestedHeight,
      duration: job.durationSec,
      frames: job.frames || undefined,
      fps: job.fps || undefined,
      steps: job.steps || undefined,
      seed: job.seed ?? undefined,
      init_image: job.initImage || undefined,
    })
    const submitted = await this.requestJson(`${base}${provider.submitPath || '/v1/videos'}`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: requestBody,
    })
    const { init_image, ...request } = JSON.parse(requestBody)
    job.submission = {
      ...request,
      initImageLength: typeof init_image === 'string' ? init_image.length : 0,
      initImageSha256: typeof init_image === 'string' ? createHash('sha256').update(Buffer.from(init_image, 'base64')).digest('hex') : undefined,
      voiceInferred: typeof (submitted.voice_inferred ?? submitted.data?.voice_inferred) === 'boolean' ? (submitted.voice_inferred ?? submitted.data?.voice_inferred) : undefined,
    }
    const remoteId = String(submitted.task_id ?? submitted.id ?? submitted.tid ?? submitted.data?.id ?? '')
    if (!remoteId) throw new Error(`视频服务未返回任务 id: ${JSON.stringify(submitted).slice(0, 200)}`)
    job.remoteId = remoteId
    job.stage = '已提交'
    job.progress = Math.max(job.progress, 5)
    this.save()

    const statusUrl = withId(`${base}${provider.statusPath || '/v1/videos/{id}'}`, remoteId)
    const interval = provider.pollIntervalMs && provider.pollIntervalMs > 0 ? provider.pollIntervalMs : DEFAULT_POLL_MS
    const deadline = Date.now() + POLL_TIMEOUT_MS

    while (Date.now() < deadline) {
      if (isCancelled(job)) return
      await sleep(interval)
      if (isCancelled(job)) return
      const payload = await this.requestJson(statusUrl, { method: 'GET', headers, signal: controller.signal })
      const body = payload.data && typeof payload.data === 'object' ? { ...payload, ...payload.data } : payload
      const status = normalizeStatus(body.status ?? body.state)
      job.progress = Math.max(job.progress, normalizeProgress(body.progress ?? body.percentage))
      job.stage = String(body.stage ?? body.message ?? job.stage ?? '')
      job.updatedAt = Date.now()
      this.save()
      if (status === 'failed') throw new Error(String(body.error ?? body.message ?? '视频服务返回失败'))
      if (status === 'succeeded') {
        const listed = [body.outputs, body.videos, body.result?.outputs, body.data?.outputs].find(Array.isArray) as unknown[] | undefined
        const outputs = (listed?.length ? listed : [body]).map((output: any) => String(output?.download_url ?? output?.video_url ?? output?.url ?? output?.file ?? ''))
        if (outputs.length === 1 && !outputs[0]) outputs[0] = `v1/videos/${remoteId}/file`
        const failures: string[] = []
        for (const [index, url] of outputs.entries()) {
          const outputJob = index === 0 ? job : { ...job, id: randomUUID(), fileName: undefined, filePath: undefined, thumbnailPath: undefined, fileSize: undefined, actualWidth: undefined, actualHeight: undefined, actualDurationSec: undefined, actualFps: undefined, codec: undefined, bitrate: undefined, container: undefined, status: 'running' as const, progress: job.progress, stage: '下载中' }
          if (index > 0) this.jobs.set(outputJob.id, outputJob)
          if (!url) {
            outputJob.status = 'failed'
            outputJob.error = '任务成功但未返回视频地址'
            failures.push(outputJob.error)
            continue
          }
          outputJob.remoteUrl = url
          const absolute = /^https?:\/\//i.test(url) ? url : `${base}/${url.replace(/^\/+/, '')}`
          const fileName = `${outputJob.id}.mp4`
          const destination = join(VIDEO_DIR, fileName)
          const partial = `${destination}.${randomUUID()}.part`
          try {
            await this.download(absolute, partial, controller.signal, headers)
            const downloaded = await stat(partial)
            if (!downloaded.size) throw new Error('下载的视频文件为空')
            await renameFile(partial, destination)
            outputJob.fileName = fileName
            await this.updateMedia(outputJob, destination)
            const thumb = join(THUMB_DIR, `${outputJob.id}.jpg`)
            if (await thumbnail(destination, thumb)) outputJob.thumbnailPath = thumb
            outputJob.status = 'succeeded'
            outputJob.stage = '完成'
            outputJob.progress = 100
            outputJob.completedAt = Date.now()
            outputJob.generationElapsedMs = outputJob.startedAt ? outputJob.completedAt - outputJob.startedAt : undefined
            outputJob.updatedAt = outputJob.completedAt
            this.save()
          }
          catch (error) {
            await unlink(partial).catch(() => undefined)
            outputJob.status = 'failed'
            outputJob.error = error instanceof Error ? error.message : String(error)
            outputJob.stage = '失败'
            failures.push(outputJob.error)
            this.save()
          }
        }
        if (!outputs.length || failures.length === outputs.length) throw new Error(failures.join('；') || '任务成功但未返回视频地址')
        return
      }
    }
    throw new Error('等待视频服务超时')
  }

  private async requestJson(url: string, init: RequestInit): Promise<any> {
    const response = await fetch(url, init)
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
    if (!text) return {}
    try {
      return JSON.parse(text)
    }
    catch {
      throw new Error(`视频服务返回了非 JSON 内容: ${text.slice(0, 200)}`)
    }
  }

  private async download(url: string, dest: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<void> {
    const { 'content-type': _omit, ...rest } = headers
    const response = await fetch(url, { signal, headers: rest })
    if (!response.ok || !response.body) throw new Error(`下载视频失败 HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(dest))
  }
}
