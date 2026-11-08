import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { ROUTE_PREFIX, type KitConfig } from '../shared/constants'
import { THUMB_DIR, VIDEO_DIR } from './storage'
import type { Kit } from './kit'

function publicConfig(config: KitConfig) {
  return {
    ...config,
    providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => {
      const { token, apiKey, ...rest } = provider
      return [name, { ...rest, hasToken: Boolean(token), hasApiKey: Boolean(apiKey) }]
    })),
  }
}

function sendJson(res: any, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readBody(req: any, limit = 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  }
  catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createHandler(kit: Kit) {
  return async function handleRequest(req: any, res: any): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(ROUTE_PREFIX)) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    const method = (req.method || 'GET').toUpperCase()
    try {
      if (method === 'GET' && route === '/health') {
        sendJson(res, 200, { ok: true, plugin: 'dsh-video-kit', defaultProvider: kit.config.defaultProvider })
        return
      }
      if (method === 'GET' && route === '/jobs') {
        if (await kit.importFiles()) await kit.save()
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 24))
        const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase()
        const status = url.searchParams.get('status') || 'all'
        const sort = url.searchParams.get('sort') || 'date'
        const filtered = kit.list().filter(job => (status === 'all' || (status === 'favorite' ? job.favorite : status === 'active' ? ['queued', 'running'].includes(job.status) : job.status === status)) && (!query || `${job.prompt} ${job.model} ${job.fileName} ${job.provider}`.toLocaleLowerCase().includes(query)))
        filtered.sort((a, b) => sort === 'model' ? (a.model || '').localeCompare(b.model || '') || b.createdAt - a.createdAt : sort === 'duration' ? (b.actualDurationSec || b.durationSec) - (a.actualDurationSec || a.durationSec) : b.createdAt - a.createdAt)
        const jobs = filtered.slice(offset, offset + limit).map(({ initImage, ...job }) => job)
        sendJson(res, 200, { ok: true, jobs, total: filtered.length, hasMore: offset + jobs.length < filtered.length })
        return
      }
      if (method === 'POST' && route === '/jobs') {
        const body = await readBody(req, 20 * 1024 * 1024)
        const job = await kit.generate(body)
        sendJson(res, 200, { ok: true, job })
        return
      }
      if (route.startsWith('/jobs/')) {
        const rest = decodeURIComponent(route.slice('/jobs/'.length))
        if (method === 'POST' && rest.endsWith('/cancel')) {
          const id = rest.slice(0, -'/cancel'.length)
          sendJson(res, 200, { ok: kit.cancel(id), job: kit.get(id) ?? null })
          return
        }
        if (method === 'GET') {
          const job = kit.get(rest)
          if (!job) {
            sendJson(res, 404, { ok: false, error: '任务不存在' })
            return
          }
          sendJson(res, 200, { ok: true, job })
          return
        }
        if (method === 'PATCH') {
          const id = rest
          const body = await readBody(req)
          const job = body.favorite === undefined
            ? await kit.rename(id, String(body.displayName ?? ''))
            : await kit.favorite(id, Boolean(body.favorite))
          sendJson(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: '任务不存在' })
          return
        }
        if (method === 'DELETE') {
          const removed = await kit.delete(rest)
          sendJson(res, removed ? 200 : 404, { ok: removed })
          return
        }
      }
      if (method === 'GET' && route === '/models') {
        const models = await kit.listModels(url.searchParams.get('provider') || undefined).catch(() => [])
        sendJson(res, 200, { ok: true, models })
        return
      }
      if (method === 'GET' && route === '/config') {
        sendJson(res, 200, { ok: true, config: publicConfig(kit.config) })
        return
      }
      if ((method === 'PUT' || method === 'POST') && route === '/config') {
        const body = await readBody(req)
        const providers = Object.fromEntries(Object.entries(body.providers ?? {}).map(([name, value]: [string, any]) => {
          const previous = kit.config.providers[name]
          return [name, { ...value, token: value.token === null ? undefined : value.token || previous?.token, apiKey: value.apiKey === null ? undefined : value.apiKey || previous?.apiKey }]
        }))
        sendJson(res, 200, { ok: true, config: publicConfig(await kit.updateConfig({ ...body, providers })) })
        return
      }
      if (method === 'POST' && route === '/open-folder') {
        const command = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
        spawn(command, [VIDEO_DIR], { detached: true, stdio: 'ignore' }).unref()
        sendJson(res, 200, { ok: true, dir: VIDEO_DIR })
        return
      }
      if (method === 'POST' && route === '/open-file-location') {
        const body = await readBody(req)
        const job = kit.get(String(body.id ?? ''))
        if (!job?.fileName) {
          sendJson(res, 404, { ok: false, error: '视频文件不存在' })
          return
        }
        if (basename(job.fileName) !== job.fileName) {
          sendJson(res, 400, { ok: false, error: '无效的视频文件名' })
          return
        }
        const file = join(VIDEO_DIR, job.fileName)
        if (!await stat(file).catch(() => undefined)) {
          sendJson(res, 404, { ok: false, error: '视频文件已被删除' })
          return
        }
        const command = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
        const args = process.platform === 'win32' ? ['/select,', file] : process.platform === 'darwin' ? ['-R', file] : [VIDEO_DIR]
        spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'GET' && route.startsWith('/thumbnail/')) {
        const id = decodeURIComponent(route.slice('/thumbnail/'.length))
        const path = kit.get(id)?.thumbnailPath
        const file = path === join(THUMB_DIR, `${id}.jpg`) ? path : undefined
        if (!file) {
          sendJson(res, 404, { ok: false, error: '封面不存在' })
          return
        }
        const info = await stat(file).catch(() => undefined)
        if (!info) {
          sendJson(res, 404, { ok: false, error: '封面不存在' })
          return
        }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': info.size, 'cache-control': 'public, max-age=31536000, immutable' })
        createReadStream(file).pipe(res)
        return
      }
      if (method === 'GET' && route.startsWith('/file/')) {
        const name = decodeURIComponent(route.slice('/file/'.length))
        const job = [...kit.jobs.values()].find(item => item.fileName === name || item.id === name.replace(/\.mp4$/, ''))
        if (!job?.fileName) {
          sendJson(res, 404, { ok: false, error: '视频文件不存在' })
          return
        }
        if (basename(job.fileName) !== job.fileName) {
          sendJson(res, 400, { ok: false, error: '无效的视频文件名' })
          return
        }
        const file = join(VIDEO_DIR, job.fileName)
        const info = await stat(file).catch(() => undefined)
        if (!info) {
          sendJson(res, 404, { ok: false, error: '视频文件已被删除' })
          return
        }
        const range = req.headers.range as string | undefined
        const type = ({ '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' } as Record<string, string>)[extname(job.fileName).toLowerCase()] || 'application/octet-stream'
        if (range) {
          const match = /bytes=(\d*)-(\d*)/.exec(range)
          const start = match?.[1] ? Number(match[1]) : 0
          const end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1
          if (start >= info.size || start > end) {
            res.writeHead(416, { 'content-range': `bytes */${info.size}` })
            res.end()
            return
          }
          res.writeHead(206, {
            'content-type': type,
            'content-length': end - start + 1,
            'content-range': `bytes ${start}-${end}/${info.size}`,
            'accept-ranges': 'bytes',
            'cache-control': 'public, max-age=31536000, immutable',
          })
          createReadStream(file, { start, end }).pipe(res)
          return
        }
        res.writeHead(200, {
          'content-type': type,
          'content-length': info.size,
          'accept-ranges': 'bytes',
          'cache-control': 'public, max-age=31536000, immutable',
        })
        createReadStream(file).pipe(res)
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    }
    catch (error) {
      sendJson(res, 500, { ok: false, error: errorMessage(error) })
    }
  }
}
