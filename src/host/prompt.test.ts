import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const original = '生成5秒视频，镜头拉远，女孩坐在车内撩一撩头发，回头看向镜头说：‘马杰，我爱你’'
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
const settings = { provider: 'test', durationSec: 5, aspect: '9:16', resolution: '480P', width: 480, height: 864, fps: 24, frames: 120, steps: 20, seed: 42, negativePrompt: '不要字幕', initImage: image }
let home: string
let kit: import('./kit').Kit
let tool: ReturnType<typeof import('./tools').createTools>[number]
let cloud: Server
let api: Server
let base: string
const received: { body: any, key: unknown }[] = []

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}`
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'video-prompt-'))
  vi.stubEnv('DSH_HOME', home)
  const { Kit } = await import('./kit')
  const { createHandler } = await import('./server')
  const { createTools } = await import('./tools')
  cloud = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received.push({ body: JSON.parse(Buffer.concat(chunks).toString()), key: req.headers['x-api-key'] })
    res.writeHead(422, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'request captured; generation intentionally disabled' }))
  })
  const cloudUrl = await listen(cloud)
  kit = new Kit()
  await kit.init()
  kit.config = { defaultProvider: 'test', providers: { test: { kind: 'http', baseUrl: cloudUrl, apiKey: 'isolated-test-key', model: 'minimax-h3-fl2va' } } }
  tool = createTools(kit)[0]
  api = createServer(createHandler(kit))
  base = await listen(api)
})

afterAll(async () => {
  await kit.save()
  await Promise.all([api, cloud].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

beforeEach(async () => {
  await vi.waitFor(() => expect(kit.list().every(job => job.status === 'failed')).toBe(true))
  await kit.save()
  kit.jobs.clear()
  received.length = 0
})

async function assertRequest(index: number, prompt: string) {
  await vi.waitFor(() => expect(received.length).toBe(index + 1))
  expect(received[index]).toEqual({ key: 'isolated-test-key', body: {
    model: 'minimax-h3-fl2va', prompt, voice_text: '', negative_prompt: '不要字幕', width: 480, height: 864,
    duration: 5, fps: 24, frames: 120, steps: 20, seed: 42, init_image: image,
  } })
  await vi.waitFor(() => expect(kit.list().every(job => job.status === 'failed')).toBe(true))
}

describe('final video HTTP request', () => {
  it.each([original, '她说：“马杰，我爱你”。', 'She says: "I love you, Ma Jie."', `她说：‘马杰，我爱你"。`, ' \n她回头说：\n“马杰，\n我爱你”\r\n\t '])('panel endpoint preserves every character: %j', async prompt => {
    const index = received.length
    const response = await fetch(`${base}/api/video-kit/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...settings, prompt }) })
    expect(response.status).toBe(200)
    await assertRequest(index, prompt)
  })

  it('Agent uses the selected human message even when model arguments contain a rewrite', async () => {
    const index = received.length
    const exec = { agent: { session: { snapshotEvents: () => [
      { type: 'user/message', data: { id: 'original', source: { kind: 'user' }, content: [{ type: 'text', text: original }, { type: 'image', image: {} }] } },
      { type: 'user/message', data: { id: 'confirmation', source: { kind: 'user' }, content: [{ type: 'text', text: '好，竖屏480P' }] } },
    ] } } }
    const result = await (tool.execute as any)({ ...settings, prompt: '微笑着开口说话', userMessageId: 'original' }, exec)
    expect(result.ok).toBe(true)
    await assertRequest(index, original)
  })

  it('Agent rejects a rewritten prompt without an identified original message', async () => {
    const index = received.length
    const result = await (tool.execute as any)({ ...settings, prompt: '微笑着开口说话' }, { agent: { session: { snapshotEvents: () => [{ type: 'user/message', data: { id: 'original', source: { kind: 'user' }, content: [{ type: 'text', text: original }] } }] } } })
    expect(result).toMatchObject({ ok: false, needsParameters: ['userMessageId'] })
    expect(received.length).toBe(index)
  })

  it('Agent matches the complete human input without a message ID', async () => {
    const index = received.length
    const result = await (tool.execute as any)({ ...settings, prompt: original }, { agent: { session: { snapshotEvents: () => [{ type: 'user/message', data: { id: 'original', source: { kind: 'user' }, content: [{ type: 'text', text: original }] } }] } } })
    expect(result.ok).toBe(true)
    await assertRequest(index, original)
  })

  it.each([undefined, { agent: { session: { snapshotEvents: () => [{ type: 'user/message', data: { id: 'robot', source: { kind: 'goal' }, content: [{ type: 'text', text: original }] } }] } } }])('Agent rejects absent human provenance: %j', async exec => {
    const result = await (tool.execute as any)({ ...settings, prompt: original }, exec)
    expect(result).toMatchObject({ ok: false, needsParameters: ['userMessageId'] })
    expect(kit.list()).toEqual([])
    expect(received).toEqual([])
  })

  it.each([' \n\t', undefined, 123])('empty or non-string prompt is rejected without an outbound request: %j', async prompt => {
    const response = await fetch(`${base}/api/video-kit/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...settings, prompt }) })
    expect((await response.json()).ok).toBe(false)
    expect(kit.list()).toEqual([])
    expect(received).toEqual([])
  })

  it('retry from saved failed job preserves original request after reload', async () => {
    const prompt = `\n${original}\n`
    let index = received.length
    const response = await fetch(`${base}/api/video-kit/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...settings, prompt }) })
    const { job } = await response.json()
    await assertRequest(index, prompt)
    await kit.save()
    const saved = JSON.parse(await readFile(join(home, 'storages/video-kit/jobs.json'), 'utf8')).find((item: any) => item.id === job.id)
    expect(saved.promptVerbatim).toBe(true)
    index = received.length
    await kit.generate({ ...saved, width: saved.requestedWidth, height: saved.requestedHeight })
    await assertRequest(index, prompt)
  })
})
