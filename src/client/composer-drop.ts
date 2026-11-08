export function composerDragOver(event: DragEvent): void {
  if (!(event.target instanceof Element) || !event.target.closest('[data-composer-card]')) return
  const types = Array.from(event.dataTransfer?.types || [])
  if (types.some(type => ['Files', 'text/uri-list', 'text/html', 'text/plain'].includes(type))) event.preventDefault()
}

export function composerDrop(event: DragEvent): void {
  if (!(event.target instanceof Element)) return
  const card = event.target.closest('[data-composer-card]')
  const editor = card?.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
  const transfer = event.dataTransfer
  if (!editor || !transfer) return
  const image = Array.from(transfer.files).find(file => file.type.startsWith('image/'))
    || Array.from(transfer.items).find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile()
  const html = transfer.getData('text/html')
  const src = html ? new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src') : ''
  const uri = transfer.getData('text/uri-list').split(/\r?\n/).find(value => value && !value.startsWith('#'))
  const plain = transfer.getData('text/plain')
  const raw = src || uri || (plain.startsWith('blob:') || plain.startsWith('data:image/') ? plain : '')
  if (!image && !raw) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const attach = (file: File) => {
    if (!editor.isConnected) return
    const data = new DataTransfer()
    data.items.add(file)
    editor.focus()
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  }
  if (image) { attach(image); return }
  try {
    const url = new URL(raw!, location.href)
    if (!(url.origin === location.origin || url.protocol === 'blob:' || url.protocol === 'data:')) throw new Error('只能拖入本应用中的图片或本地图片文件')
    void fetch(url.href).then(response => {
      if (!response.ok) throw new Error('图片读取失败')
      return response.blob()
    }).then(blob => {
      if (!blob.type.startsWith('image/')) throw new Error('拖入的内容不是图片')
      attach(new File([blob], `对话图片.${blob.type.split('/')[1] || 'png'}`, { type: blob.type }))
    }).catch(error => alert(error instanceof Error ? error.message : '图片读取失败'))
  } catch (error) { alert(error instanceof Error ? error.message : '图片读取失败') }
}
