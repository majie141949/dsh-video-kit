import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VideoPanel } from './panel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('form submit and regenerate send unmodified text and reference image', async () => {
  const prompt = ' \n生成5秒视频，镜头拉远，女孩坐在车内撩一撩头发，回头看向镜头说：‘马杰，我爱你’\n '
  const requests: any[] = []
  const job = { id: 'saved', prompt, promptVerbatim: true, status: 'failed', provider: 'test', durationSec: 5, aspect: '9:16', resolution: '480P', requestedWidth: 480, requestedHeight: 864, fps: 24, steps: 20, seed: 42, initImage: 'aW1hZ2U=', createdAt: 1, updatedAt: 1 }
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      requests.push(JSON.parse(String(options.body)))
      return Response.json({ ok: true, job })
    }
    if (url.endsWith('/config')) return Response.json({ config: { defaultProvider: 'test', providers: { test: { kind: 'http', model: 'h3' } } } })
    if (url.endsWith('/jobs/saved')) return Response.json({ ok: true, job })
    return Response.json({ jobs: [job], total: 1 })
  }))
  render(<VideoPanel />)
  fireEvent.change(screen.getByPlaceholderText('描述主体、动作、镜头和氛围'), { target: { value: prompt } })
  fireEvent.click(screen.getByRole('button', { name: '生成视频' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0].prompt).toBe(prompt)
  fireEvent.click(await screen.findByText(prompt.trim(), { selector: '.vk-prompt-short' }))
  fireEvent.click(await screen.findByRole('button', { name: '再次生成' }))
  fireEvent.click(screen.getByRole('button', { name: '生成视频' }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]).toMatchObject({ prompt, width: 480, height: 864, provider: 'test', durationSec: 5, aspect: '9:16', resolution: '480P', fps: 24, steps: 20, seed: 42, initImage: 'aW1hZ2U=' })
  job.promptVerbatim = false
  fireEvent.click(await screen.findByText(prompt.trim(), { selector: '.vk-prompt-short' }))
  fireEvent.click(await screen.findByRole('button', { name: '再次生成' }))
  expect((screen.getByPlaceholderText('描述主体、动作、镜头和氛围') as HTMLTextAreaElement).value).toBe('')
  expect((screen.getByRole('button', { name: '生成视频' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('旧记录未保存可验证的用户原文，请重新填写原文后生成。图片及其他参数已回填。')).not.toBeNull()
  expect(requests).toHaveLength(2)
})

it('accepts a dragged image as the first frame and submits its bytes', async () => {
  const requests: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') { requests.push(JSON.parse(String(options.body))); return Response.json({ ok: true }) }
    if (url.endsWith('/config')) return Response.json({ config: { defaultProvider: 'test', providers: {} } })
    return Response.json({ jobs: [], total: 0 })
  }))
  render(<VideoPanel />)
  const textarea = screen.getByPlaceholderText('描述主体、动作、镜头和氛围')
  fireEvent.change(textarea, { target: { value: '让图片动起来' } })
  const file = new File(['image bytes'], 'reference.png', { type: 'image/png' })
  fireEvent.drop(textarea, { dataTransfer: { files: [file], items: [{ kind: 'file', type: file.type, getAsFile: () => file }], getData: () => '' } })
  await screen.findByText('reference.png')
  fireEvent.click(screen.getByRole('button', { name: '生成视频' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ prompt: '让图片动起来', initImage: 'aW1hZ2UgYnl0ZXM=' })
})

it('pastes an image without changing the prompt', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ jobs: [], total: 0 })))
  render(<VideoPanel />)
  const textarea = screen.getByPlaceholderText('描述主体、动作、镜头和氛围')
  fireEvent.change(textarea, { target: { value: '原始提示词' } })
  const file = new File(['image bytes'], 'paste.png', { type: 'image/png' })
  fireEvent.paste(textarea, { clipboardData: { files: [file], items: [{ kind: 'file', type: file.type, getAsFile: () => file }], getData: () => '' } })
  await screen.findByText('paste.png')
  expect((textarea as HTMLTextAreaElement).value).toBe('原始提示词')
})
