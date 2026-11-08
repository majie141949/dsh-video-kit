import { useEffect, useState } from 'react'
import type { KitConfig, ProviderConfig } from '../shared/constants'

const border = '1px solid color-mix(in srgb, currentColor 16%, transparent)'
const button = { border, borderRadius: 8, background: 'transparent', color: 'inherit', padding: '7px 12px', cursor: 'pointer' } as const
const input = { border, borderRadius: 8, background: 'transparent', color: 'inherit', padding: '8px 10px', width: '100%', boxSizing: 'border-box' } as const

type Draft = { name: string, baseUrl: string, model: string, token: string, authType: 'bearer' | 'apiKey', apiKeyHeader: string, submitPath: string, statusPath: string }
const emptyDraft = (): Draft => ({ name: '', baseUrl: '', model: '', token: '', authType: 'bearer', apiKeyHeader: 'x-api-key', submitPath: '', statusPath: '' })

export function VideoModels() {
  const [config, setConfig] = useState<KitConfig | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/video-kit/config').then(async response => {
      if (!response.ok) throw new Error('无法读取视频模型，请确认视频插件已启用')
      const result = await response.json()
      if (!result.ok || !result.config) throw new Error(result.error || '无法读取视频模型')
      if (active) setConfig(result.config)
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)) })
    return () => { active = false }
  }, [])

  async function update(next: KitConfig) {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/video-kit/config', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next),
      })
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error || '保存失败')
      setConfig(result.config)
      setEditing(null)
      setDraft(emptyDraft())
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  function edit(name: string) {
    const entry = config?.providers[name]
    if (!entry) return
    setDraft({ name, baseUrl: entry.baseUrl || '', model: entry.model || '', token: '', authType: (entry as ProviderConfig & { hasApiKey?: boolean }).hasApiKey ? 'apiKey' : 'bearer', apiKeyHeader: entry.apiKeyHeader || 'x-api-key', submitPath: entry.submitPath || '', statusPath: entry.statusPath || '' })
    setEditing(name)
    setError('')
  }

  function save() {
    if (!config) return
    const name = draft.name.trim()
    if (!name || !draft.baseUrl.trim() || !draft.model.trim()) { setError('请填写名称、API 地址和模型 ID'); return }
    if (editing === '' && config.providers[name]) { setError('该名称已存在，请使用其他名称'); return }
    try {
      const url = new URL(draft.baseUrl.trim())
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    }
    catch { setError('API 地址必须以 http:// 或 https:// 开头'); return }
    const previous = config.providers[name]
    const oldAuth = (previous as ProviderConfig & { hasApiKey?: boolean } | undefined)?.hasApiKey ? 'apiKey' : 'bearer'
    if (editing && oldAuth !== draft.authType && !draft.token) { setError('切换认证方式时请重新填写密钥'); return }
    const entry = { ...previous, kind: 'http' as const, baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), submitPath: draft.submitPath.trim() || undefined, statusPath: draft.statusPath.trim() || undefined, apiKeyHeader: draft.apiKeyHeader.trim() || 'x-api-key', ...(draft.token ? draft.authType === 'apiKey' ? { apiKey: draft.token, token: null } : { token: draft.token, apiKey: null } : {}) }
    void update({ ...config, providers: { ...config.providers, [name]: entry } })
  }

  function remove(name: string) {
    if (!config || !window.confirm(`删除视频模型“${name}”？`)) return
    const providers = { ...config.providers }
    delete providers[name]
    void update({ ...config, defaultProvider: config.defaultProvider === name ? '' : config.defaultProvider, providers })
  }

  const entries = (Object.entries(config?.providers ?? {}) as [string, ProviderConfig][]).filter(([, item]) => item.kind === 'http')
  return <section style={{ display: 'grid', gap: 10, marginTop: 16 }}>
    <h3 style={{ margin: 0, fontSize: 15 }}>视频模型</h3>
    {entries.map(([name, item]) => <div key={name} style={{ border, borderRadius: 14, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ flex: 1 }}>{name} <span style={{ opacity: 0.55, fontSize: 12 }}>视频 · {item.model || '未填写模型 ID'}</span></span>
      <button type="button" style={button} disabled={busy} onClick={() => edit(name)}>编辑</button>
      <button type="button" style={{ ...button, color: '#dc2626' }} disabled={busy} onClick={() => remove(name)}>删除</button>
    </div>)}
    {editing !== null && <div style={{ border, borderRadius: 14, padding: 16, display: 'grid', gap: 10 }}>
      <strong>{editing ? '编辑视频模型' : '添加视频模型'}</strong>
      <label>名称<input style={input} value={draft.name} disabled={editing !== '' || busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>API 地址<input style={input} value={draft.baseUrl} disabled={busy} placeholder="https://example.com" onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
      <label>模型 ID<input style={input} value={draft.model} disabled={busy} onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
      <label>认证方式<select style={input} value={draft.authType} disabled={busy} onChange={event => setDraft({ ...draft, authType: event.target.value as Draft['authType'] })}><option value="bearer">Bearer Token</option><option value="apiKey">API Key 请求头</option></select></label>
      {draft.authType === 'apiKey' && <label>API Key 请求头名称<input style={input} value={draft.apiKeyHeader} disabled={busy} onChange={event => setDraft({ ...draft, apiKeyHeader: event.target.value })} /></label>}
      <label>API 密钥<input style={input} type="password" value={draft.token} disabled={busy} placeholder={editing ? '留空保留原密钥' : '输入 API 密钥'} onChange={event => setDraft({ ...draft, token: event.target.value })} /></label>
      <label>提交路径<input style={input} value={draft.submitPath} disabled={busy} placeholder="/v1/videos" onChange={event => setDraft({ ...draft, submitPath: event.target.value })} /></label>
      <label>状态查询路径<input style={input} value={draft.statusPath} disabled={busy} placeholder="/v1/videos/{id}" onChange={event => setDraft({ ...draft, statusPath: event.target.value })} /></label>
      <span style={{ fontSize: 12, opacity: 0.65 }}>支持与 /v1/videos 兼容的异步视频接口，保存后可在视频页面选择。</span>
      <div style={{ display: 'flex', gap: 8 }}><button type="button" style={button} disabled={busy} onClick={save}>保存</button><button type="button" style={button} disabled={busy} onClick={() => setEditing(null)}>取消</button></div>
    </div>}
    {error && <div role="alert" style={{ color: '#dc2626', fontSize: 12 }}>{error}</div>}
    <button type="button" style={{ ...button, borderStyle: 'dashed', padding: 12 }} disabled={!config || busy} onClick={() => { setEditing(''); setDraft(emptyDraft()); setError('') }}>＋ 添加视频模型</button>
  </section>
}
