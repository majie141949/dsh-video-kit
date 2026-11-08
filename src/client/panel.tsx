import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, ReactNode } from 'react'
import type { VideoJob, KitConfig, ProviderConfig } from '../shared/constants'

const ACCENT = '#b5562d'
const BORDER = 'color-mix(in srgb, currentColor 14%, transparent)'
const MUTED = 'color-mix(in srgb, currentColor 55%, transparent)'
const FAINT = 'color-mix(in srgb, currentColor 38%, transparent)'
const CARD = 'color-mix(in srgb, currentColor 3%, transparent)'
const statusText: Record<string, string> = { queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败', cancelled: '已取消' }
const statusColor: Record<string, string> = { queued: '#8c929d', running: '#3778d3', succeeded: '#3a9b63', failed: '#d34a42', cancelled: '#8c929d' }
const button = { padding: '7px 11px', borderRadius: 8, border: `1px solid ${BORDER}`, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' } as const
const field = { width: '100%', boxSizing: 'border-box' as const, padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, background: 'color-mix(in srgb, currentColor 4%, transparent)', color: 'inherit', font: 'inherit', fontSize: 12, outline: 'none' }

function fileUrl(job: VideoJob) { return job.fileName ? `/api/video-kit/file/${encodeURIComponent(job.fileName)}` : undefined }
function date(value?: number) { return value ? new Date(value).toLocaleString() : '未知' }
function bytes(value?: number) { return value ? `${(value / 1024 / 1024).toFixed(2)} MB` : '未知' }
function copy(value: string) { void navigator.clipboard?.writeText(value) }

function Fold({ title, open, onToggle, children }: { title: string, open: boolean, onToggle: () => void, children: ReactNode }) {
  return <div><button type="button" onClick={onToggle} style={{ ...button, border: 0, padding: 0, color: MUTED }}>▸ {open ? '收起' : '展开'}{title}</button>{open && <div style={{ marginTop: 9 }}>{children}</div>}</div>
}

function Details({ job, onBack, onRename, onFavorite, onDelete, onRegenerate }: { job: VideoJob, onBack: () => void, onRename: (name: string) => void, onFavorite: (favorite: boolean) => void, onDelete: () => void, onRegenerate: () => void }) {
  const [promptOpen, setPromptOpen] = useState(false)
  const [editName, setEditName] = useState(false)
  const [name, setName] = useState(job.displayName || job.fileName || '未命名视频')
  const url = fileUrl(job)
  const requested = { provider: job.provider, model: job.model, prompt: job.prompt, negativePrompt: job.negativePrompt, durationSec: job.durationSec, aspect: job.aspect, resolution: job.resolution, width: job.requestedWidth, height: job.requestedHeight, frames: job.frames, fps: job.fps, steps: job.steps, seed: job.seed, initImage: job.initImage }
  const action = (label: string, run: () => void) => <button type="button" style={button} onClick={run}>{label}</button>
  return <div className="vk-detail">
    <header className="vk-detail-head"><button type="button" style={button} onClick={onBack}>← 返回</button><strong>{job.displayName || job.fileName || '视频详情'}</strong><div className="vk-actions">{action(job.favorite ? '取消收藏' : '收藏', () => onFavorite(!job.favorite))}{action('打开文件位置', () => { void fetch('/api/video-kit/open-file-location', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id }) }) })}{action('复制参数', () => copy(JSON.stringify(requested, null, 2)))}{action('再次生成', onRegenerate)}{action('删除视频与记录', () => { if (confirm('确定删除这条记录及其本地视频文件？此操作无法撤销。')) onDelete() })}</div></header>
    <div className="vk-detail-grid"><section className="vk-player-column"><div className="vk-player">{url && !job.fileMissing ? <video src={url} controls loop preload="metadata" onError={event => { const video = event.currentTarget; video.hidden = true; video.parentElement?.classList.add('vk-file-missing') }} /> : <div className="vk-empty">{job.fileMissing || job.fileName ? '视频文件不存在或无法读取' : statusText[job.status]}</div>}</div><div className="vk-filmstrip">{job.thumbnailPath ? <img src={`/api/video-kit/thumbnail/${encodeURIComponent(job.id)}`} /> : <div className="vk-frame-empty">封面未生成</div>}<div style={{ color: MUTED, fontSize: 12 }}>本地封面不可用时显示默认画面</div></div></section>
      <aside className="vk-info"><section className="vk-info-section"><h3>基础信息</h3><div className="vk-info-line"><span>视频名称</span>{editName ? <><input style={field} value={name} onChange={event => setName(event.target.value)} /><button style={button} onClick={() => { onRename(name); setEditName(false) }}>保存</button></> : <><b>{job.displayName || job.fileName || '未命名视频'}</b><button style={button} onClick={() => setEditName(true)}>重命名</button></>}</div><p>来源：{job.source === 'agent' ? 'Agent 生成' : job.source === 'imported' || job.stage === '已导入' ? '本地文件导入' : '视频插件生成'}</p><p>状态：{statusText[job.status] || job.status}</p><p>模型：{job.model || '未记录'} · 服务：{job.provider || '未记录'}</p><p>创建：{date(job.createdAt)}</p><p>完成：{date(job.completedAt)}</p><p>耗时：{job.generationElapsedMs != null ? `${(job.generationElapsedMs / 1000).toFixed(1)} 秒` : '未记录'}</p></section>
      <section className="vk-info-section"><h3>实际输出参数</h3><p>时长：{job.actualDurationSec != null ? `${job.actualDurationSec.toFixed(2)} 秒` : '未知'} · 尺寸：{job.actualWidth && job.actualHeight ? `${job.actualWidth} × ${job.actualHeight}` : '未知'}</p><p>帧率：{job.actualFps != null ? `${job.actualFps} FPS` : '未知'} · 编码：{job.codec || '未知'}</p><p>封装：{job.container || '未知'} · 码率：{job.bitrate ? `${Math.round(job.bitrate / 1000)} kb/s` : '未知'}</p><p>文件大小：{bytes(job.fileSize)}</p><p>文件创建：{date(job.fileCreatedAt)}</p><p>方向：{job.actualWidth && job.actualHeight ? job.actualWidth === job.actualHeight ? '正方形' : job.actualWidth > job.actualHeight ? '横屏' : '竖屏' : '未知'}</p></section>
      <section className="vk-info-section"><h3>请求参数</h3>{(job.source === 'imported' || job.stage === '已导入') && <p>此视频由本地文件导入，未关联 Agent 生成任务；提示词和请求参数无法从视频文件还原。</p>}<p>请求时长：{job.durationSec ? `${job.durationSec} 秒` : '未记录'} · 请求尺寸：{job.resolution || '未记录'} {job.requestedWidth && job.requestedHeight ? `(${job.requestedWidth}×${job.requestedHeight})` : ''}</p><p>请求帧率：{job.fps ?? '未记录'} FPS · 帧数：{job.frames ?? '未记录'} · 步数：{job.steps ?? '未记录'} · 种子：{job.seed ?? '未记录'} · 首帧：{job.initImage ? '已提交' : '未记录'}</p><Fold title="完整提示词" open={promptOpen} onToggle={() => setPromptOpen(value => !value)}><div className="vk-prompt">{job.prompt || '未记录'}<button style={button} onClick={() => copy(job.prompt || '')}>复制</button></div><div className="vk-prompt">反向提示词：{job.negativePrompt || '未记录'}<button style={button} onClick={() => copy(job.negativePrompt || '')}>复制</button></div></Fold></section>
      <section className="vk-info-section"><h3>文件信息</h3><p>文件：{job.fileName || '不存在'}</p><p className="vk-path">路径：{job.filePath || '未记录'}</p><p>存在：{job.fileMissing ? '否，文件缺失' : job.fileName ? '是' : '否'}</p>{job.filePath && action('复制路径', () => copy(job.filePath || ''))}</section>
      {job.error && <section className="vk-info-section"><h3>失败原因</h3><p>{job.error}</p></section>}</aside></div></div>
}

