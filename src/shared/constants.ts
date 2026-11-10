export const PACKAGE_NAME = '@majie141949/dsh-video-kit'
export const PLUGIN_ID = 'dsh-video-kit'
export const ROUTE_PREFIX = '/api/video-kit'
export const PANEL_ID = 'dsh-video-kit'

export const TOOL_NAMES = {
  generate: 'video_generate',
  status: 'video_status',
  list: 'video_list',
  cancel: 'video_cancel',
} as const

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type JobSource = 'agent' | 'panel' | 'imported'

export interface VideoJob {
  id: string
  prompt: string
  promptVerbatim?: boolean
  provider: string
  source?: JobSource
  favorite?: boolean
  model?: string
  negativePrompt?: string
  status: JobStatus
  progress: number
  stage?: string
  durationSec: number
  aspect: string
  resolution?: string
  width?: number
  height?: number
  actualWidth?: number
  actualHeight?: number
  requestedWidth?: number
  requestedHeight?: number
  actualFps?: number
  frames?: number
  fps?: number
  steps?: number
  seed?: number
  initImage?: string
  submission?: {
    prompt: string
    voice_text: string
    model?: string
    width?: number
    height?: number
    duration?: number
    fps?: number
    steps?: number
    seed?: number
    initImageLength: number
    initImageSha256?: string
    voiceInferred?: boolean
  }
  fileName?: string
  remoteUrl?: string
  remoteId?: string
  error?: string
  startedAt?: number
  completedAt?: number
  generationElapsedMs?: number
  filePath?: string
  fileSize?: number
  fileCreatedAt?: number
  actualDurationSec?: number
  codec?: string
  bitrate?: number
  container?: string
  thumbnailPath?: string
  displayName?: string
  fileMissing?: boolean
  createdAt: number
  updatedAt: number
}

export interface ProviderConfig {
  kind: 'http'
  baseUrl?: string
  token?: string | null
  apiKey?: string | null
  apiKeyHeader?: string
  model?: string
  submitPath?: string
  statusPath?: string
  modelsPath?: string
  pollIntervalMs?: number
}

export interface KitConfig {
  defaultProvider: string
  providers: Record<string, ProviderConfig>
}

export const DEFAULT_CONFIG: KitConfig = {
  defaultProvider: '',
  providers: {},
}