export function VideoPanel() {
  const [jobs, setJobs] = useState<VideoJob[]>([])
  const [config, setConfig] = useState<KitConfig | null>(null)
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [provider, setProvider] = useState('')
  const [aspect, setAspect] = useState('16:9')
  const [steps, setSteps] = useState(20)
  const [seconds, setSeconds] = useState(5)
  const [frames, setFrames] = useState(81)
  const [fps, setFps] = useState(24)
  const [frameMode, setFrameMode] = useState(false)
  const [seed, setSeed] = useState(-1)
  const [resolution, setResolution] = useState('480P')
  const [requestedSize, setRequestedSize] = useState<{ width?: number, height?: number }>({})
  const [firstFrame, setFirstFrame] = useState('')
  const [firstFrameData, setFirstFrameData] = useState('')
  const [negativeOpen, setNegativeOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('date')
  const [view, setView] = useState('grid')
  const [detailId, setDetailId] = useState('')
  const [detailJob, setDetailJob] = useState<VideoJob | null>(null)
  const [total, setTotal] = useState(0)
  const [loadedCount, setLoadedCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const savedScroll = useRef(0)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const imageRead = useRef(0)

  async function load(reset = false) {
    try {
      const params = new URLSearchParams({ offset: '0', limit: '24', status: filter, q: query.trim(), sort })
      const [jr, cr] = await Promise.all([fetch(`/api/video-kit/jobs?${params}`).then(response => response.json()), fetch('/api/video-kit/config').then(response => response.json())])
      if (alive.current) {
        if (Array.isArray(jr.jobs)) setJobs(current => reset ? jr.jobs : [...jr.jobs, ...current.filter(job => !jr.jobs.some((fresh: VideoJob) => fresh.id === job.id))])
        if (Array.isArray(jr.jobs) && reset) setLoadedCount(jr.jobs.length)
        setTotal(Number(jr.total) || 0)
        if (cr.config) setConfig(cr.config)
      }
    } catch {}
  }
  async function loadMore() {
    const params = new URLSearchParams({ offset: String(loadedCount), limit: '24', status: filter, q: query.trim(), sort })
    const response = await fetch(`/api/video-kit/jobs?${params}`)
    const payload = await response.json()
    if (Array.isArray(payload.jobs)) setJobs(current => [...current, ...payload.jobs.filter((job: VideoJob) => !current.some(item => item.id === job.id))])
    if (Array.isArray(payload.jobs)) setLoadedCount(value => value + payload.jobs.length)
    setTotal(Number(payload.total) || 0)
  }
  useEffect(() => { alive.current = true; void load(true); const timer = setInterval(() => void load(), 2500); return () => { alive.current = false; clearInterval(timer) } }, [filter, query, sort])

  const visible = jobs
  const selected = detailJob?.id === detailId ? detailJob : jobs.find(job => job.id === detailId)
  useEffect(() => { if (!detailId && rootRef.current) rootRef.current.scrollTop = savedScroll.current }, [detailId])

  async function submit() {
    if (!prompt.trim() || busy) return
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/video-kit/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, negativePrompt: negative.trim() || undefined, provider: provider || undefined, durationSec: frameMode ? frames / Math.max(fps, 1) : seconds, aspect, steps, seed, resolution, ...requestedSize, fps, frames: frameMode ? frames : undefined, initImage: firstFrameData || undefined }) })
      const payload = await response.json(); if (!payload.ok) throw new Error(payload.error || '提交失败')
      await load(true)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }
  function setImage(file: File) {
    if (!file.type.startsWith('image/')) { setError('请选择图片文件。'); return }
    if (file.size > 14 * 1024 * 1024) { setError('图片不能超过 14 MB。'); return }
    const read = ++imageRead.current
    const reader = new FileReader()
    reader.onload = () => {
      if (read !== imageRead.current) return
      const result = String(reader.result || '')
      const data = result.split(',').at(-1) || ''
      if (!data) { setError('无法读取图片，请重新选择。'); return }
      setFirstFrame(file.name || '参考图片'); setFirstFrameData(data); setError('')
    }
    reader.onerror = () => { if (read === imageRead.current) setError('无法读取图片，请重新选择。') }
    reader.readAsDataURL(file)
  }
  function pickImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) setImage(file)
    event.target.value = ''
  }
  function imageFromTransfer(data: DataTransfer): File | undefined {
    return Array.from(data.files || []).find(file => file.type.startsWith('image/'))
      || Array.from(data.items || []).find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile() || undefined
  }
  function pasteImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = imageFromTransfer(event.clipboardData)
    if (file) { event.preventDefault(); setImage(file) }
  }
  function dropImage(event: DragEvent<HTMLElement>) {
    const data = event.dataTransfer
    const file = imageFromTransfer(data)
    if (file) { event.preventDefault(); setImage(file); return }
    const html = data.getData('text/html')
    const src = html ? new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src') : ''
    const uri = data.getData('text/uri-list').split(/\r?\n/).find(value => value && !value.startsWith('#'))
    const raw = src || uri
    if (!raw) return
    event.preventDefault()
    const read = ++imageRead.current
    try {
      const url = new URL(raw, location.href)
      if (!(url.origin === location.origin || url.protocol === 'blob:' || url.protocol === 'data:')) throw new Error('只能拖入当前应用中的图片或本地图片文件。')
      void fetch(url.href).then(response => {
        if (!response.ok) throw new Error('图片读取失败，请重试。')
        return response.blob()
      }).then(blob => {
        if (read !== imageRead.current) return
        if (!blob.type.startsWith('image/')) throw new Error('拖入的内容不是图片。')
        setImage(new File([blob], '对话图片', { type: blob.type }))
      }).catch(reason => { if (read === imageRead.current) setError(reason instanceof Error ? reason.message : '图片读取失败。') })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '图片地址无效。') }
  }
  async function removeJob(id: string) { const response = await fetch(`/api/video-kit/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (response.ok) { setDetailId(''); setDetailJob(null); await load(true) } }
  async function setFavorite(id: string, favorite: boolean) { const response = await fetch(`/api/video-kit/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorite }) }); if (response.ok) await load(true) }
  function regenerate(job: VideoJob) {
    setRequestedSize({ width: job.requestedWidth, height: job.requestedHeight }); setProvider(job.provider); setPrompt(job.promptVerbatim ? job.prompt : ''); setNegative(job.negativePrompt || ''); setSeconds(job.durationSec || 5); setAspect(job.aspect || '16:9'); setSteps(job.steps || 20); setSeed(job.seed ?? -1); setResolution(job.resolution || '480P'); setFrames(job.frames || 81); setFps(job.fps || 24); setFrameMode(Boolean(job.frames)); setFirstFrame(job.initImage ? '已保存的首帧参考图' : ''); setFirstFrameData(job.initImage || ''); setDetailId(''); setDetailJob(null)
    if (!job.promptVerbatim) setError('旧记录未保存可验证的用户原文，请重新填写原文后生成。图片及其他参数已回填。')
    else if (!config?.providers[job.provider]) setError(`原模型“${job.provider || job.model || '未知'}”已不可用，请选择模型后确认生成。`)
    else if (job.initImage) setError('已回填已保存的首帧数据，请确认后再生成。')
    else setError('已回填原参数，请检查后手动点击“生成”。')
  }
  async function openDetail(id: string) {
    savedScroll.current = rootRef.current?.scrollTop || 0
    setDetailId(id)
    setDetailJob(null)
    const response = await fetch(`/api/video-kit/jobs/${encodeURIComponent(id)}`)
    const payload = await response.json()
    if (payload.job) setDetailJob(payload.job)
  }

  return <div className="vk-root" ref={rootRef}><style>{`.vk-root{height:100%;min-height:0;display:flex;flex-direction:column;padding:18px 22px;box-sizing:border-box;gap:14px;overflow:auto}.vk-head,.vk-detail-head{display:flex;align-items:center;gap:10px;min-height:34px}.vk-title{font-size:19px;font-weight:650}.vk-actions{display:flex;gap:7px;margin-left:auto;flex-wrap:wrap}.vk-workspace{display:grid;grid-template-columns:minmax(280px,35fr) minmax(0,65fr);gap:14px;align-items:start}.vk-form,.vk-history,.vk-info{border:1px solid ${BORDER};border-radius:13px;background:${CARD};padding:14px;min-width:0}.vk-form{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;min-height:calc(100vh - 130px)}.vk-prompt-field{display:flex;flex:1;flex-direction:column}.vk-prompt-field textarea{flex:1}.vk-label{display:block;color:${MUTED};font-size:11px;margin-bottom:5px}.vk-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.vk-pill{padding:7px 11px;border-radius:8px;border:1px solid ${BORDER};background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}.vk-pill.active{border-color:${ACCENT};color:${ACCENT};background:color-mix(in srgb, ${ACCENT} 9%, transparent)}.vk-main-button{border:0;border-radius:9px;background:${ACCENT};color:white;padding:10px;font:inherit;font-weight:600;cursor:pointer}.vk-history{display:flex;flex-direction:column;gap:8px;padding:11px}.vk-toolbar{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.vk-toolbar input,.vk-toolbar select{font-size:10px!important;padding:5px 8px!important}.vk-toolbar .vk-tab{font-size:10px;padding:4px 7px;min-height:26px}.vk-count{font-size:12px;font-weight:650;margin-right:auto}.vk-tabs{display:flex;gap:5px}.vk-tab{${Object.entries(button).map(([k,v])=>`${k.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())}:${v}`).join(';')};padding:5px 9px}.vk-tab.active{background:${ACCENT};border-color:${ACCENT};color:white}.vk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(125px,1fr));gap:7px}.vk-list{display:flex;flex-direction:column;gap:7px}.vk-card{border:1px solid ${BORDER};border-radius:10px;overflow:hidden;background:color-mix(in srgb,currentColor 2%,transparent);cursor:pointer;min-width:0;transition:transform .15s ease,border-color .15s ease}.vk-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,${ACCENT} 60%,${BORDER})}.vk-thumb{height:78px;background:linear-gradient(140deg,#26282c,#3a3c40);display:flex;align-items:center;justify-content:center;color:#fff;position:relative}.vk-thumb video{width:100%;height:100%;object-fit:contain}.vk-duration{position:absolute;right:6px;top:6px;border-radius:5px;background:#000a;color:white;padding:2px 5px;font-size:10px}.vk-card-body{padding:6px}.vk-prompt-short{font-size:10px;line-height:1.45;height:31px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.vk-meta{font-size:9px;color:${MUTED};margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vk-status{font-size:10px;color:white;border-radius:5px;padding:2px 5px;background:#0008;position:absolute;left:6px;top:6px}.vk-progress{height:3px;background:${BORDER};margin-top:6px}.vk-progress>i{display:block;height:100%;background:${ACCENT}}.vk-list-row{display:grid;grid-template-columns:76px minmax(0,1fr) auto;gap:10px;align-items:center;padding:7px;border:1px solid ${BORDER};border-radius:9px;cursor:pointer}.vk-list-row .vk-thumb{height:50px;border-radius:6px}.vk-detail{height:100%;min-height:0;display:flex;flex-direction:column;gap:12px;overflow:auto}.vk-detail-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(290px,1fr);gap:14px;min-height:0;align-items:start}.vk-player-column{min-width:0}.vk-player{background:#000;border-radius:12px;min-height:260px;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;overflow:hidden}.vk-player video{width:100%;height:100%;object-fit:contain}.vk-empty{color:#ddd;font-size:13px}.vk-file-missing:after{content:'视频文件不存在或无法读取';color:#ddd;font-size:13px}.vk-filmstrip{display:flex;align-items:center;gap:9px;margin-top:10px}.vk-frame-empty{height:48px;width:66px;border-radius:6px;background:${CARD};display:grid;place-items:center;color:${FAINT};font-size:9px}.vk-filmstrip img{height:48px;width:66px;object-fit:cover;border-radius:6px}.vk-info{display:flex;flex-direction:column;gap:12px}.vk-info-section{border-bottom:1px solid ${BORDER};padding-bottom:10px;font-size:11px;overflow-wrap:anywhere}.vk-info-section:last-child{border:0}.vk-info-section h3{font-size:12px;margin:0 0 8px}.vk-info-section p{margin:5px 0;color:${MUTED}}.vk-info-line{display:flex;align-items:center;gap:7px}.vk-info-line>span{color:${MUTED};white-space:nowrap}.vk-info-line b{overflow:hidden;text-overflow:ellipsis}.vk-path{word-break:break-all}.vk-prompt{padding:8px;background:${CARD};border-radius:7px;white-space:pre-wrap;word-break:break-word;margin:7px 0}.vk-prompt button{float:right}.vk-empty-state{padding:38px 10px;text-align:center;color:${FAINT};font-size:12px}@media(max-width:850px){.vk-workspace{grid-template-columns:minmax(0,1fr)}.vk-detail-grid{grid-template-columns:minmax(0,1fr)}.vk-form{order:0;min-height:0}.vk-prompt-field{flex:none}.vk-history{order:1}}`}</style>
    {selected ? <Details job={selected} onBack={() => { setDetailId(''); setDetailJob(null) }} onRename={name => { void fetch(`/api/video-kit/jobs/${encodeURIComponent(selected.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: name }) }).then(() => load(true)) }} onFavorite={favorite => { void setFavorite(selected.id, favorite) }} onDelete={() => { void removeJob(selected.id) }} onRegenerate={() => regenerate(selected)} /> : <>
      <header className="vk-head"><div className="vk-title">生成视频</div><div className="vk-actions"><button type="button" style={button} onClick={() => { void fetch('/api/video-kit/open-folder', { method: 'POST' }) }}>打开作品文件夹</button></div></header>
      <div className="vk-workspace"><section className="vk-form" onDragOver={event => { if (Array.from(event.dataTransfer.types).some(type => ['Files', 'text/html', 'text/uri-list'].includes(type))) event.preventDefault() }} onDrop={dropImage}>
        <label><span className="vk-label">模型</span><select style={field} value={provider} onChange={event => setProvider(event.target.value)}><option value="">默认模型（{config?.defaultProvider || '未配置'}）</option>{(Object.entries(config?.providers ?? {}) as [string, ProviderConfig][]).map(([key, item]) => <option key={key} value={key}>{key} · {item.model || '未记录'}</option>)}</select></label>
        <label className="vk-prompt-field"><span className="vk-label">提示词</span><textarea style={{ ...field, resize: 'vertical', minHeight: 86, lineHeight: 1.5 }} value={prompt} onChange={event => setPrompt(event.target.value)} onPaste={pasteImage} placeholder="描述主体、动作、镜头和氛围" /></label>
        <Fold title="反向提示词" open={negativeOpen} onToggle={() => setNegativeOpen(!negativeOpen)}><textarea style={{ ...field, resize: 'vertical' }} rows={2} value={negative} onChange={event => setNegative(event.target.value)} /></Fold>
        <div><span className="vk-label">画面比例与分辨率</span><div style={{ display: 'flex', gap: 6 }}><button className={`vk-pill ${aspect === '16:9' ? 'active' : ''}`} onClick={() => { setAspect('16:9'); setRequestedSize({}) }}>横屏</button><button className={`vk-pill ${aspect === '9:16' ? 'active' : ''}`} onClick={() => { setAspect('9:16'); setRequestedSize({}) }}>竖屏</button><select style={{ ...field, width: 94 }} value={resolution} onChange={event => { setResolution(event.target.value); setRequestedSize({}) }}><option>480P</option><option>720P</option><option>1080P</option></select></div></div>
        <div className="vk-row"><label><span className="vk-label">时长</span><select style={field} value={frameMode ? 'frames' : seconds} onChange={event => event.target.value === 'frames' ? setFrameMode(true) : (setFrameMode(false), setSeconds(Number(event.target.value)))}><option value={3}>3 秒</option><option value={5}>5 秒</option><option value={8}>8 秒</option><option value={10}>10 秒</option><option value="frames">按帧数</option></select></label><label><span className="vk-label">步数</span><input style={field} type="number" min={1} max={200} value={steps} onChange={event => setSteps(Number(event.target.value))} /></label><label><span className="vk-label">种子</span><input style={field} type="number" value={seed} onChange={event => setSeed(Number(event.target.value))} /></label></div>
        {frameMode && <label><span className="vk-label">帧数</span><input style={field} type="number" value={frames} onChange={event => setFrames(Number(event.target.value))} /></label>}
        <div><span className="vk-label">首帧参考图（可拖拽或粘贴到提示词）</span><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><button type="button" style={button} onClick={() => fileInput.current?.click()}>选择图片</button>{firstFrame && <span style={{ fontSize: 11, color: MUTED }}>{firstFrame}</span>}<input ref={fileInput} type="file" accept="image/*" onChange={pickImage} hidden />{firstFrame && <button type="button" style={button} onClick={() => { imageRead.current++; setFirstFrame(''); setFirstFrameData('') }}>移除</button>}</div></div>
        <Fold title="高级设置" open={advancedOpen} onToggle={() => setAdvancedOpen(!advancedOpen)}><label><span className="vk-label">帧率（FPS）</span><input style={field} type="number" min={1} max={120} value={fps} onChange={event => setFps(Number(event.target.value) || 24)} /></label><div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>{frameMode ? `按 ${frames} 帧和 ${fps} FPS 提交，时长 ${((frames || 1) / Math.max(fps, 1)).toFixed(3)} 秒` : '帧率会随请求参数一并提交'}</div></Fold>
        {error && <div style={{ color: '#d34a42', fontSize: 11 }}>{error}</div>}<button className="vk-main-button" disabled={busy || !prompt.trim()} onClick={() => void submit()}>{busy ? '正在提交…' : '生成视频'}</button>
      </section><section className="vk-history"><div className="vk-toolbar"><strong className="vk-count">生成记录（{total}）</strong><div className="vk-tabs">{[['all', '全部'], ['favorite', '收藏'], ['active', '生成中'], ['succeeded', '成功'], ['failed', '失败']].map(([key, label]) => <button key={key} className={`vk-tab ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>{label}</button>)}</div></div>
        <div className="vk-toolbar"><input style={{ ...field, minWidth: 130, maxWidth: 240, flex: 1 }} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索提示词、模型或文件名" /><select style={{ ...field, width: 110 }} value={sort} onChange={event => setSort(event.target.value)}><option value="date">按时间</option><option value="model">按模型</option><option value="duration">按时长</option></select><button className={`vk-tab ${view === 'grid' ? 'active' : ''}`} onClick={() => setView('grid')}>网格</button><button className={`vk-tab ${view === 'list' ? 'active' : ''}`} onClick={() => setView('list')}>列表</button></div>
        {!visible.length ? <div className="vk-empty-state">暂无符合条件的视频记录</div> : <div className={view === 'grid' ? 'vk-grid' : 'vk-list'}>{visible.map(job => <article className={view === 'grid' ? 'vk-card' : 'vk-list-row'} key={job.id} onClick={() => void openDetail(job.id)}><div className="vk-thumb">{job.thumbnailPath ? <img src={`/api/video-kit/thumbnail/${encodeURIComponent(job.id)}`} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : job.fileName && !job.fileMissing ? <video src={fileUrl(job)} preload="none" muted /> : <span style={{ fontSize: 21 }}>{job.status === 'failed' ? '!' : '▶'}</span>}<span className="vk-status" style={{ background: statusColor[job.status] }}>{statusText[job.status] || job.status}</span>{job.actualDurationSec || job.durationSec ? <span className="vk-duration">{(job.actualDurationSec || job.durationSec).toFixed(0)}秒</span> : null}</div><div className="vk-card-body"><div className="vk-prompt-short">{job.prompt || job.error || '提示词未记录'}</div><div className="vk-meta">{job.model || '模型未知'} · {job.actualWidth && job.actualHeight ? `${job.actualWidth}×${job.actualHeight}` : job.resolution || '输出尺寸未知'}</div><div className="vk-meta">{date(job.createdAt)}</div>{['queued', 'running'].includes(job.status) && <div className="vk-progress"><i style={{ width: `${Math.min(100, job.progress)}%` }} /></div>}</div><div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end', padding: view === 'grid' ? '0 6px 6px' : 0 }}><button type="button" aria-label={job.favorite ? '取消收藏' : '收藏'} title={job.favorite ? '取消收藏' : '收藏'} style={{ ...button, padding: '3px 7px', fontSize: 10 }} onClick={event => { event.stopPropagation(); void setFavorite(job.id, !job.favorite) }}>{job.favorite ? '★ 已收藏' : '☆ 收藏'}</button><button type="button" aria-label="删除视频与记录" title="删除视频与记录" disabled={['queued', 'running'].includes(job.status)} style={{ ...button, padding: '3px 7px', fontSize: 10, color: '#c33', opacity: ['queued', 'running'].includes(job.status) ? 0.45 : 1 }} onClick={event => { event.stopPropagation(); if (confirm('确定删除这条记录及其本地视频文件？此操作无法撤销。')) void removeJob(job.id) }}>删除</button></div></article>)}</div>}
        {visible.length < total && <button type="button" style={{ ...button, alignSelf: 'center' }} onClick={() => void loadMore()}>加载更多（{visible.length}/{total}）</button>}
      </section></div>
    </>}
  </div>
}
